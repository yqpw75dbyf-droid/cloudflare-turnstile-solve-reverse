'use strict';
// cf_surface.js — bề mặt global giống Chrome thật (chrome_surface.json dump bằng Chrome CÙNG máy) + replay object:
//   1. xoá global Chrome không có (SharedArrayBuffer khi không isolated, ontouch*, oncopy…)
//   2. thêm mọi interface thiếu (đúng thứ tự kế thừa, kiểu ctor, length, hằng số, toStringTag)
//   3. thêm thuộc tính thiếu trên prototype sẵn có + global object (speechSynthesis, …)
//   4. "remote object": mọi thao tác (new/call/get/set) trên object của interface thiếu được ghi theo lineage
//      (chain = hash chuỗi thao tác tạo ra object) → CALLREC=1 ghi probe_calls.json → call_replayer.html chạy
//      y hệt trong Chrome thật → call_results.json → phát lại (giá trị, Promise + độ trễ, object con + snapshot getter).
//      Miss → giá trị fallback theo kiểu trong lib.dom.d.ts (dom_types.json) để lượt ghi đi được sâu.
const fs = require('fs');
const path = require('path');
const rd = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const S = rd('chrome_surface.json');
const T = rd('dom_types.json');
let NS = {}; try { NS = rd('chrome_namespaces.json'); } catch (_) {}
let CALLS = {};
try { CALLS = rd('call_results.json').results || {}; } catch (_) {}
// ghi nối tiếp probe_calls.jsonl ngay khi có (process có thể bị kill/treo) — các lượt cộng dồn, replay_calls.js khử trùng
const CALLS_FILE = path.join(__dirname, 'probe_calls.jsonl');
const recSeen = new Set();
try { for (const l of fs.readFileSync(CALLS_FILE, 'utf8').split('\n')) if (l) recSeen.add(JSON.parse(l).key); } catch (_) {}
const CALLREC = process.env.CALLREC ? { push(x) { if (!recSeen.has(x.key)) { recSeen.add(x.key); fs.appendFileSync(CALLS_FILE, JSON.stringify(x) + '\n'); } } } : null;
const stats = { hit: 0, miss: 0, missed: new Set() };
if (process.env.REPLAYLOG) process.on('exit', () => console.log(`[calls] hit=${stats.hit} miss=${stats.miss} ${[...stats.missed].slice(0, 40).join(' ')}`));
// method có sẵn trong jsdom nhưng trả sai → replay theo tham số (chain 'P:' = object mẫu dựng trong Chrome)
const PURE = { HTMLMediaElement: ['canPlayType'] };
const ML = new Set(['get', 'has', 'keys', 'values', 'entries', 'forEach']);

// ponytail: isFrame=true → bỏ tạo 957 interface mới (CF không probe chúng trong sub-frame)
// own: như mark nhưng nối luôn proto realm page + đánh dấu đã walk (cf_dom) — ~10k hàm lá/realm ở đây, để walk
// khỏi duyệt lại + khỏi ghi REPARENTED rồi hoàn tác (chúng chết theo window). Không truyền → như mark.
function installSurface(w, { mark, own = mark, h53, log, isFrame }) {
  const O = w.Object, WF = w.Function;
  const OBJ = new WeakMap();   // object → { chain, vals?, snap?, ml?, h? }
  const singles = new Map();   // chain → singleton

  // ---- 1. xoá global thừa ----
  const chromeOwn = new Set(S.window.map((p) => p[0]));
  for (const k of Object.getOwnPropertyNames(w)) {
    if (chromeOwn.has(k) || k.startsWith('_')) continue;
    const d = Object.getOwnPropertyDescriptor(w, k);
    if (d && d.configurable) try { delete w[k]; if (process.env.SURFLOG) log(`[surface] - ${k}`); } catch (_) {}
  }

  const isET = (C) => { for (let p = C && C.prototype; p; p = Object.getPrototypeOf(p)) if (p === w.EventTarget.prototype) return true; return false; };
  const makeInst = (cls, chain, extra) => {
    const C = cls && typeof w[cls] === 'function' && w[cls].prototype ? w[cls] : null;
    const inst = !C ? new w.Object() : isET(C) ? Object.setPrototypeOf(new w.EventTarget(), C.prototype) : O.create(C.prototype);
    if (chain) OBJ.set(inst, { chain, ...extra });
    return inst;
  };
  const single = (cls, chain) => {
    if (!singles.has(chain)) {
      const inst = makeInst(cls, chain, { vals: S.values[chain.slice(2)] });
      if (cls === 'VisualViewport') {
        // phản ánh kích thước thật của iframe (cập nhật khi RESIZE gọi)
        Object.defineProperty(inst, 'width', { get() { return w.innerWidth; }, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'height', { get() { return w.innerHeight; }, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'offsetLeft', { value: 0, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'offsetTop', { value: 0, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'pageLeft', { value: 0, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'pageTop', { value: 0, configurable: true, enumerable: true });
        Object.defineProperty(inst, 'scale', { value: 1, configurable: true, enumerable: true });
      }
      singles.set(chain, inst);
    }
    return singles.get(chain);
  };
  for (const r of ['navigator', 'document', 'screen', 'performance']) OBJ.set(w[r], { chain: 'R:' + r, vals: S.values[r] });
  const winInfo = { chain: 'R:window', vals: S.values.window };
  OBJ.set(w, winInfo); if (w._globalProxy) OBJ.set(w._globalProxy, winInfo);
  const isWin = (x) => x === w || x === w._globalProxy || x === undefined;

  // giá trị dump ('number=5', 'boolean=true', 'string=…'(cắt 80), 'null', 'GPU'…) → undefined = không biết
  const NOPE = Symbol('nope');
  const parseVal = (s, chain) => {
    if (s === undefined || s === 'function' || s.startsWith('THROW')) return NOPE;
    if (s === 'undefined') return undefined;
    if (s === 'null') return null;
    const eq = s.indexOf('=');
    if (eq > 0) { const t = s.slice(0, eq), v = s.slice(eq + 1); return t === 'number' ? +v : t === 'boolean' ? v === 'true' : v.length >= 80 ? NOPE : v; }
    if (s === 'Array' || !/^[A-Z]/.test(s)) return NOPE;
    return single(s, chain);
  };

  // ---- serialize tham số (object tracked → chain) / materialize kết quả replay ----
  const serArg = (x, d = 0) => {
    if (x === undefined) return { u: 1 };
    if (typeof x === 'number') return Number.isFinite(x) && !Object.is(x, -0) ? x : { n: String(x) };
    if (typeof x === 'bigint') return { bi: String(x) };
    if (x === null || typeof x !== 'object' && typeof x !== 'function') return x;
    if (typeof x === 'function') return { fn: 1 };
    const o = OBJ.get(x); if (o) return { rc: o.chain };
    const tag = Object.prototype.toString.call(x).slice(8, -1);
    if (ArrayBuffer.isView(x)) return { ta: tag, d: Array.from(x) };
    if (tag === 'ArrayBuffer') return { ab: Array.from(new Uint8Array(x)) };
    if (d > 6) return { tag };
    if (Array.isArray(x)) return x.map((v) => serArg(v, d + 1));
    const p = Object.getPrototypeOf(x);
    if (p === null || p === w.Object.prototype || p === Object.prototype) { const r = {}; for (const k of Object.keys(x)) r[k] = serArg(x[k], d + 1); return { o: r }; }
    return { tag };
  };
  const mat = (r, chain) => {
    if (r === null || typeof r !== 'object') return r;
    if (Array.isArray(r)) return w.Array.from(r, (x, i) => mat(x, `${chain}/${i}`));
    if (r.u) return undefined;
    if ('n' in r) return Number(r.n);
    if ('bi' in r) return BigInt(r.bi);
    if (r.ta) return new w[r.ta](r.d);
    if (r.ab) return new w.Uint8Array(r.ab).buffer;
    if (r.fn) return mark(function () {});
    if (r.o) { const o = new w.Object(); for (const k of Object.keys(r.o)) o[k] = mat(r.o[k], `${chain}/${k}`); return o; }
    if (r.inst) return makeInst(r.inst, chain, { snap: r.snap, ml: r.ml });
    return undefined;
  };
  const err = (r, name) => (r.te ? new w.TypeError(r.msg || '') : new w.DOMException(r.msg || '', name));
  // phát sự kiện đã ghi trong replay (icecandidate, statechange, complete…) lên object tracked
  const scheduleEvents = (inst, evts, baseMs) => {
    const o = OBJ.get(inst);
    // mDNS UUID ngẫu nhiên per session để tránh fingerprint tĩnh
    if (o && !o._mdns) {
      o._mdns = require('crypto').randomUUID();
      for (const ev of evts) {
        if (ev.type === 'icecandidate' && ev.candidate) {
          const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.local/i.exec(ev.candidate.candidate || '');
          if (m) { o._mdnsOrig = m[1]; break; }
        }
      }
    }
    const mdnsRep = (s) => (o && o._mdnsOrig && s) ? s.replace(new RegExp(o._mdnsOrig, 'gi'), o._mdns) : (s || '');
    for (const ev of evts) {
      w.setTimeout(() => {
        try {
          // cập nhật snap để getter trả đúng state
          if (o) {
            if (ev.iceGatheringState !== undefined) (o.snap || (o.snap = {})).iceGatheringState = ev.iceGatheringState;
            if (ev.signalingState !== undefined) (o.snap || (o.snap = {})).signalingState = ev.signalingState;
            if (ev.connectionState !== undefined) (o.snap || (o.snap = {})).connectionState = ev.connectionState;
          }
          const domEv = new w.Event(ev.type, { bubbles: false, cancelable: false });
          if (ev.type === 'icecandidate') {
            const cand = ev.candidate == null ? null : (() => {
              const raw = ev.candidate;
              const candStr = mdnsRep(raw.candidate || '');
              // parse SDP candidate string: "candidate:<foundation> <component> <proto> <priority> <addr> <port> typ <type> ..."
              const parts = candStr.replace(/^candidate:/, '').split(' ');
              const foundation = parts[0] || '';
              const component = parts[1] != null ? +parts[1] : 1;
              const protocol = (parts[2] || '').toLowerCase();
              const priority = parts[3] != null ? +parts[3] : 0;
              const address = mdnsRep(parts[4] || '');
              const port = parts[5] != null ? +parts[5] : 0;
              const ti = parts.indexOf('typ'); const type = ti >= 0 ? parts[ti + 1] : '';
              const ri = parts.indexOf('raddr'); const relatedAddress = ri >= 0 ? parts[ri + 1] : null;
              const rpi = parts.indexOf('rport'); const relatedPort = rpi >= 0 ? +parts[rpi + 1] : null;
              const tci = parts.indexOf('tcptype'); const tcpType = tci >= 0 ? parts[tci + 1] : null;
              const snap = { candidate: candStr,
                sdpMid: raw.sdpMid != null ? String(raw.sdpMid) : null,
                sdpMLineIndex: raw.sdpMLineIndex != null ? raw.sdpMLineIndex : null,
                usernameFragment: raw.usernameFragment || null,
                foundation, component, protocol, priority, address, port,
                type, tcpType, relatedAddress, relatedPort };
              const c = makeInst('RTCIceCandidate', null, { snap });
              Object.defineProperty(c, 'toJSON', { value: mark(function() { return Object.assign({}, snap); }), writable: true, configurable: true });
              return c;
            })();
            try { Object.defineProperty(domEv, 'candidate', { value: cand, enumerable: true, configurable: true }); } catch (_) {}
          }
          // OfflineAudioContext complete: gắn renderedBuffer với channelData thật
          if (ev.type === 'complete' && ev.channelData) {
            try {
              const f32 = new w.Float32Array(ev.channelData);
              const fakeBuf = new w.Object();
              Object.defineProperty(fakeBuf, 'getChannelData', { value: mark(function() { return f32; }), configurable: true, writable: true });
              Object.defineProperty(fakeBuf, 'length', { value: f32.length, configurable: true });
              Object.defineProperty(fakeBuf, 'sampleRate', { value: ev.sampleRate || 44100, configurable: true });
              Object.defineProperty(fakeBuf, 'numberOfChannels', { value: 1, configurable: true });
              Object.defineProperty(domEv, 'renderedBuffer', { value: fakeBuf, enumerable: true, configurable: true });
            } catch (_) {}
          }
          // handler on*
          if (o && o.h && o.h['on' + ev.type]) { try { o.h['on' + ev.type].call(inst, domEv); } catch (_) {} }
          try { inst.dispatchEvent(domEv); } catch (_) {}
        } catch (_) {}
      }, Math.min(Math.max(ev.ms || 0, 0), 5000));
    }
  };
  const deliver = (r, key, self) => {
    if (r.thr) throw err(r, r.thr);
    if (!r.p) {
      const v = mat(r.v, key);
      if (r.ev && r.ev.length && self) scheduleEvents(self, r.ev, 0);
      return v;
    }
    return new w.Promise((res, rej) => w.setTimeout(() => {
      const v = r.rej ? undefined : mat(r.v, key);
      if (!r.rej && r.ev && r.ev.length && self) scheduleEvents(self, r.ev, 0);
      r.rej ? rej(err(r, r.rej)) : res(v);
    }, Math.min(r.ms || 0, 3000)));
  };

  // ---- fallback theo kiểu d.ts khi miss ----
  const typeOf = (iface, name, st, kind) => { const t = (st ? T.s : T.i)[iface]; return t && (kind === 'get' ? t.a[name] || t.m[name] : t.m[name]); };
  const fallback = (type, chain) => {
    if (!type) return undefined;
    const pm = /^Promise<(.+)>$/.exec(type.trim());
    if (pm) return w.Promise.resolve(fallback(pm[1], chain));
    const parts = type.split(' | ').map((s) => s.trim());
    const t = parts.find((p) => p !== 'null' && p !== 'undefined');
    if (!t) return parts.includes('null') ? null : undefined;
    if (/\[\]$|^(ReadonlyArray|FrozenArray|Array)</.test(t)) return w.Array.of();
    if (t === 'boolean') return false;
    if (t === 'number') return 0;
    if (t === 'string') return '';
    if (/^"/.test(t)) return JSON.parse(t);
    if (/^[A-Z]\w*$/.test(t) && S.ifaces[t] && typeof w[t] === 'function') return makeInst(t, chain, {});
    if (/^[A-Z]\w*$/.test(t) && typeof w[t] === 'function') try { return new w[t](); } catch (_) {}   // builtin JS (Float32Array, Map…)
    if (t === 'void' || t === 'undefined' || t === 'any') return undefined;
    return new w.Object();
  };

  // method luôn trả Promise<void> bất kể arg — chuẩn hoá args để key ổn định
  const NORM_VOID = { RTCPeerConnection: new Set(['setLocalDescription', 'setRemoteDescription', 'addIceCandidate']) };
  // ---- thao tác trên object → replay ----
  const op = (self, iface, st, kind, name, args) => {
    const o = st ? { chain: 'C:' + iface } : OBJ.get(self);
    const type = typeOf(iface, name, st, kind === 'new' ? 'call' : kind);
    if (!o) return kind === 'set' ? undefined : fallback(type, null);   // object không tracked (vd element jsdom)
    // chuẩn hoá arg dễ thay đổi (SDP, v.v.) để key không đổi mỗi lần — dùng [{}] để khớp key 4tgsecndni
    const normSet = !st && NORM_VOID[iface];
    const rawArgs = normSet && normSet.has(name) ? [{}] : args;
    const a = Array.from(rawArgs, (x) => serArg(x));
    const key = h53(JSON.stringify([o.chain, kind, name, a]));   // ponytail: không đếm lần gọi — cùng thao tác cùng tham số = cùng kết quả
    if (CALLREC) CALLREC.push({ key, t: o.chain, iface, st: st ? 1 : 0, kind, name, args: a });
    if (kind === 'set') return undefined;
    if (key in CALLS) { stats.hit++; return deliver(CALLS[key], key, kind === 'call' ? self : null); }
    stats.miss++; stats.missed.add(`${iface}.${name}`);
    return kind === 'new' ? makeInst(iface, key, {}) : fallback(type, key);
  };
  const illegal = () => new w.TypeError('Illegal invocation');
  const stubFn = (iface, k, len, st, proto) => {
    const f = own({ [k](...a) {
      if (!st && proto && !proto.isPrototypeOf(this) && !isWin(this)) throw illegal();
      const o = OBJ.get(this);
      if (o && o.ml && ML.has(k)) {   // maplike (KeyboardLayoutMap…) từ snapshot
        const m = new Map(o.ml);
        if (k === 'get') return m.get(a[0]);
        if (k === 'has') return m.has(a[0]);
        if (k === 'forEach') { m.forEach((v, kk) => a[0].call(a[1], v, kk, this)); return undefined; }
        return w.Array.from(k === 'keys' ? m.keys() : k === 'values' ? m.values() : o.ml.map((e) => w.Array.of(...e)))[w.Symbol.iterator]();
      }
      return op(this, iface, st, 'call', k, a);
    } }[k]);
    Object.defineProperty(f, 'length', { value: len || 0, configurable: true });
    return f;
  };
  const getterFn = (iface, k, st, proto) => own(Object.getOwnPropertyDescriptor({ get [k]() {
    if (!st && proto && !proto.isPrototypeOf(this) && !isWin(this)) throw illegal();
    const o = st ? null : OBJ.get(this);
    if (/^on/.test(k)) return (o && o.h && o.h[k]) || null;
    if (o && o.snap && k in o.snap) return mat(o.snap[k], `${o.chain}.${k}`);
    if (o && o.vals && k in o.vals) { const v = parseVal(o.vals[k], `${o.chain}.${k}`); if (v !== NOPE) return v; }
    if (o && o.ml && k === 'size') return o.ml.length;
    return op(this, iface, st, 'get', k, []);
  } }, k).get);
  const setterFn = (iface, k, st) => own(Object.getOwnPropertyDescriptor({ set [k](v) {
    const o = st ? null : OBJ.get(this);
    if (/^on/.test(k)) { if (o) (o.h || (o.h = {}))[k] = typeof v === 'function' ? v : null; }
    else if (o && (v === null || typeof v !== 'object' && typeof v !== 'function')) (o.snap || (o.snap = {}))[k] = serArg(v);
    op(this, iface, st, 'set', k, [v]);
  } }, k).set);
  const addProps = (target, list, iface, st, onlyMissing) => {
    const proto = st ? null : target;
    for (const [k, kind, en, conf, lenOrCls, val] of list) {
      if (k === 'constructor' || (onlyMissing && k in target)) continue;
      try {
        if (kind === 'f') Object.defineProperty(target, k, { value: stubFn(iface, k, lenOrCls, st, proto), writable: true, enumerable: !!en, configurable: !!conf });
        else if (kind === 'v') Object.defineProperty(target, k, { value: val !== undefined ? val : lenOrCls === 'null' ? null : undefined, writable: false, enumerable: !!en, configurable: !!conf });
        else Object.defineProperty(target, k, { get: kind.includes('g') ? getterFn(iface, k, st, proto) : undefined, set: kind.includes('s') ? setterFn(iface, k, st) : undefined, enumerable: !!en, configurable: !!conf });
      } catch (_) {}
    }
  };

  // frame cũng phải đủ bề mặt: CF so getOwnPropertyNames(window) với iframe sạch (khác nhau = global lạ). Chi phí do pool iframe (cf_dom) che.
  // ---- 2. interface thiếu (cha trước con) ----
  const pending = Object.keys(S.ifaces).filter((n) => !(n in w));
  const made = new Set();
  for (let guard = 0; pending.length && guard < 20; guard++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const name = pending[i], I = S.ifaces[name];
      if (I.parent && pending.includes(I.parent)) continue;   // đợi cha
      const Parent = I.parent && typeof w[I.parent] === 'function' ? w[I.parent] : null;
      const C = own(function (...a) {   // con: prototype P (realm page) chỉ chứa stub own + giá trị → bỏ qua cả nhánh an toàn
        if (I.ctor === 'illegal') throw new w.TypeError('Illegal constructor');
        if (!new.target) throw new w.TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
        const inst = op(null, name, true, 'new', 'new', a);
        if (inst && typeof inst === 'object' && new.target !== C) Object.setPrototypeOf(inst, new.target.prototype);
        return inst;
      }, name);
      Object.defineProperty(C, 'length', { value: I.len, configurable: true });
      Object.setPrototypeOf(C, Parent || WF.prototype);
      const P = O.create(Parent ? Parent.prototype : O.prototype);
      Object.defineProperty(C, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(P, 'constructor', { value: C, writable: true, enumerable: false, configurable: true });
      if (I.tag) Object.defineProperty(P, w.Symbol.toStringTag, { value: I.tag, configurable: true });
      addProps(P, I.proto, name, false, false);
      addProps(C, I.statics, name, true, false);
      Object.defineProperty(w, name, { value: C, writable: true, enumerable: false, configurable: true });
      made.add(name);
      pending.splice(i, 1);
    }
  }

  // ---- 3. thuộc tính thiếu trên prototype của interface sẵn có (jsdom) + method jsdom trả sai ----
  for (const [name, I] of Object.entries(S.ifaces)) {
    if (made.has(name) || typeof w[name] !== 'function' || !w[name].prototype) continue;
    addProps(w[name].prototype, I.proto, name, false, true);
    addProps(w[name], I.statics, name, true, true);
  }
  for (const [iface, ms] of Object.entries(PURE)) for (const k of ms) {
    const P = w[iface] && w[iface].prototype; if (!P) continue;
    const f = own({ [k](...a) { if (!P.isPrototypeOf(this)) throw illegal(); return op(PURE_OBJ(iface), iface, false, 'call', k, a); } }[k]);
    Object.defineProperty(f, 'length', { value: P[k] ? P[k].length : 1, configurable: true });
    Object.defineProperty(P, k, { value: f, writable: true, enumerable: true, configurable: true });
  }
  function PURE_OBJ(iface) { const c = 'P:' + iface; if (!singles.has(c)) { const x = new w.Object(); OBJ.set(x, { chain: c }); singles.set(c, x); } return singles.get(c); }

  // ---- 4. global object/hàm thiếu trên window ----
  for (const [k, kind, en, conf, lenOrCls, val] of S.window) {
    if (k in w || /^[A-Z]/.test(k)) continue;
    try {
      if (kind === 'f') Object.defineProperty(w, k, { value: stubFn('Window', k, lenOrCls, false, null), writable: true, enumerable: !!en, configurable: !!conf });
      else if (kind === 'v') Object.defineProperty(w, k, { value: val !== undefined ? val : lenOrCls === 'null' ? null : undefined, writable: true, enumerable: !!en, configurable: !!conf });
      else Object.defineProperty(w, k, { get: getterFn('Window', k, false, null), set: kind.includes('s') ? setterFn('Window', k, false) : undefined, enumerable: !!en, configurable: !!conf });
    } catch (_) {}
  }
  // namespace object thuần hằng số (GPUBufferUsage…; dump chrome_namespaces.json trong secure context)
  for (const [k, N] of Object.entries(NS)) {
    if (k in w || !/^GPU/.test(k)) continue;
    const o = O.create(O.prototype);
    for (const [p, , v, wr, en, cf] of N.props) Object.defineProperty(o, p, { value: v, writable: !!wr, enumerable: !!en, configurable: !!cf });
    Object.defineProperty(o, w.Symbol.toStringTag, { value: k, configurable: true });
    Object.defineProperty(w, k, { value: o, writable: !!N.desc[0], enumerable: !!N.desc[1], configurable: !!N.desc[2] });
  }
  if (log && process.env.SURFLOG) log(`[surface] +${made.size} interfaces; window own ${Object.getOwnPropertyNames(w).length}/${S.window.length}`);
}

module.exports = { installSurface, S };
