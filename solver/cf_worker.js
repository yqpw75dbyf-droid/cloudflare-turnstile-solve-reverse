'use strict';
// cf_worker.js — DedicatedWorkerGlobalScope emulation
// Cung cấp các API mà CF Turnstile worker dùng thực tế:
//   navigator.storage (OPFS in-memory), trustedTypes, locks, permissions, connection
// Export: buildWorkerGlobal({ navVals, langs }) → { navigator, trustedTypes }

function buildWorkerGlobal({ navVals, langs }) {
  // ---- in-memory OPFS --------------------------------------------------------
  // CF dùng: getDirectory() → getFileHandle({create:true}) → createSyncAccessHandle()
  //          → write(Uint8Array, {at:0}) → flush() → close()
  //          Kết quả mong đợi: postMessage({uUOw3: <flush_time_ms>})
  const opfsFiles = new Map(); // name → Buffer

  function toBuffer(d) {
    if (Buffer.isBuffer(d)) return d;
    if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    if (d instanceof ArrayBuffer) return Buffer.from(d);
    return Buffer.from(d);
  }

  class SyncHandle {
    constructor(name) {
      this._n = name;
      this._b = Buffer.from(opfsFiles.get(name) || []);
    }
    write(d, opts) {
      const at = (opts && opts.at != null) ? opts.at : 0;
      const src = toBuffer(d);
      const needed = at + src.length;
      if (needed > this._b.length) {
        const nb = Buffer.alloc(needed);
        this._b.copy(nb);
        this._b = nb;
      }
      src.copy(this._b, at);
      opfsFiles.set(this._n, Buffer.from(this._b));
      return src.length;
    }
    read(d, opts) {
      const at = (opts && opts.at != null) ? opts.at : 0;
      const dst = toBuffer(d);
      const n = Math.min(dst.length, Math.max(0, this._b.length - at));
      if (n > 0) this._b.copy(dst, 0, at, at + n);
      return n;
    }
    getSize() { return this._b.length; }
    truncate(sz) {
      const nb = Buffer.alloc(sz);
      this._b.copy(nb, 0, 0, Math.min(sz, this._b.length));
      this._b = nb;
      opfsFiles.set(this._n, Buffer.from(nb));
    }
    flush() {
      // ponytail: spin ~1ms để khớp Chrome OPFS flush timing (proof-of-space measurement uUOw3)
      const ms = 0.7 + Math.random() * 0.8;
      const t = performance.now(); while (performance.now() - t < ms) {}
    }
    close() { opfsFiles.set(this._n, Buffer.from(this._b)); }
  }

  const rootDir = {
    kind: 'directory', name: '',
    getFileHandle(name, opts) {
      if (opts && opts.create && !opfsFiles.has(name)) opfsFiles.set(name, Buffer.alloc(0));
      if (!opfsFiles.has(name)) {
        return Promise.reject(Object.assign(new Error(`No such file: ${name}`), { name: 'NotFoundError' }));
      }
      return Promise.resolve({
        kind: 'file', name,
        createSyncAccessHandle: () => Promise.resolve(new SyncHandle(name)),
        getFile: () => Promise.resolve(new Blob([opfsFiles.get(name)])),
      });
    },
    getDirectoryHandle: (_n, _o) => Promise.resolve(rootDir),
    removeEntry(name) { opfsFiles.delete(name); return Promise.resolve(); },
  };

  const storage = {
    getDirectory: () => Promise.resolve(rootDir),
    estimate: () => Promise.resolve({ usage: 0, quota: 1099511627776 }),
  };

  // ---- TrustedTypes ----------------------------------------------------------
  // worker bootstrapper: if(self.trustedTypes) createPolicy('FHMZS9', {createScript:s=>s})
  const trustedTypes = {
    createPolicy(name, rules) {
      return {
        createScript: typeof rules.createScript === 'function' ? rules.createScript : (s => s),
        createHTML: typeof rules.createHTML === 'function' ? rules.createHTML : (s => s),
        createScriptURL: typeof rules.createScriptURL === 'function' ? rules.createScriptURL : (s => s),
      };
    },
    isScript: () => false,
    isHTML: () => false,
    isScriptURL: () => false,
    defaultPolicy: null,
    getAttributeType: () => null,
    getPropertyType: () => null,
  };

  // ---- Web Locks stub --------------------------------------------------------
  const locks = {
    request(name, a, b) {
      const [opts, cb] = typeof a === 'function' ? [{}, a] : [a || {}, b];
      const lock = { name, mode: (opts && opts.mode) || 'exclusive' };
      return Promise.resolve().then(() => cb(lock));
    },
    query: () => Promise.resolve({ held: [], pending: [] }),
  };

  // ---- Permissions stub ------------------------------------------------------
  const permissions = {
    query: (d) => Promise.resolve({ state: 'granted', name: (d && d.name) || '', onchange: null }),
  };

  // ---- NetworkInformation stub -----------------------------------------------
  const connection = {
    // ponytail: Chrome đo được trên máy này: downlink=1.4 Mbps, rtt=100ms (cả hai là bội 25 như Chrome làm tròn)
    effectiveType: '4g', downlink: 1.4, rtt: 100, saveData: false,
    type: 'wifi', downlinkMax: Infinity, onchange: null,
  };

  // ---- navigator (WorkerNavigator) -------------------------------------------
  const navigator = {
    userAgent: navVals.userAgent,
    appVersion: navVals.appVersion || String(navVals.userAgent).replace(/^Mozilla\//, ''),
    platform: navVals.platform || 'Win32',
    language: langs[0] || 'en-US',
    languages: [...langs],
    hardwareConcurrency: navVals.hardwareConcurrency || 8,
    deviceMemory: navVals.deviceMemory || 8,
    onLine: true,
    storage,
    locks,
    permissions,
    connection,
    sendBeacon: () => false,
  };

  return { navigator, trustedTypes };
}

module.exports = { buildWorkerGlobal };
