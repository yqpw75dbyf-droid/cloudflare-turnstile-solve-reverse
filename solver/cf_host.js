'use strict';
// cf_host.js — bộ điều phối giải Turnstile với worker TÁI SỬ DỤNG thay vì 1 process node mới mỗi solve:
//   module jsdom + profile JSON (~1.2s CPU, ~125MB) và inspector fohook chỉ load 1 lần / worker.
// Worker = process con sống lâu (CF_HOST_MODE=proc, mặc định) hoặc worker_thread (CF_HOST_MODE=thread).
//   Nhiều isolate V8 trong 1 process giành nhau bộ cấp phát/NUMA → 20 solve song song tốn CPU gấp đôi/solve;
//   process riêng thì mỗi cái có heap + V8 platform riêng, OS rải đều 2 socket.
// Nhận task không giới hạn; số solve CHẠY cùng lúc = CF_WORKERS (mặc định = số luồng CPU), còn lại xếp hàng FIFO.
//   Solve là việc CPU thuần: chạy nhiều hơn số luồng CPU không nhanh hơn, chỉ làm mọi solve chậm lại, phình RAM
//   và méo timing mà Cloudflare đo → fail nhiều hơn.
// Worker rảnh quá CF_IDLE_MS thì thu hồi (trả RAM sau cao điểm). Mỗi worker 1 solve tại một thời điểm.
// Bridge mạng (curl_cffi) đi qua chính đường pipe với Python (CF_BRIDGE_IPC), không mở TCP mỗi request.
// stdin : mỗi dòng JSON {task:{id,sitekey}} | {a:{qid,...}} (Python trả lời yêu cầu bridge)
// stdout: "@@R " + JSON {id, token}|{id, error}  |  "@@Q " + JSON {qid, op, ...} (yêu cầu bridge)  |  dòng khác = log
const { Worker, isMainThread, parentPort } = require('worker_threads');
const CHILD = process.argv.includes('--child');

async function run1(t) {
  const { solve } = require('./cf_solve');
  let r;
  try { r = await solve({ sitekey: t.sitekey, solveId: t.id }); } catch (e) { r = { error: String((e && e.message) || e) }; }
  return r.token ? { id: t.id, token: r.token }
    : { id: t.id, error: (r.error || 'no token') + (r.detail ? ' ' + JSON.stringify(r.detail).slice(0, 200) : '') };
}

// Worker: GC chủ động GIỮA 2 solve. Context vm của mỗi window jsdom chỉ được thả sau NHIỀU lượt GC có nhịp event loop
// xen giữa (weak callback của Node) — tải cao V8 hiếm khi có đúng chuỗi đó → "rác chờ thả" dồn ~40MB/solve/worker:
// chạy lâu 28 worker × ~2.6GB = cạn RAM → swap → throughput sụp (đo: 300 → 36 token/phút sau 3.5 phút).
// Đo 1 worker, heap sống sau GC: 1 lượt/solve 118→723MB sau 16 solve (tăng mãi); 3 lượt xen nhịp: đứng 100–146MB.
// gc lấy qua bật/tắt cờ V8 trong 1 context tạm → context của page (tạo sau) KHÔNG có `gc` (không lộ với CF).
function getGc() {
  try {
    const v8 = require('v8'), vm = require('vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    v8.setFlagsFromString('--no-expose-gc');
    return typeof gc === 'function' ? gc : null;
  } catch (_) { return null; }
}
function workerLoop(reply) {
  const gc = getGc(), MEMLOG = process.env.CF_MEMLOG === '1';
  // Dọn khi heap > 450MB (~9 solve/lần): mỗi lần ~0.7s CPU, gần như cố định (chủ yếu đánh dấu ~100MB nền jsdom/code),
  // nên dọn thưa rẻ hơn dọn dày; heap vẫn bị chặn (trần cứng --max-old-space-size=1024).
  const GC_B = +(process.env.CF_GC_MB || 450) * 1048576, PASSES = +(process.env.CF_GC_PASSES || 3);
  const tick = () => new Promise((z) => setTimeout(z, 5));
  require('./cf_solve');   // load module ngay khi sinh (nóng sẵn trước task đầu)
  // jsdom cache stylesheet mặc định (css/helpers/computed-style.js: parsedDefaultStyleSheet) gắn với window ĐẦU TIÊN gọi
  // getComputedStyle và giữ mãi → khởi tạo trước bằng 1 window tạm nhỏ, để nó không giữ nguyên solve đầu (8 realm ~40MB).
  try { const { JSDOM } = require('jsdom'); const d = new JSDOM('<p>x</p>'); void d.window.getComputedStyle(d.window.document.querySelector('p')).display; d.window.close(); } catch (_) {}
  let n = 0, chain = Promise.resolve();
  async function one(t) {
    reply({ r: await run1(t) });   // token đi trước; dọn heap xong mới nhận task kế (chain) → GC không chen vào giữa solve
    n++;
    let gcMs = 0;
    if (gc && (MEMLOG || process.memoryUsage().heapUsed > GC_B)) {
      const t0 = performance.now();
      for (let i = 0; i < PASSES; i++) { if (i) await tick(); gc(); }
      gcMs = performance.now() - t0;
    }
    if (MEMLOG) process.stderr.write(`[mem] pid=${process.pid} solve#${n} heap=${Math.round(process.memoryUsage().heapUsed / 1048576)}MB rss=${Math.round(process.memoryUsage().rss / 1048576)}MB gc=${gcMs.toFixed(0)}ms\n`);
    // chẩn đoán rò: CF_SNAP_AT=N[,M…] → sau solve#N chụp heap snapshot vào TEMP (DevTools/phân tích retainer)
    if (String(process.env.CF_SNAP_AT || '').split(',').map(Number).includes(n)) {
      const f = require('v8').writeHeapSnapshot(require('path').join(require('os').tmpdir(), `worker_${process.pid}_${n}.heapsnapshot`));
      process.stderr.write(`[snap] ${f}\n`);
    }
  }
  return (m) => { if (m && m.task) chain = chain.then(() => one(m.task)).catch(() => {}); };
}

if (CHILD) {
  process.on('message', workerLoop((x) => process.send(x)));
  process.on('disconnect', () => process.exit(0));   // host chết → con tự tắt
} else if (!isMainThread) {
  parentPort.on('message', workerLoop((x) => parentPort.postMessage(x)));
} else {
  const os = require('os');
  const THREAD = process.env.CF_HOST_MODE === 'thread';
  const MAX = Math.max(1, +(process.env.CF_WORKERS || (os.availableParallelism ? os.availableParallelism() : os.cpus().length)));
  const IDLE_MS = +(process.env.CF_IDLE_MS || 60000);
  const HARD_MS = +(process.env.CF_TIMEOUT || 90000) + 30000;   // watchdog: solve treo (vd vòng lặp đồng bộ) → giết worker
  const env = { ...process.env, CF_BRIDGE_IPC: '1' };
  // Cờ V8 cho worker (đo 200 client, 28 worker): CPU/solve 7.2s → 5.7s, 242 → 270 token/phút.
  //   --max-opt=2: trần JIT = Maglev. Code CF mới hoàn toàn mỗi solve, sống vài giây → TurboFan tốn CPU tối ưu rồi vứt.
  //   --single-threaded-gc: 28 process × thread GC song song giành CPU khi đầy tải → tốn hơn là lợi.
  //   --max-semi-space-size=8: young gen nhỏ → ít RAM, cache đỡ bị tranh.
  //   --max-old-space-size=1024: trần cứng/worker — chạy lâu không bao giờ để 28 worker ăn hết RAM máy.
  const FLAGS = (process.env.CF_WORKER_FLAGS ?? '--max-opt=2 --single-threaded-gc --max-semi-space-size=8 --max-old-space-size=1024')
    .split(/\s+/).filter(Boolean);
  // thay worker sau ~N solve: lưới an toàn cho rò chậm. Lệch ±25% mỗi worker — cùng N thì 28 worker sinh cùng lúc sẽ
  // cùng thay cùng lúc (đo: 1 nhịp chững 30s, CPU/solve 6 → 7.7s)
  const RECYCLE = +(process.env.CF_RECYCLE || 200);
  const idle = [], queue = [];   // idle LIFO: lấy worker vừa xong (nóng nhất); queue FIFO: task chờ worker
  const QW = new Map();          // qid chung → [worker, qid riêng của worker]
  let live = 0, gq = 0;
  const out = (line) => process.stdout.write(line + '\n');
  const send = (w, m) => { try { THREAD ? w.postMessage(m) : w.send(m); } catch (_) {} };
  const kill = (w) => (THREAD ? w.terminate() : w.kill());
  const assign = (w, t) => { clearTimeout(w.idleT); w.task = t; w.watch = setTimeout(() => kill(w), HARD_MS); send(w, { task: t }); };
  const next = (w) => {
    if (queue.length) return assign(w, queue.shift());
    idle.push(w);
    w.idleT = setTimeout(() => { const i = idle.indexOf(w); if (i >= 0) { idle.splice(i, 1); kill(w); } }, IDLE_MS);
  };
  const spawn = () => {
    live++;
    const w = THREAD ? new Worker(__filename, { env })
      : require('child_process').fork(__filename, ['--child'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: FLAGS });
    w.n = 0; w.life = Math.max(1, Math.round(RECYCLE * (0.75 + Math.random() * 0.5)));
    w.on('message', (m) => {
      if (m && m.q) { const g = ++gq; QW.set(g, [w, m.q.qid]); return out('@@Q ' + JSON.stringify({ ...m.q, qid: g })); }
      if (m && m.r) {
        clearTimeout(w.watch); w.task = null; out('@@R ' + JSON.stringify(m.r));
        if (++w.n >= w.life) kill(w);   // exit handler bù worker mới nếu còn task chờ
        else next(w);
      }
    });
    w.on('error', (e) => { w.err = e && e.message; });
    w.on('exit', () => {
      live--; clearTimeout(w.watch); clearTimeout(w.idleT);
      const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1);
      for (const [g, e] of QW) if (e[0] === w) QW.delete(g);
      if (w.task) out('@@R ' + JSON.stringify({ id: w.task.id, error: 'worker died: ' + (w.err || 'terminated') }));
      if (queue.length && live < MAX) assign(spawn(), queue.shift());   // worker chết mà còn task chờ → bù worker mới
    });
    return w;
  };
  const run = (t) => { const w = idle.pop(); if (w) assign(w, t); else if (live < MAX) assign(spawn(), t); else queue.push(t); };
  require('readline').createInterface({ input: process.stdin })
    .on('line', (l) => {
      let m; try { m = JSON.parse(l); } catch (_) { return; }
      if (m.task && m.task.id) return run(m.task);
      if (m.a) { const e = QW.get(m.a.qid); if (e) { QW.delete(m.a.qid); send(e[0], { a: { ...m.a, qid: e[1] } }); } }
    })
    .on('close', () => process.exit(0));   // server Python tắt/đóng pipe → host tắt theo (con nhận 'disconnect')
}
