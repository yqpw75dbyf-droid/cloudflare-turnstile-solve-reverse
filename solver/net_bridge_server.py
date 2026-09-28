"""
net_bridge_server.py — Turnstile solver server, ONE port (default 5091): task API + network bridge.
usage: python net_bridge_server.py [port]

Task API (public):
  GET /turnstile?url=&sitekey=  → {errorId:0, taskId}
  GET /result?id=               → {status:'processing'} | {errorId:0, status:'ready', solution:{token}} | {errorId:1, errorDescription}
  Tasks go to ONE long-lived `node cf_host.js` (reused worker_threads), which calls back into /reset + /req
  on this same port. Unlimited tasks accepted; CF_WORKERS solve at once (default = CPU threads), rest queue FIFO.
  CF_IDLE_MS: idle worker lifetime (default 60000).

Bridge (loopback only):
  POST /req    — JSON {method, url, headers, body(base64), impersonate, proxy} → curl_cffi Session (Chrome TLS/H2)
                 cookies persist in a single Session (cf_chl_* survive between XHR calls)
  POST /reset  — replace the session (new solve attempt with fresh cookies)
GET /ping — health check
"""

import asyncio
import base64
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
import warnings
from flask import Flask, request, jsonify
from curl_cffi.requests import AsyncSession, ExtraFingerprints

# suppress curl_cffi SSL verify=False warnings
warnings.filterwarnings("ignore")

# mặc định chỉ log token thành công/fail; CF_DEBUG=1 để bật log từng request
DEBUG = bool(os.environ.get("CF_DEBUG"))
if not DEBUG:
    logging.getLogger("werkzeug").setLevel(logging.ERROR)  # tắt access log "POST /req 200"

app = Flask(__name__)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36"
)
DEFAULT_IMP = "chrome146"   # profile curl_cffi mới nhất gần Chrome 153 nhất
# Chrome 153 vs chrome146: cipher list giống nhau (15 ciphers), 1 ext khác (0xCA34 ALPS — không fix được qua ExtraFingerprints)
# ExtraFingerprints: http2_no_priority đã có trong chrome146 native; header_order cho đúng thứ tự Chrome XHR POST
_CHROME_EXTRA_FP = ExtraFingerprints(
    http2_no_priority=True,
    # thứ tự header Chrome XHR POST: pseudo > content-type > JS-set > accept > sec-ch-ua* > ua > origin > sec-fetch-* > ae > al > cookie
    header_order='content-type,accept,sec-ch-ua,sec-ch-ua-mobile,sec-ch-ua-platform,user-agent,origin,sec-fetch-site,sec-fetch-mode,sec-fetch-dest,accept-encoding,accept-language,cookie',
)

# Session curl_cffi RIÊNG mỗi solve (key = solve_id) → chạy song song không đè cookie nhau. cf_solve.js gửi solve_id
# trong body /reset và /req; đóng khi solve xong.
# AsyncSession (curl multi) trên 1 event loop chung: mọi request của 1 solve dùng chung kết nối (+ ghép kênh h2, kể cả
# request song song) như Chrome. Session thường giữ curl handle THEO THREAD mà Flask mở thread mới mỗi request →
# request nào cũng bắt tay TCP+TLS lại (đo: 137-184ms so với 37ms dùng lại kết nối).
_loop = asyncio.SelectorEventLoop() if os.name == "nt" else asyncio.new_event_loop()   # curl cần add_reader
threading.Thread(target=_loop.run_forever, daemon=True).start()
_sessions: dict[str, AsyncSession] = {}
_sessions_lock = threading.Lock()
_orphan: AsyncSession | None = None   # request muộn của solve đã xong → 1 session chung, không tạo/lưu mới (không rò)


def _aio(coro, timeout: float | None = None):
    return asyncio.run_coroutine_threadsafe(coro, _loop).result(timeout)


async def _new_session(impersonate: str = DEFAULT_IMP, proxy: str | None = None, headers: dict | None = None) -> AsyncSession:
    # headers (UA, sec-ch-ua*, Accept-Language) do runner gửi từ fingerprint → khớp JS env
    kw: dict = dict(impersonate=impersonate, verify=False, headers=headers or {"User-Agent": UA}, timeout=30)
    p = proxy or os.environ.get("CF_PROXY", "").strip()
    if p:
        kw["proxies"] = {"http": p, "https": p}
    return AsyncSession(**kw)


def _close_session(s: AsyncSession | None) -> None:
    if s is not None:
        asyncio.run_coroutine_threadsafe(s.close(), _loop)   # không chờ: trả kết nối/handle curl ở nền


PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5091
DIR = os.path.dirname(os.path.abspath(__file__))
TASKS: dict[str, dict] = {}


# ---- mạng: cùng 1 logic cho 2 đường — IPC qua pipe host (@@Q, mặc định) và HTTP /reset,/req (chạy cf_solve.js lẻ) ----
async def _session_for(sid: str, impersonate: str, proxy: str | None) -> AsyncSession:
    global _orphan
    with _sessions_lock:
        s = _sessions.get(sid)
    if s is None:
        if _orphan is None:
            _orphan = await _new_session(impersonate, proxy)
        s = _orphan
    return s


async def _reset(q: dict) -> dict:
    sid = q.get("solve_id") or "default"
    s = await _new_session(q.get("impersonate") or DEFAULT_IMP,
                           q.get("proxy") or os.environ.get("CF_PROXY", "").strip() or None, q.get("headers"))
    with _sessions_lock:
        old = _sessions.get(sid)
        _sessions[sid] = s
    if old is not None:
        await old.close()
    return {"ok": True}


async def _fetch(q: dict) -> dict:
    """Trả {status,url,headers,_raw: bytes} | {error,...}; người gọi tự base64 _raw (ngoài event loop)."""
    method = (q.get("method") or "GET").upper()
    url = q["url"]
    body = base64.b64decode(q["body"]) if q.get("body") else None
    sess = await _session_for(q.get("solve_id") or "default", q.get("impersonate") or os.environ.get("CF_IMP", DEFAULT_IMP),
                              q.get("proxy") or os.environ.get("CF_PROXY", "").strip() or None)
    t0 = time.time()
    try:
        resp = await sess.request(method, url, headers=q.get("headers") or {}, content=body, verify=False,
                                  allow_redirects=True, timeout=150, extra_fp=_CHROME_EXTRA_FP)
    except Exception as exc:
        if DEBUG:
            print(f"[req] {method} ERR {int((time.time()-t0)*1000)}ms {url[:120]} :: {exc}", flush=True)
        return {"error": str(exc), "status": 0, "headers": {}, "body": ""}
    if DEBUG:
        print(f"[req] {method} {resp.status_code} {int((time.time()-t0)*1000)}ms len={len(resp.content)} {url[:120]}", flush=True)
    return {"status": resp.status_code, "url": str(resp.url), "headers": dict(resp.headers), "_raw": resp.content}


def _encode(a: dict) -> dict:
    if "_raw" in a:
        a["body"] = base64.b64encode(a.pop("_raw")).decode()
    return a


# ---- solver host: 1 process node (cf_host.js) giữ worker tái sử dụng — thay vì 1 process node mỗi task ----
# Pipe stdin/stdout với host chở cả task/kết quả LẪN request mạng của worker (@@Q → {a}) → không mở TCP mỗi request
# (300 luồng: mỗi request 1 kết nối tới Flask → tràn backlog + hết cổng tạm vì TIME_WAIT → worker ECONNREFUSED).
_host: subprocess.Popen | None = None
_host_lock = threading.Lock()
_pending: dict[str, tuple] = {}              # tid → (t0, host process đã nhận task): chưa có kết quả
_done_ev: dict[str, threading.Event] = {}    # tid → báo xong cho /result long-poll
LONGPOLL_S = float(os.environ.get("CF_LONGPOLL", "20"))
RESULT_TTL = float(os.environ.get("CF_RESULT_TTL", "300"))   # kết quả không ai lấy (client đã bỏ) → xoá sau ngần này giây


def _sweeper() -> None:
    # chạy lâu: token client không bao giờ đọc (timeout rồi bỏ) nằm mãi trong TASKS/_done_ev → RAM tăng dần
    while True:
        time.sleep(60)
        cut = time.time() - RESULT_TTL
        for tid, t in list(TASKS.items()):
            if t.get("t", cut + 1) < cut:
                TASKS.pop(tid, None)
                _done_ev.pop(tid, None)


threading.Thread(target=_sweeper, daemon=True).start()


def _finish(tid: str, token: str | None, error: str | None) -> None:
    ent = _pending.pop(tid, None)
    if ent is None:
        return
    t0 = ent[0]
    with _sessions_lock:
        s = _sessions.pop(tid, None)
    _close_session(s)   # trả kết nối/handle curl
    TASKS[tid] = {"status": "ready", "token": token, "t": time.time()} if token else \
        {"status": "error", "error": (error or "no token")[:300], "t": time.time()}
    ev = _done_ev.get(tid)
    if ev is not None:
        ev.set()
    print(f"[api] task {tid[:8]} {'TOKEN len=%d' % len(token) if token else 'FAIL ' + TASKS[tid]['error']} ({int((time.time()-t0)*1000)}ms)", flush=True)


def _host_writer(p: subprocess.Popen) -> None:
    # 1 thread ghi stdin host: event loop không bị chặn khi pipe đầy; base64 body lớn làm ở đây, ngoài loop
    while True:
        obj = p.wq.get()
        if obj is None:
            return
        if "a" in obj:
            _encode(obj["a"])
        try:
            p.stdin.write(json.dumps(obj, separators=(",", ":")) + "\n")
            p.stdin.flush()
        except (OSError, ValueError):
            return


async def _answer(p: subprocess.Popen, q: dict) -> None:
    try:
        a = await (_reset(q) if q.get("op") == "reset" else _fetch(q))
    except Exception as exc:
        a = {"error": str(exc), "status": 0, "headers": {}, "body": ""}
    a["qid"] = q.get("qid")
    p.wq.put({"a": a})


def _host_reader(p: subprocess.Popen) -> None:
    for line in p.stdout:
        if line.startswith("@@Q "):
            try:
                q = json.loads(line[4:])
            except ValueError:
                continue
            asyncio.run_coroutine_threadsafe(_answer(p, q), _loop)
            continue
        if not line.startswith("@@R "):
            if DEBUG:
                print(line.rstrip(), flush=True)
            continue
        try:
            r = json.loads(line[4:])
        except ValueError:
            continue
        _finish(r.get("id", ""), r.get("token"), r.get("error"))
    p.wq.put(None)   # dừng writer
    # host này chết (crash/kill): task NÓ đang giữ → lỗi (task đã gửi host mới thì không đụng); task kế tự khởi động host mới
    for tid, (_, h) in list(_pending.items()):
        if h is p:
            _finish(tid, None, "solver host died")


def _physical_cores() -> int:
    # solve là việc CPU thuần: worker = số core VẬT LÝ. Đo 300 client: 28 worker (core vật lý) so với 56 (luồng HT)
    # → throughput 250 vs 233/phút, CPU/solve 7.8 vs 11.6s, RAM 45 vs 57GB (2 luồng HT chia 1 core → mỗi solve chậm gấp đôi)
    try:
        import psutil
        return psutil.cpu_count(logical=False) or os.cpu_count() or 1
    except ImportError:
        return max(1, (os.cpu_count() or 2) // 2)   # không có psutil: giả định có hyperthreading (x86 phổ biến)


def _submit(tid: str, sitekey: str) -> None:
    global _host
    with _host_lock:
        if _host is None or _host.poll() is not None:
            try:
                _host = subprocess.Popen(["node", os.path.join(DIR, "cf_host.js")], cwd=DIR,
                                         env={**os.environ, "BRIDGE_PORT": str(PORT),
                                              "CF_WORKERS": os.environ.get("CF_WORKERS") or str(_physical_cores())},
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                         text=True, encoding="utf-8", errors="replace", bufsize=1)
            except OSError as e:
                _host = None
                _pending[tid] = (time.time(), None)
                _finish(tid, None, f"solver host unavailable: {e}")
                return
            _host.wq = queue.Queue()
            threading.Thread(target=_host_writer, args=(_host,), daemon=True).start()
            threading.Thread(target=_host_reader, args=(_host,), daemon=True).start()
        _pending[tid] = (time.time(), _host)
        _host.wq.put({"task": {"id": tid, "sitekey": sitekey}})


@app.before_request
def _bridge_local_only():
    # /req là open proxy → chỉ cho cf_solve.js (loopback) gọi
    if request.path in ("/req", "/reset") and request.remote_addr not in ("127.0.0.1", "::1"):
        return jsonify({"error": "forbidden"}), 403


@app.route("/turnstile", methods=["GET"])
def turnstile():
    sitekey = request.args.get("sitekey", "")
    if not re.fullmatch(r"[\w-]{0,64}", sitekey):
        return jsonify({"errorId": 1, "errorDescription": "bad sitekey"})
    tid = str(uuid.uuid4())
    TASKS[tid] = {"status": "processing"}
    _done_ev[tid] = threading.Event()
    print(f"[api] task {tid[:8]} sitekey={sitekey} url={request.args.get('url')}", flush=True)
    # nhận không giới hạn: host chạy CF_WORKERS solve cùng lúc, còn lại xếp hàng (session curl_cffi riêng theo solve_id)
    _submit(tid, sitekey)
    return jsonify({"errorId": 0, "taskId": tid})


@app.route("/result", methods=["GET"])
def result():
    tid = request.args.get("id", "")
    t = TASKS.get(tid)
    if not t:
        return jsonify({"errorId": 1, "errorDescription": "unknown task"})
    if t["status"] == "processing":
        # long-poll: giữ request tới khi xong (≤ CF_LONGPOLL s) → client nhận token ngay, không trễ thêm vì chu kỳ poll
        # và bớt hẳn số request (mỗi request = 1 kết nối TCP với client không keep-alive)
        ev = _done_ev.get(tid)
        if ev is not None:
            ev.wait(LONGPOLL_S)
        t = TASKS.get(tid, t)
    if t["status"] == "processing":
        ent = _pending.get(tid)
        if ent is None or ent[1].poll() is None:
            return jsonify({"status": "processing"})   # host còn sống → task đang chạy hoặc đang xếp hàng (có thể lâu)
        _finish(tid, None, "solver host died")          # host giữ task đã chết (lọt khe đúng lúc host chết)
        t = TASKS[tid]
    TASKS.pop(tid, None)
    _done_ev.pop(tid, None)
    if "token" in t:
        return jsonify({"errorId": 0, "status": "ready", "solution": {"token": t["token"]}})
    return jsonify({"errorId": 1, "errorDescription": t["error"]})


@app.route("/ping", methods=["GET"])
def ping():
    return "ok"


# HTTP bridge — chỉ cho `node cf_solve.js` chạy lẻ (dưới host thì đi IPC)
@app.route("/reset", methods=["POST"])
def reset():
    return jsonify(_aio(_reset(request.json or {}), timeout=60))


@app.route("/req", methods=["POST"])
def handle_req():
    a = _encode(_aio(_fetch(request.json or {}), timeout=170))
    return (jsonify(a), 500) if "error" in a else jsonify(a)


if __name__ == "__main__":
    from werkzeug.serving import BaseWSGIServer
    BaseWSGIServer.request_queue_size = 1024   # mặc định 128: đợt hàng trăm client kết nối cùng lúc bị từ chối
    print(f"[server] Turnstile solver on 0.0.0.0:{PORT} — reused workers, bridge over IPC, /result long-poll {LONGPOLL_S:.0f}s")
    app.run(host="0.0.0.0", port=PORT, threaded=True)
