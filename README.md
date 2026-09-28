# cf_turnstile_js — browserless Cloudflare Turnstile solver

Solves Cloudflare Turnstile **without a browser**. The challenge page and Cloudflare's own orchestrate/VM code run
inside an emulated browser environment (jsdom), and every network request goes through a curl_cffi bridge that
presents a real Chrome TLS/HTTP2 fingerprint. No Chrome is installed or launched.

- ~3 s per solve on a warm worker (idle machine)
- ~280 tokens/min sustained on a 28-core machine at full load, ~95% success
- RAM stays flat on long runs (~0.75 GB per busy worker)
- One HTTP server, one port, any number of client threads (tasks are queued)

---

## Contents
1. [Requirements](#1-requirements)
2. [Install](#2-install)
3. [Run the server](#3-run-the-server)
4. [API](#4-api)
5. [Client examples](#5-client-examples)
6. [How it works](#6-how-it-works)
7. [Configuration](#7-configuration)
8. [Performance and tuning](#8-performance-and-tuning)
9. [Solving for another site](#9-solving-for-another-site)
10. [Troubleshooting](#10-troubleshooting)
11. [Files](#11-files)
12. [Limitations](#12-limitations)

---

## 1. Requirements

| | Version | Notes |
|---|---|---|
| Node.js | 22+ (tested 24.14) | runs the emulated browser; `node` must be on `PATH` |
| Python | 3.10+ (tested 3.12) | runs the API server and the curl_cffi network bridge |
| RAM | ~0.75 GB per worker at full load | 28 workers ≈ 21 GB |
| `curl` | any | only for a rare code path; built into Windows 10+, Linux, macOS |

Tested on Windows 10 (2× Xeon E5-2680 v4, 64 GB). Linux and macOS work the same way.

## 2. Install

```bash
git clone https://github.com/yqpw75dbyf-droid/cloudflare-turnstile-solve-reverse.git
cd cloudflare-turnstile-solve-reverse
npm install                        # jsdom 29.1.1
pip install -r requirements.txt    # flask, curl_cffi
pip install psutil                 # optional: exact physical-core count for the default worker count
```

## 3. Run the server

```bash
cd solver
python net_bridge_server.py        # listens on 0.0.0.0:5091
python net_bridge_server.py 6000   # or pick a port
```

Check it is up:

```bash
curl http://127.0.0.1:5091/ping    # → ok
```

The worker pool starts on the first task. The first solve of each worker also loads the modules (~1–2 s extra);
later solves reuse the warm worker.

Log output is one line when a task arrives and one when it ends:

```
[api] task 1a2b3c4d sitekey=0x4AAAAAAA... url=https://example.com/login
[api] task 1a2b3c4d TOKEN len=752 (3120ms)
[api] task 5e6f7a8b FAIL fail {"source":"cloudflare-challenge",...} (7640ms)
```

Set `CF_DEBUG=1` for per-request logs.

**Single solve without the API** (the server must still be running, it provides the network bridge):

```bash
cd solver
CF_SITEKEY=0x4AAAAAAA... node cf_solve.js    # prints "*** TOKEN ***" and the token
# BRIDGE_PORT=6000 if the server is not on 5091
```

## 4. API

Two calls: create a task, then fetch the result.

### Create a task

`GET /turnstile?url=<page url>&sitekey=<sitekey>`

```json
{ "errorId": 0, "taskId": "5568a982-ba67-4744-9b00-0c0e538886a5" }
```

- `sitekey` — the Turnstile sitekey of the widget (letters, digits, `_`, `-`; max 64 chars).
- `url` — informational only (logged). The page context the solver presents to Cloudflare comes from
  `solver/parent_ctx.json`, see [Solving for another site](#9-solving-for-another-site).

Invalid sitekey → `{ "errorId": 1, "errorDescription": "bad sitekey" }`.

### Get the result

`GET /result?id=<taskId>`

```json
{ "status": "processing" }
{ "errorId": 0, "status": "ready", "solution": { "token": "1.ta4rB4uZ..." } }
{ "errorId": 1, "errorDescription": "..." }
```

- **Long-poll:** the request is held until the task finishes, for up to `CF_LONGPOLL` seconds (default 20), so the
  token is returned as soon as it exists. If it answers `processing`, just call again. Use an HTTP timeout above
  20 s on the client.
- A result is removed once it has been read. Unknown or already-read ids answer
  `{ "errorId": 1, "errorDescription": "unknown task" }`.
- Results nobody fetches are dropped after `CF_RESULT_TTL` seconds (default 300).

### Other endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /ping` | public | health check, answers `ok` |
| `POST /reset`, `POST /req` | loopback only | HTTP network bridge, used only by `node cf_solve.js` run on its own |

Any number of tasks can be created at once; `CF_WORKERS` of them are solved at the same time and the rest wait in a
FIFO queue.

## 5. Client examples

### curl

```bash
curl "http://127.0.0.1:5091/turnstile?url=https://example.com/login&sitekey=0x4AAAAAAA..."
curl "http://127.0.0.1:5091/result?id=<taskId>"
```

### Python

```python
import time
import requests

API = "http://127.0.0.1:5091"


def solve(sitekey: str, url: str = "", timeout: float = 180) -> str:
    task = requests.get(f"{API}/turnstile", params={"url": url, "sitekey": sitekey}, timeout=30).json()
    if task.get("errorId"):
        raise RuntimeError(task.get("errorDescription"))
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(f"{API}/result", params={"id": task["taskId"]}, timeout=40).json()  # long-poll ≤ 20 s
        if r.get("status") == "processing":
            continue
        if r.get("errorId"):
            raise RuntimeError(r.get("errorDescription"))
        return r["solution"]["token"]
    raise TimeoutError("solve timed out")
```

### Node.js

```js
const API = 'http://127.0.0.1:5091';

async function solve(sitekey, url = '') {
  const task = await (await fetch(`${API}/turnstile?${new URLSearchParams({ url, sitekey })}`)).json();
  if (task.errorId) throw new Error(task.errorDescription);
  for (;;) {
    const r = await (await fetch(`${API}/result?id=${task.taskId}`)).json();   // long-poll ≤ 20 s
    if (r.status === 'processing') continue;
    if (r.errorId) throw new Error(r.errorDescription);
    return r.solution.token;
  }
}
```

Use the token wherever the real widget's token would go: the `cf-turnstile-response` form field, or the request the
site's own challenge flow expects.

## 6. How it works

### One solve

1. **Build lookup.** Turnstile's `api.js` redirects to `/turnstile/v0/<build>/<hash>/api.js`. The build letter and
   hash are cached for 5 minutes (a real browser also has `api.js` in its cache).
2. **Challenge page.** `GET /cdn-cgi/challenge-platform/h/<build>/turnstile/f/av0/rch/<id>/<sitekey>/…` returns the
   challenge HTML with Cloudflare's orchestrate script inline.
3. **Emulated browser.** jsdom parses the page inside an environment shaped like Chrome: navigator, screen, canvas,
   WebGL, media, workers, timing, the full global surface of Chrome (`solver/chrome_surface.json`), native-looking
   functions and prototype order. Cloudflare inserts 7 iframes to compare against the main window, so every solve
   builds 8 complete realms.
4. **Parent page.** The solver plays the embedding page (`api.js` side of the `postMessage` protocol:
   `init` → `extraParams` → `execute`), using `solver/parent_ctx.json`.
5. **Payload fields.** Cloudflare collects fingerprint records and encrypts them before sending (`fo` requests).
   Just before encryption, an inspector breakpoint (same thread, `cf_fohook.js`) replaces the static fields with
   values captured from a real Chrome (`solver/chrome_profile_<build>.json`). Session-bound fields are left as
   computed.
6. **Token.** Cloudflare's code posts `complete` with the token to the parent.

Cloudflare itself waits about 1.5 s before the final submission, and the protocol needs several network round trips,
so about 2.5–3 s is the floor for one solve.

### Processes

```
clients ──HTTP──▶ net_bridge_server.py  (:5091)
                    · task API (/turnstile, /result long-poll)
                    · network bridge: curl_cffi AsyncSession per solve (Chrome TLS/HTTP2, connection reuse)
                         │  stdin/stdout pipe: tasks, results and every network request of the workers
                         ▼
                  node cf_host.js
                    · pool of CF_WORKERS worker processes, FIFO queue, idle release, watchdog
                         │  IPC
                         ▼
                  worker process ─ cf_solve.js → cf_dom.js (+ cf_surface, cf_canvas, …) → Cloudflare JS
```

Workers are reused: Node, jsdom, the JSON profiles and the inspector load once per worker, not once per solve.
Between solves a worker releases the previous solve's windows and runs a multi-pass GC when its heap is large
(jsdom windows are only freed after several GC cycles with event-loop turns in between; without this RAM grows until
the machine runs out). Workers are replaced after about `CF_RECYCLE` solves as a safety net.

## 7. Configuration

All settings are environment variables of `net_bridge_server.py` (workers inherit them).

**Pool and API**

| Variable | Default | Meaning |
|---|---|---|
| `CF_WORKERS` | physical CPU cores | solves running at the same time; the rest queue |
| `CF_IDLE_MS` | 60000 | an idle worker is released after this many ms |
| `CF_LONGPOLL` | 20 | max seconds `/result` waits |
| `CF_RESULT_TTL` | 300 | seconds an unread result is kept |
| `CF_TIMEOUT` | 90000 | ms per solve; a worker stuck for `CF_TIMEOUT` + 30 s is killed |
| `CF_HOST_MODE` | `proc` | `thread` runs workers as threads (slower under load) |

**Memory and CPU**

| Variable | Default | Meaning |
|---|---|---|
| `CF_WORKER_FLAGS` | `--max-opt=2 --single-threaded-gc --max-semi-space-size=8 --max-old-space-size=1024` | V8 flags for worker processes (about 20% less CPU per solve under load; 1 GB heap cap per worker) |
| `CF_GC_MB` | 450 | a worker runs a multi-pass GC between solves once its heap exceeds this (lower = less RAM, more CPU) |
| `CF_GC_PASSES` | 3 | GC cycles per cleanup |
| `CF_RECYCLE` | 200 | replace a worker after about this many solves (±25% per worker so they don't all restart together) |

**Network and fingerprint**

| Variable | Default | Meaning |
|---|---|---|
| `CF_PROXY` | none | proxy for all Cloudflare traffic, e.g. `http://user:pass@host:port` |
| `CF_IMP` | `chrome146` | curl_cffi impersonation profile |
| `CF_APIJS_TTL` | 300000 | ms to cache the `api.js` build and hash |
| `CF_HYBRID` | on | `0` disables the payload field replacement (`cf_fohook.js`) |
| `CF_PROFILE` | `chrome_profile_<build>.json` | use another Chrome profile file |

**Standalone `node cf_solve.js`**: `CF_SITEKEY` (sitekey), `BRIDGE_PORT` (server port, default 5091).

**Logs and diagnostics**

| Variable | Meaning |
|---|---|
| `CF_DEBUG=1` | verbose logs: every bridge request, worker output |
| `CF_MEMLOG=1` | after each solve, force a GC and print each worker's live heap and RSS |
| `CF_SNAP_AT=N[,M]` | write a heap snapshot to the temp folder after solve N (open in Chrome DevTools) |

## 8. Performance and tuning

Measured on 2× Xeon E5-2680 v4 (28 cores / 56 threads), 64 GB RAM, Windows 10, default settings:

| Scenario | Result |
|---|---|
| One solve, warm worker, idle machine | ~3.0 s wall, ~3.3 s CPU |
| 56 clients non-stop for several minutes (28 workers) | ~280 tokens/min, ~6 s CPU per solve, ~95% success |
| RAM at full load | ~21 GB for 28 workers, flat over time |

Solving is CPU-bound, so throughput ≈ CPU cores ÷ CPU seconds per solve.

- **Workers = physical cores** (the default). More workers measured slower overall (40 workers: 235/min vs
  28 workers: 270/min, 200 clients), because two workers sharing a core halve each other's speed and add RAM.
- **Client threads are free.** Run 200 or 500 client threads if you like; the extra tasks wait in the queue instead
  of fighting for CPU.
- **Less RAM:** lower `CF_WORKERS`, or set `CF_GC_MB=300` (a bit more CPU).
- **Other load on the machine** (your own tools, other solvers) takes CPU from the pool; lower `CF_WORKERS`
  accordingly.
- **Success rate** drops when the machine is overloaded (Cloudflare measures timing) or when the IP has a bad
  reputation (`CF_PROXY`).

## 9. Solving for another site

The token is issued for the page the solver pretends to be embedded in. That context comes from
`solver/parent_ctx.json`, not from the `url` parameter. The bundled file was captured from roblox.com.

To solve for another site, capture that site's values into `solver/parent_ctx.json`: parent origin, page URL, the
`wPr` object and `csStack` sent by `api.js`, and the widget parameters (appearance, execution, language, …). The
browser fingerprint itself comes from `captured_env.json`.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `solver host unavailable` | `node` is not on `PATH` for the server process |
| `worker died: terminated` | the solve exceeded `CF_TIMEOUT` + 30 s, or the worker crashed; the task is failed and a new worker starts |
| worker fails to start with `bad option` | Node too old for a V8 flag: set `CF_WORKER_FLAGS` to what your Node supports, or upgrade Node |
| `challenge HTML 400` | wrong sitekey, or Cloudflare changed something; the cached build is refreshed automatically |
| `fail {..."event":"fail"...}` | Cloudflare rejected this solve. About 5% is normal. Much more: machine overloaded (lower `CF_WORKERS`) or IP reputation (`CF_PROXY`) |
| tasks stay `processing` a long time | the queue is long: more tasks than the pool finishes; add cores or lower client load |
| requests go to an old server | on Windows two processes can listen on the same port; check `netstat -ano \| findstr :5091` and stop the old one |
| RAM grows without limit | check `CF_WORKER_FLAGS` / `CF_GC_MB` are not overridden; `CF_MEMLOG=1` shows each worker's live heap |
| need more detail | run with `CF_DEBUG=1` |
| success collapses after a Cloudflare update | new build: with `CF_DEBUG=1` the log reports a missing `chrome_profile_<build>.json`; a profile for the new build must be captured from a real Chrome |

## 11. Files

| File | Role |
|---|---|
| `solver/net_bridge_server.py` | the server: task API, result long-poll, curl_cffi network bridge, starts `cf_host.js` |
| `solver/cf_host.js` | worker pool: reused worker processes, queue, idle release, watchdog, GC between solves, bridge routing |
| `solver/cf_solve.js` | one solve: build lookup → challenge HTML → jsdom → Cloudflare's code → token |
| `solver/cf_dom.js` | the emulated browser: window/realm setup, iframes, workers, timing, layout, native-looking functions |
| `solver/cf_surface.js`, `cf_canvas.js`, `cf_media.js`, `cf_jsengine.js`, `cf_temporal.js`, `cf_worker.js` | Chrome API surface, canvas/WebGL, images, JS engine details, `Temporal`, worker scope |
| `solver/cf_fohook.js`, `solver/tp_lib.js` | replace static fingerprint fields in the `fo` payload with values from a real Chrome |
| `solver/net_bridge.js` | Node side of the bridge (IPC under `cf_host.js`, HTTP `/req` when `cf_solve.js` runs alone) |
| `solver/chrome_profile_b.json` | real-Chrome field values **for Cloudflare build `b`** |
| `solver/parent_ctx.json` | the embedding page context (roblox.com) |
| `captured_env.json` | browser/machine fingerprint (navigator, screen, UA-CH, …) |
| `solver/chrome_surface.json`, `dom_types.json`, `call_results.json`, `probe_results.json`, `web_surfaces.json`, `chrome_namespaces.json`, `chrome_temporal.json`, `ps_profile.json` | Chrome API surface, types and recorded results used by the emulation |

## 12. Limitations

- Tied to the current Cloudflare build (`/turnstile/v0/b/…`). A new build needs a new
  `chrome_profile_<build>.json` captured from a real Chrome.
- The embedding context is fixed by `parent_ctx.json` (see [section 9](#9-solving-for-another-site)).
- About 2.5–3 s per solve is the floor (Cloudflare's own 1.5 s wait plus network round trips).
- One outgoing IP (or one `CF_PROXY`) for all solves.
