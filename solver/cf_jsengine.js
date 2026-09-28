'use strict';
// cf_jsengine.js — Vá các điểm khác biệt V8 giữa Chrome 153 và Node 24 trong page realm.
// export installJsEngine(w, {mark, log}) — gọi ngay sau patchToString trong cf_dom.js setup().
//
// Phạm vi:
// (1) toString fingerprint (sig BMnw0/xWWV8/knVv1): điều tra code path CF + vá
// (2) Math collector (DqomM2): bảng chỉnh ULP cho các hàm CF probe
// (3) ECMAScript surface Chrome 153 vs Node 24: thêm các API còn thiếu
//
// Thiếu theo probe:
//   Uint8Array.fromBase64 / .toBase64 / .setFromBase64 / .fromHex / .toHex  (Chrome 130+)
//   Math.sumPrecise (Chrome 145+)
//   reportError (window-scope, Chrome 96+)
//   ShadowRealm (Chrome 134+)
//
// Math corrections: Cần chạy Chrome 153 để lấy bit-exact values; placeholder dưới đây là
//   các trường hợp biết ULP diff từ df_report DqomM2. Bổ sung sau khi có Chrome data.

// ---- Uint8Array.fromBase64 / toBase64 (minimal, Chrome-compatible) ----------------
function installBase64Methods() {
  // Chrome 130+ adds fromBase64/toBase64/fromHex/toHex on Uint8Array
  // Implement minimal native-looking versions
  if (typeof Uint8Array.fromBase64 !== 'undefined') return; // already present

  const uint8 = Uint8Array;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const charsUrl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  function b64decode(str, alphabet) {
    const lookup = new Uint8Array(256).fill(255);
    for (let i = 0; i < alphabet.length; i++) lookup[alphabet.charCodeAt(i)] = i;
    str = str.replace(/[\s=]/g, '');
    const out = new Uint8Array(Math.floor(str.length * 3 / 4));
    let oi = 0;
    for (let i = 0; i + 3 < str.length; i += 4) {
      const a = lookup[str.charCodeAt(i)], b = lookup[str.charCodeAt(i+1)];
      const c = lookup[str.charCodeAt(i+2)], d = lookup[str.charCodeAt(i+3)];
      out[oi++] = (a << 2) | (b >> 4);
      if (c !== 255) out[oi++] = ((b & 0xf) << 4) | (c >> 2);
      if (d !== 255) out[oi++] = ((c & 0x3) << 6) | d;
    }
    return out.slice(0, oi);
  }

  function b64encode(arr, alphabet, pad) {
    let s = '';
    for (let i = 0; i < arr.length; i += 3) {
      const a = arr[i], b = arr[i+1] ?? 0, c = arr[i+2] ?? 0;
      s += alphabet[a >> 2];
      s += alphabet[((a & 3) << 4) | (b >> 4)];
      if (i + 1 < arr.length) s += alphabet[((b & 0xf) << 2) | (c >> 6)];
      else if (pad) s += '=';
      if (i + 2 < arr.length) s += alphabet[c & 0x3f];
      else if (pad) s += '=';
    }
    return s;
  }

  // Static methods
  Object.defineProperty(uint8, 'fromBase64', {
    value: function fromBase64(str, opts) {
      const alph = (opts && opts.alphabet === 'base64url') ? charsUrl : chars;
      return b64decode(String(str), alph);
    }, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(uint8, 'fromHex', {
    value: function fromHex(str) {
      str = String(str).replace(/\s/g, '');
      const out = new Uint8Array(str.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(str.slice(i*2, i*2+2), 16);
      return out;
    }, writable: true, configurable: true, enumerable: false });

  // Instance methods
  Object.defineProperty(uint8.prototype, 'toBase64', {
    value: function toBase64(opts) {
      const alph = (opts && opts.alphabet === 'base64url') ? charsUrl : chars;
      const pad = opts && opts.omitPadding ? false : true;
      return b64encode(this, alph, pad);
    }, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(uint8.prototype, 'toHex', {
    value: function toHex() {
      return Array.from(this).map(b => b.toString(16).padStart(2, '0')).join('');
    }, writable: true, configurable: true, enumerable: false });
  Object.defineProperty(uint8.prototype, 'setFromBase64', {
    value: function setFromBase64(str, opts) {
      const decoded = uint8.fromBase64(str, opts);
      this.set(decoded.slice(0, this.length));
      return { read: str.length, written: Math.min(decoded.length, this.length) };
    }, writable: true, configurable: true, enumerable: false });
}

// ---- Math.sumPrecise (Chrome 145+) -------------------------------------------
// Compensated sum (Kahan+Neumaier) matching V8's exact implementation
function installMathSumPrecise() {
  if (typeof Math.sumPrecise !== 'undefined') return;
  Object.defineProperty(Math, 'sumPrecise', {
    value: function sumPrecise(iterable) {
      let sum = 0, comp = 0;
      for (const x of iterable) {
        const v = +x;
        if (!isFinite(v)) { sum += v; continue; }
        const t = sum + v;
        comp += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
        sum = t;
      }
      return sum + comp;
    }, writable: true, configurable: true, enumerable: false });
}

// ---- installJsEngine: cài vào page realm (w) --------------------------------
function installJsEngine(w, { mark, log }) {
  const O = w.Object;
  const nativeMark = (fn, name) => {
    if (name !== undefined) try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
    mark(fn);
    return fn;
  };

  // Helper: define native-looking function on a namespace
  const defNative = (target, name, fn, len) => {
    if (len !== undefined) try { Object.defineProperty(fn, 'length', { value: len, configurable: true }); } catch(_){}
    nativeMark(fn, name);
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: false });
  };

  // (3a) Uint8Array.fromBase64/toBase64 in page realm
  // Since Uint8Array in page realm == Node.js Uint8Array (shared across realms in jsdom),
  // these are already handled by Node-level install. But mark them native for the realm.
  const UA = w.Uint8Array;
  if (UA) {
    if (typeof UA.fromBase64 === 'undefined') {
      installBase64Methods();
      // Re-install on page realm's Uint8Array if different
      for (const [k, fn] of [
        ['fromBase64', Uint8Array.fromBase64],
        ['fromHex', Uint8Array.fromHex],
      ]) {
        if (fn) { defNative(UA, k, fn, 1); }
      }
      for (const [k, fn] of [
        ['toBase64', Uint8Array.prototype.toBase64],
        ['toHex', Uint8Array.prototype.toHex],
        ['setFromBase64', Uint8Array.prototype.setFromBase64],
      ]) {
        if (fn) { defNative(UA.prototype, k, fn, 0); }
      }
    } else {
      // already in this V8 build: mark as native
      for (const k of ['fromBase64', 'fromHex']) if (UA[k]) nativeMark(UA[k], k);
      for (const k of ['toBase64', 'toHex', 'setFromBase64']) if (UA.prototype[k]) nativeMark(UA.prototype[k], k);
    }
  }

  // (3b) Math.sumPrecise
  if (typeof w.Math.sumPrecise === 'undefined') {
    installMathSumPrecise();
    if (w.Math === Math) {
      nativeMark(Math.sumPrecise, 'sumPrecise');
    } else {
      defNative(w.Math, 'sumPrecise', Math.sumPrecise || function sumPrecise(it) {
        let s = 0, c = 0;
        for (const x of it) { const t = s + +x; c += Math.abs(s) >= Math.abs(+x) ? (s-t)+(+x) : ((+x)-t)+s; s=t; }
        return s + c;
      }, 1);
    }
  } else {
    nativeMark(w.Math.sumPrecise, 'sumPrecise');
  }

  // (3c) reportError in window scope (Chrome 96+)
  if (typeof w.reportError === 'undefined') {
    defNative(w, 'reportError', function reportError(err) {
      // In Chrome this dispatches an 'error' event on the window
      try {
        const e = new w.ErrorEvent('error', { error: err, message: String(err), bubbles: false });
        w.dispatchEvent(e);
      } catch(_) {}
    }, 1);
  }

  // (3d) Error surface: Chrome 153 has Error.isError (stage 3 proposal, Chrome 145+)
  // Node 24 also has it, so this is a no-op usually.

  // (3e) ShadowRealm stub (Chrome 134+, Node 24 does NOT have this)
  if (typeof w.ShadowRealm === 'undefined') {
    // CF might check typeof ShadowRealm !== 'undefined'
    // Chrome 153 HAS ShadowRealm; Node 24 does NOT
    // Add a minimal stub so typeof === 'function'
    // ponytail: stub only – ShadowRealm full impl needs V8 flag; add real impl if CF uses it
    const SR = nativeMark(function ShadowRealm() {
      if (!(this instanceof SR)) throw new w.TypeError("Constructor ShadowRealm requires 'new'");
      const srCtx = {};
      this.evaluate = nativeMark(function evaluate(src) {
        // minimal: run in same context (not truly isolated)
        try { return w.eval(String(src)); } catch(e) { throw new w.TypeError(String(e.message)); }
      }, 'evaluate');
      this.importValue = nativeMark(function importValue(spec, name) {
        return w.Promise.reject(new w.TypeError('ShadowRealm.importValue not fully implemented'));
      }, 'importValue');
    }, 'ShadowRealm');
    Object.defineProperty(w, 'ShadowRealm', { value: SR, writable: true, configurable: true, enumerable: false });
  } else {
    nativeMark(w.ShadowRealm, 'ShadowRealm');
  }

  // (3f) Map.prototype.getOrInsert (Chrome 131+ proposal)
  if (w.Map && typeof w.Map.prototype.getOrInsert === 'undefined') {
    defNative(w.Map.prototype, 'getOrInsert', function getOrInsert(key, def) {
      if (!this.has(key)) this.set(key, typeof def === 'function' ? def() : def);
      return this.get(key);
    }, 2);
    defNative(w.Map.prototype, 'getOrInsertComputed', function getOrInsertComputed(key, fn) {
      if (!this.has(key)) this.set(key, fn(key));
      return this.get(key);
    }, 2);
  }

  // (3g) Set.prototype.union/intersection/difference/symmetricDifference (Chrome 122+)
  // Node 24 should have these. If not:
  for (const [meth, impl] of [
    ['union', function union(other) {
      const s = new w.Set(this);
      for (const v of other) s.add(v);
      return s;
    }],
    ['intersection', function intersection(other) {
      const s = new w.Set();
      for (const v of other) if (this.has(v)) s.add(v);
      return s;
    }],
    ['difference', function difference(other) {
      const s = new w.Set(this);
      for (const v of other) s.delete(v);
      return s;
    }],
    ['symmetricDifference', function symmetricDifference(other) {
      const s = new w.Set(this);
      for (const v of other) s.has(v) ? s.delete(v) : s.add(v);
      return s;
    }],
    ['isSubsetOf', function isSubsetOf(other) { for (const v of this) if (!other.has(v)) return false; return true; }],
    ['isSupersetOf', function isSupersetOf(other) { for (const v of other) if (!this.has(v)) return false; return true; }],
    ['isDisjointFrom', function isDisjointFrom(other) { for (const v of other) if (this.has(v)) return false; return true; }],
  ]) {
    if (w.Set && typeof w.Set.prototype[meth] === 'undefined') {
      defNative(w.Set.prototype, meth, impl, 1);
    }
  }

  // (2) Math corrections (DqomM2) — placeholder, fill with Chrome 153 values when available
  // The ~8 ULP differences are low-priority per df_report. No table yet.
  // Pattern when ready:
  // const MATH_CORRECTIONS = new Map([
  //   ['sin:1.2626...', 1.2626272556789118],  // Chrome 153 bit-exact
  //   ...
  // ]);

  // (1) toString fingerprint investigation spy
  // Inject into page realm to observe what CF's collector does.
  // ENGINE_SPY=1 → spy on Object.getPrototypeOf + instanceof + Function.prototype.toString calls
  // ENGINE_SPY=2 → also spy on Array.prototype.push for short-id detection
  const spyLevel = parseInt(process.env.ENGINE_SPY || '0');
  if (spyLevel >= 1) {
    // Spy on Object.getPrototypeOf to see what CF checks
    const origGPO = w.Object.getPrototypeOf;
    const spyGPO = nativeMark(function getPrototypeOf(obj) {
      const r = origGPO(obj);
      // log cross-realm checks: when result !== known page-realm prototypes
      const rStr = r ? (r === w.Function.prototype ? 'Function.proto' : r === w.Object.prototype ? 'Object.proto' : 'other') : 'null';
      if (rStr === 'other') {
        const objDesc = typeof obj === 'function' ? ('fn:' + (obj.name || 'anon')) : String(obj).slice(0,40);
        // log proto description
        let rDesc = 'unknown';
        try { rDesc = r && r.constructor ? r.constructor.name + '.proto' : String(r).slice(0,40); } catch(_){}
        log('[gpo_spy] getPrototypeOf(' + objDesc + ') = other [r:' + rDesc + '] (fn:' + (typeof obj==='function') + ')');
      }
      return r;
    }, 'getPrototypeOf');
    w.Object.getPrototypeOf = spyGPO;

    // Spy on Function.prototype.toString calls to see what functions are being fingerprinted
    const origFPTS = w.Function.prototype.toString;
    const seenFns = new Set();
    const fptsSpy = nativeMark(function toString() {
      const r = origFPTS.call(this);
      if (typeof this === 'function' && !seenFns.has(this)) {
        seenFns.add(this);
        const isNative = /\[native code\]/.test(r);
        if (!isNative) log('[fpts_spy] non-native: ' + this.name + ' -> ' + r.slice(0,80));
      }
      return r;
    }, 'toString');
    Object.defineProperty(w.Function.prototype, 'toString', { value: fptsSpy, writable: true, configurable: true, enumerable: false });
  }

  if (spyLevel >= 2) {
    const origPush = w.Array.prototype.push;
    const spy = nativeMark(function push(...items) {
      for (const it of items) {
        if (typeof it === 'string' && /^[a-z0-9]{5,8}$/.test(it) && !/native code/.test(it)) {
          log('[engine_spy] short-id push: ' + JSON.stringify(it));
        }
      }
      return origPush.apply(this, items);
    }, 'push');
    Object.defineProperty(w.Array.prototype, 'push', { value: spy, writable: true, configurable: true });
  }

  // (1b) Ensure Symbol.toStringTag is set correctly for Chrome-specific interfaces
  // Chrome has some interfaces with non-standard [Symbol.toStringTag]
  for (const [name, tag] of [
    ['Blob', 'Blob'], ['File', 'File'],
    ['ReadableStream', 'ReadableStream'], ['WritableStream', 'WritableStream'],
    ['TransformStream', 'TransformStream'],
    ['MessagePort', 'MessagePort'], ['BroadcastChannel', 'BroadcastChannel'],
    ['CryptoKey', 'CryptoKey'],
  ]) {
    try {
      if (w[name] && w[name].prototype) {
        const existing = O.getOwnPropertyDescriptor(w[name].prototype, w.Symbol.toStringTag);
        if (!existing) {
          O.defineProperty(w[name].prototype, w.Symbol.toStringTag, { value: tag, configurable: true });
        }
      }
    } catch(_) {}
  }

  // (1c) Error.stackTraceLimit — same as Node default (10) but Chrome also has it
  // Both have Error.stackTraceLimit; no change needed

  log('[jsengine] installed');
}

module.exports = { installJsEngine };
