'use strict';
// cf_fohook.js — hybrid fingerprint: ngay trước khi CF mã hoá payload fo (plaintext G), thay các field TĨNH
// bằng giá trị Chrome thật (profile capture OFFLINE một lần/bản build: chrome_profile_<b>.json, sinh bởi _mk_profile.js).
// Field gắn phiên (hash dữ liệu server, timing, cây DOM phiên...) vẫn do env tự tính.
// Không vá JS của trang: inspector session cùng thread (node:inspector);
//   1) breakpoint ở XMLHttpRequest-impl.send (jsdom) khi url chứa /fo/ → lần đầu (fo#1) lấy frame đầu tiên thuộc script trang
//      = hàm gửi xm(url, G) của orchestrate → đặt breakpoint ở đầu thân hàm đó, bỏ breakpoint send;
//   2) mỗi lần xm chạy với G có record collector (fo#2/fo#3) → sửa arguments[1] tại chỗ (Runtime.callFunctionOn trong realm trang).
const fs = require('fs');
const path = require('path');

const XHR_IMPL = require.resolve('jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js');

// chạy trong realm trang, this = G. P = profile (theo build): { static: {sig: {field: value}}, replay: {sig: {field: [samples]}}, top: {k: v} }
// tpRecs nhúng từ tp_lib (cùng cách nhận diện record như lúc tạo profile)
const { TP_SRC } = require('./tp_lib');
const FIX_FN = `function (P) {
  ${TP_SRC}
  var G = this, n = 0, f = 0, t = 0, miss = [];
  if (!G || typeof G !== 'object' || !G['1'] || typeof G['1'] !== 'object') return 'skip';
  tpRecs(G).forEach(function (x) {
    var S = P.static[x.sig], R = P.replay[x.sig], hit = false;
    if (S) for (var k in S) if (k in x.r) { x.r[k] = S[k]; f++; hit = true; }
    if (R) for (var k2 in R) if (k2 in x.r) { var a = R[k2]; x.r[k2] = a[Math.floor(Math.random() * a.length)]; f++; hit = true; }
    if (hit) n++; else if (!S && !R) miss.push(x.sig.slice(0, 20));
  });
  for (var q in P.top) if (q in G) { G[q] = P.top[q]; t++; }
  return 'records=' + n + ' fields=' + f + ' top=' + t + (miss.length ? ' unknown=' + miss.length : '');
}`;

// profile cho build b (null nếu chưa có). Cache theo file: worker tái sử dụng gọi mỗi solve (121KB đọc + parse lại mỗi lần)
const PROFILES = new Map();
function loadProfile(build, dir = __dirname) {
  const f = process.env.CF_PROFILE ? path.resolve(dir, process.env.CF_PROFILE) : path.join(dir, `chrome_profile_${build}.json`);
  if (!PROFILES.has(f)) PROFILES.set(f, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  return PROFILES.get(f);
}

// inspector session CÙNG THREAD: Debugger.paused được phát đồng bộ khi dừng, lệnh post trong handler chạy đồng bộ.
// 1 session / thread: worker tái sử dụng chạy nhiều solve NỐI TIẾP → tạo 1 lần, mỗi solve chỉ đổi profile/log + re-arm
// breakpoint (session mới mỗi solve = chồng nhiều session cùng Debugger.enable, cái nào cũng nhận mọi scriptParsed).
let S = null, call = null, LINE = 0, sendBp = null, xmBp = null, profile = null, log = () => {};
const URLS = new Map();   // scriptId → url, chỉ script trang http(s) (CallFrame.url đã deprecated, V8 để rỗng)
const urlOf = (f) => URLS.get(f.location.scriptId) || '';
// script trang (jsdom chạy qua vm với filename = URL tài liệu) — khác file Node (C:\..., file://, node:)
const isPage = (f) => /^https?:/.test(urlOf(f));
function startFoHook(prof, lg = console.log) {
  profile = prof; log = lg;
  if (!S) init();
  if (xmBp) { try { call('Debugger.removeBreakpoint', { breakpointId: xmBp }); } catch (_) {} xmBp = null; }   // sender của solve trước
  URLS.clear();
  if (!sendBp) sendBp = call('Debugger.setBreakpointByUrl', { urlRegex: 'XMLHttpRequest-impl\\.js$', lineNumber: LINE, condition: "String(this._url).indexOf('/fo/') >= 0" }).breakpointId;
  return S;
}
function init() {
  const inspector = require('inspector');
  const src = fs.readFileSync(XHR_IMPL, 'utf8').split('\n');
  LINE = src.findIndex((l) => /^ {2}send\(body\) \{/.test(l)) + 1;
  if (LINE < 1) throw new Error('không tìm thấy send(body) trong XMLHttpRequest-impl.js');
  const s = new inspector.Session();
  s.connect();
  call = (m, p = {}) => { let out, err, done = false; s.post(m, p, (e, r) => { err = e; out = r; done = true; }); if (!done) throw new Error(m + ' không đồng bộ'); if (err) throw err; return out; };
  s.on('Debugger.scriptParsed', ({ params }) => { if (/^https?:/.test(params.url)) URLS.set(params.scriptId, params.url); });
  s.on('Debugger.paused', ({ params }) => {
    try {
      const hit = params.hitBreakpoints || [];
      if (sendBp && hit.includes(sendBp)) {
        const fr = params.callFrames.find(isPage);
        if (!fr) { log('[fohook] không thấy frame trang khi send /fo/: ' + params.callFrames.slice(0, 8).map((f) => (f.functionName || '?') + '<' + urlOf(f).slice(-50) + '>').join(' | ')); return; }
        const fl = fr.functionLocation;
        const pb = call('Debugger.getPossibleBreakpoints', { start: fl, end: { scriptId: fl.scriptId, lineNumber: fl.lineNumber, columnNumber: fl.columnNumber + 2000 }, restrictToFunction: true });
        const inner = (pb.locations || []).find((l) => l.lineNumber > fl.lineNumber || l.columnNumber > fl.columnNumber) || fl;
        xmBp = call('Debugger.setBreakpoint', { location: inner }).breakpointId;
        call('Debugger.removeBreakpoint', { breakpointId: sendBp }); sendBp = null;
        log(`[fohook] sender=${fr.functionName || '(anon)'}@${fl.lineNumber}:${fl.columnNumber}`);
        // ELK_PROBE=1 (chẩn đoán): theo dõi JSON của G.eLkTe8 (object có toJSON) từ lúc gửi fo#1 — Chrome gửi "dhDQs5", env gửi object
        if (process.env.ELK_PROBE) {
          const g1 = call('Debugger.evaluateOnCallFrame', { callFrameId: fr.callFrameId, expression: 'arguments[1]' });
          const oid = g1.result && g1.result.objectId, t0 = Date.now();
          let last = null;
          const probe = () => { try { const r = call('Runtime.callFunctionOn', { objectId: oid, functionDeclaration: 'function(){var e=this.eLkTe8;if(e===undefined)return "(none)";var o=[];try{o.push(JSON.stringify(e))}catch(x){o.push("E1 "+x)}try{o.push(JSON.stringify({eLkTe8:e}))}catch(x){o.push("E2 "+x)}try{o.push(JSON.stringify(e.toJSON("eLkTe8")))}catch(x){o.push("E3 "+x)}try{o.push(JSON.stringify(this))}catch(x){o.push("E4 "+x)}return o.join(" ¦ ").replace(/"(wDAKY2|lNFJ7|nWlv8|SFbz3|XGeC1|VaCk8|VbYF3)":("[^"]*"|[[^]]*])/g,"")}', returnByValue: true });
            const v = r.result && r.result.value; if (v !== last) { log(`[elk] +${Date.now() - t0}ms eLkTe8=${v}`); last = v; } } catch (e) { log('[elk] ' + e.message); } };
          if (oid) { probe(); const iv = setInterval(probe, 20); setTimeout(() => clearInterval(iv), 15000); }
        }
      } else if (xmBp && hit.includes(xmBp)) {
        const g = call('Debugger.evaluateOnCallFrame', { callFrameId: params.callFrames[0].callFrameId, expression: 'arguments[1]' });
        if (g.result && g.result.objectId) {
          const r = call('Runtime.callFunctionOn', { objectId: g.result.objectId, functionDeclaration: FIX_FN, arguments: [{ value: profile }], returnByValue: true });
          const v = r.result && r.result.value;
          if (v !== 'skip') log('[fohook] fo payload: ' + (v || JSON.stringify(r.exceptionDetails || r).slice(0, 200)));
          // FOHOOK_DUMP=<dir> → dump G plaintext sau FIX_FN vào <dir>/fohook_G_<ts>.json
          const dumpDir = process.env.FOHOOK_DUMP;
          if (dumpDir && v && v !== 'skip') {
            const dumpExpr = call('Runtime.callFunctionOn', { objectId: g.result.objectId, functionDeclaration: 'function(){return JSON.stringify(this);}', returnByValue: true });
            if (dumpExpr.result && dumpExpr.result.value) {
              const dumpFile = path.join(dumpDir, `fohook_G_${Date.now()}.json`);
              try { fs.writeFileSync(dumpFile, dumpExpr.result.value); log('[fohook] dump → ' + dumpFile); } catch (de) { log('[fohook] dump lỗi ' + de.message); }
            }
          }
          call('Runtime.releaseObject', { objectId: g.result.objectId });
        }
      }
    } catch (e) { log('[fohook] lỗi ' + (e && e.message)); }
    finally { try { call('Debugger.resume'); } catch (_) {} }
  });
  // maxScriptsCacheSize 0: mặc định debugger GIỮ MÃI mọi script đã bị GC (không giới hạn) → worker tái sử dụng rò
  // ~45MB/solve (script inline CF + eval + code Worker của từng solve)
  call('Debugger.enable', { maxScriptsCacheSize: 0 });
  S = s;
}

module.exports = { startFoHook, loadProfile, FIX_FN };
