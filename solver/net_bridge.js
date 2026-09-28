'use strict';
/**
 * net_bridge.js — installs fake XMLHttpRequest / fetch / navigator.sendBeacon
 * into a vm sandbox, routing all HTTP through net_bridge_server.py (curl_cffi).
 *
 * Usage:
 *   const { installNetworking } = require('./net_bridge');
 *   installNetworking(sandbox, { referer, origin, impersonate, proxy });
 *   vm.runInNewContext(cfCode, sandbox);
 */

const { execFileSync } = require('child_process');

const BRIDGE_URL = process.env.NET_BRIDGE_URL || 'http://127.0.0.1:5091/req';
// solve_id: bridge dùng session curl_cffi riêng mỗi solve → chạy song song không đè cookie.
// Theo từng request (req.solve_id) vì 1 worker tái sử dụng chạy nhiều solve nối tiếp; env chỉ là fallback khi chạy lẻ.
const withSid = (req) => ({ ...req, solve_id: req.solve_id || process.env.SOLVE_ID || '' });

// Dưới cf_host.js (CF_BRIDGE_IPC=1): request đi worker → host → Python qua IPC + pipe sẵn có, KHÔNG mở TCP mỗi request.
// Tải cao (300 luồng) mỗi request 1 kết nối tới Flask → tràn backlog + hết cổng tạm (TIME_WAIT 120s) → ECONNREFUSED;
// IPC còn bỏ luôn chi phí Flask/thread ~3-7ms CPU Python mỗi request. Chạy lẻ (không host) vẫn đi HTTP như cũ.
const bridgeOp = (() => {
  if (process.env.CF_BRIDGE_IPC !== '1') return null;
  const { parentPort } = require('worker_threads');
  const post = parentPort ? (m) => parentPort.postMessage(m) : process.send ? (m) => process.send(m) : null;
  if (!post) return null;
  const wait = new Map(); let seq = 0;
  const onMsg = (m) => { const a = m && m.a, cb = a && wait.get(a.qid); if (cb) { wait.delete(a.qid); cb(a); } };
  if (parentPort) parentPort.on('message', onMsg); else process.on('message', onMsg);
  return (op, payload) => new Promise((resolve) => { const qid = ++seq; wait.set(qid, resolve); post({ q: { ...payload, op, qid } }); });
})();

// ponytail: spawns curl per call — chỉ còn dùng cho script Worker không phải blob (hiếm); đường chính đi callBridgeAsync
function callBridge(req) {
  const payload = JSON.stringify(withSid(req));
  const out = execFileSync(
    'curl',
    ['-s', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', BRIDGE_URL],
    { input: payload, timeout: 170000, maxBuffer: 32 * 1024 * 1024 }
  );
  return dump(req, JSON.parse(out.toString()));
}
// không chặn event loop (Chrome vẫn chạy timer trong lúc request đang bay)
// CF_DUMP_DIR=<dir>: ghi mọi request/response qua bridge (fixture cho port Rust) — <dir>/net.jsonl
const DUMP = process.env.CF_DUMP_DIR ? (require('fs').mkdirSync(process.env.CF_DUMP_DIR, { recursive: true }), require('path').join(process.env.CF_DUMP_DIR, 'net.jsonl')) : null;
// + rand.jsonl: mọi crypto.getRandomValues của trang (hook ở impl jsdom, trang không thấy) — để kiểm mã hoá payload (RSA/XTEA)
if (DUMP) {
  const CI = require('jsdom/lib/jsdom/living/crypto/Crypto-impl.js').implementation, g = CI.prototype.getRandomValues;
  const RAND = require('path').join(process.env.CF_DUMP_DIR, 'rand.jsonl');
  CI.prototype.getRandomValues = function (a) { const r = g.call(this, a); try { require('fs').appendFileSync(RAND, JSON.stringify({ t: Date.now(), type: a.constructor.name, len: a.byteLength, hex: Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex') }) + '\n'); } catch (_) {} return r; };
}
const dump = (req, res) => { if (DUMP) try { require('fs').appendFileSync(DUMP, JSON.stringify({ t: Date.now(), req, res }) + '\n'); } catch (_) {} return res; };
const callBridgeAsync = (req) => (bridgeOp ? bridgeOp('req', withSid(req))
  : fetch(BRIDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withSid(req)), signal: AbortSignal.timeout(170000) }).then((r) => r.json()))
  .then((res) => dump(req, res));


// fetch-metadata + referrer-policy (trang challenge: Referrer-Policy: same-origin) + lọc response header theo spec
const siteOf = (h) => h.split('.').slice(-2).join('.');
function reqMeta(url, origin) {
  let so = false, ss = false;
  try { const u = new URL(url), o = new URL(origin); so = u.origin === o.origin; ss = so || (u.protocol === o.protocol && siteOf(u.hostname) === siteOf(o.hostname)); } catch (_) {}
  return { sameOrigin: so, site: so ? 'same-origin' : ss ? 'same-site' : 'cross-site' };
}
const CORS_SAFE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
function exposedHeaders(h, sameOrigin) {
  const all = Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]).filter(([k]) => k !== 'set-cookie' && k !== 'set-cookie2');
  if (sameOrigin) return all;
  const ex = new Set(((all.find(([k]) => k === 'access-control-expose-headers') || [])[1] || '').toLowerCase().split(',').map((x) => x.trim()));
  return all.filter(([k]) => CORS_SAFE.has(k) || ex.has(k) || ex.has('*'));
}

function toBase64(body) {
  if (body == null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf-8').toString('base64');
  if (Buffer.isBuffer(body)) return body.toString('base64');
  // Uint8Array / ArrayBuffer / DataView
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('base64');
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString('base64');
  return Buffer.from(String(body), 'utf-8').toString('base64');
}

/**
 * installNetworking(sandbox, opts)
 *
 * opts:
 *   referer     {string}  — Referer header for all requests
 *   origin      {string}  — Origin header for POST requests
 *   impersonate {string}  — curl_cffi impersonate target (default: chrome136)
 *   proxy       {string}  — proxy URL (default: bridge server reads CF_PROXY env)
 *   bridgeUrl   {string}  — override BRIDGE_URL
 */
function installNetworking(sandbox, opts = {}) {
  const {
    referer    = '',
    origin     = '',
    impersonate = 'chrome136',
    proxy       = undefined,
    bridgeUrl   = BRIDGE_URL,
    solveId     = '',
  } = opts;

  function bridgeReq(req) {
    if (bridgeUrl !== BRIDGE_URL) {
      // per-call override (rare)
      const payload = JSON.stringify(req);
      const out = execFileSync(
        'curl',
        ['-s', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', bridgeUrl],
        { input: payload, timeout: 170000, maxBuffer: 32 * 1024 * 1024 }
      );
      return JSON.parse(out.toString());
    }
    return callBridge(req);
  }

  // ── XMLHttpRequest ────────────────────────────────────────────────────────
  function FakeXHR() {
    this.readyState  = 0;   // UNSENT
    this.status      = 0;
    this.statusText  = '';
    this.responseText= '';
    this.response    = '';
    this.responseURL = '';
    this.onreadystatechange = null;
    this.onload      = null;
    this.onloadend   = null;
    this.onerror     = null;
    this.ontimeout   = null;
    this._method     = 'GET';
    this._url        = '';
    this._reqHeaders = {};
    this._respHeaders= {};
    this._listeners  = {};
    // copy opts into closure so inner methods can see them
    this._impersonate = impersonate;
    this._proxy       = proxy;
    this._referer     = referer;
    this._origin      = origin;
  }

  // static constants
  FakeXHR.UNSENT           = 0;
  FakeXHR.OPENED           = 1;
  FakeXHR.HEADERS_RECEIVED = 2;
  FakeXHR.LOADING          = 3;
  FakeXHR.DONE             = 4;

  FakeXHR.prototype.open = function (method, url, async) {
    this._method = (method || 'GET').toUpperCase();
    this._url    = new URL(String(url), this._referer || undefined).href;   // resolve URL tương đối theo document
    this._async  = async !== false;
    this._reqHeaders = {};
    this._respHeaders= {};
    this.readyState = 1;
    this._fire('readystatechange');
  };

  FakeXHR.prototype.setRequestHeader = function (name, value) {
    this._reqHeaders[name] = value;
  };

  FakeXHR.prototype.send = function (body) {
    // async như Chrome: send() trả về ngay, event bắn ở task sau
    if (this._async) { setTimeout(() => this._doSend(body), 0); return; }
    this._doSend(body);
  };

  FakeXHR.prototype._doSend = function (body) {
    // Build default headers — CF code sets most of its own headers via setRequestHeader
    const m = reqMeta(this._url, this._origin);
    this._sameOrigin = m.sameOrigin;
    const defaultHeaders = { 'Accept': '*/*', 'Sec-Fetch-Site': m.site, 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
    if (this._referer && m.sameOrigin) defaultHeaders['Referer'] = this._referer;   // Referrer-Policy: same-origin
    if (this._origin && (!m.sameOrigin || (this._method !== 'GET' && this._method !== 'HEAD'))) defaultHeaders['Origin'] = this._origin;
    const headers = Object.assign({}, defaultHeaders, this._reqHeaders);
    if (process.env.NETLOG) console.log(`[xhr] ${this._method} ${this._url} body=${body == null ? 0 : (body.length || body.byteLength || 0)}`);

    try {
      const result = bridgeReq({
        method:      this._method,
        url:         this._url,
        headers,
        body:        toBase64(body),
        impersonate: this._impersonate,
        proxy:       this._proxy || null,
      });

      if (result.error) throw new Error(result.error);

      this.status       = result.status;
      this.statusText   = String(result.status);
      this.responseURL  = this._url;
      this.responseText = Buffer.from(result.body || '', 'base64').toString('utf-8');
      this.response     = this.responseText;
      this._respHeaders = Object.fromEntries(exposedHeaders(result.headers, this._sameOrigin));
      if (process.env.NETLOG) console.log(`[xhr] <- ${this.status} len=${this.responseText.length} ${this._url.slice(0, 110)}`);
    } catch (e) {
      if (process.env.NETLOG) console.log(`[xhr] !! ${e.message} ${this._url.slice(0, 110)}`);
      this.status = 0;
      this.readyState = 4;
      this._fire('readystatechange');
      this._fire('error');
      this._fire('loadend');
      return;
    }

    this.readyState = 4;
    this._fire('readystatechange');
    this._fire('load');
    this._fire('loadend');
  };

  FakeXHR.prototype._fire = function (type) {
    if (type === 'readystatechange' && typeof this.onreadystatechange === 'function') {
      this.onreadystatechange.call(this);
    }
    if (type === 'load'    && typeof this.onload    === 'function') this.onload.call(this);
    if (type === 'loadend' && typeof this.onloadend === 'function') this.onloadend.call(this);
    if (type === 'error'   && typeof this.onerror   === 'function') this.onerror.call(this);
    const list = this._listeners[type];
    if (list) list.forEach(fn => fn.call(this));
  };

  FakeXHR.prototype.addEventListener = function (type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };

  FakeXHR.prototype.removeEventListener = function (type, fn) {
    if (this._listeners[type]) {
      this._listeners[type] = this._listeners[type].filter(f => f !== fn);
    }
  };

  FakeXHR.prototype.abort = function () {
    this.readyState = 0;
  };

  FakeXHR.prototype.getResponseHeader = function (name) {
    if (!name) return null;
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(this._respHeaders)) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  };

  FakeXHR.prototype.getAllResponseHeaders = function () {
    return Object.entries(this._respHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
  };

  FakeXHR.prototype.overrideMimeType = function () {};  // noop

  // ── fetch ─────────────────────────────────────────────────────────────────
  // async như Chrome: request chạy ở task sau, không block tick hiện tại
  function fakeFetch(url, options) {
    return fetchNow(url, options).catch(() => { throw new TypeError('Failed to fetch'); });
  }
  async function fetchNow(url, options) {
    options = options || {};
    url = new URL(String(url), referer || undefined).href;
    const method  = (options.method || 'GET').toUpperCase();
    const { sameOrigin, site } = reqMeta(url, origin);
    const reqHdrs = Object.assign(
      { 'Accept': '*/*', 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': options.mode || 'cors', 'Sec-Fetch-Dest': 'empty' },
      options.cache === 'no-cache' || options.cache === 'reload' ? { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } : {},
      referer && sameOrigin ? { Referer: referer } : {},
      origin && (method !== 'GET' && method !== 'HEAD' || !sameOrigin) ? { Origin: origin } : {},
      options.headers || {}
    );
    if (process.env.NETLOG) console.log(`[fetch] ${method} ${url.slice(0, 140)}`);
    const result = await callBridgeAsync({
      method,
      url,
      headers: reqHdrs,
      body:    toBase64(options.body || null),
      impersonate,
      proxy: proxy || null,
      solve_id: solveId,
    });
    if (result.error) throw new Error(result.error);
    if (process.env.NETLOG) console.log(`[fetch] <- ${result.status} ${url.slice(0, 100)}`);

    const respBody  = result.body || '';
    const respText  = Buffer.from(respBody, 'base64').toString('utf-8');
    const respHdrs  = result.headers || {};
    // Headers-like đủ API (forEach/entries/keys/values/has/get/iterator), key lowercase + sort như Fetch spec
    const hl = exposedHeaders(respHdrs, sameOrigin).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const hdrsObj   = {
      get: (n) => { const e = hl.find(([k]) => k === String(n).toLowerCase()); return e ? e[1] : null; },
      has: (n) => hl.some(([k]) => k === String(n).toLowerCase()),
      forEach(cb, thisArg) { hl.forEach(([k, v]) => cb.call(thisArg, v, k, hdrsObj)); },
      entries: () => hl.map((e) => e.slice())[Symbol.iterator](),
      keys: () => hl.map(([k]) => k)[Symbol.iterator](),
      values: () => hl.map(([, v]) => v)[Symbol.iterator](),
      [Symbol.iterator]: () => hl.map((e) => e.slice())[Symbol.iterator](),
    };

    return {
      status:  result.status,
      statusText: '',
      ok:      result.status >= 200 && result.status < 300,
      redirected: false,
      type:    sameOrigin ? 'basic' : 'cors',
      url,
      headers: hdrsObj,
      text:        () => Promise.resolve(respText),
      json:        () => Promise.resolve(JSON.parse(respText)),
      arrayBuffer: () => Promise.resolve(new Uint8Array(Buffer.from(respBody, 'base64')).buffer),   // không dùng .buffer của Buffer (pool 8KB)
      blob:        () => Promise.resolve(new Uint8Array(Buffer.from(respBody, 'base64'))),
    };
  }

  // ── navigator.sendBeacon ─────────────────────────────────────────────────
  function fakeSendBeacon(url, data) {
    url = new URL(String(url), referer || undefined).href;
    const { sameOrigin, site } = reqMeta(url, origin);
    const headers = Object.assign({ 'Accept': '*/*', 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'empty', 'Origin': origin },
      typeof data === 'string' ? { 'Content-Type': 'text/plain;charset=UTF-8' } : {}, referer && sameOrigin ? { Referer: referer } : {});
    if (process.env.NETLOG) console.log(`[beacon] POST ${url.slice(0, 140)}`);
    callBridgeAsync({ method: 'POST', url, headers, body: toBase64(data), impersonate, proxy: proxy || null, solve_id: solveId }).catch(() => {});
    return true;
  }

  // ── install into sandbox ──────────────────────────────────────────────────
  sandbox.XMLHttpRequest = FakeXHR;
  sandbox.fetch          = fakeFetch;

  if (!sandbox.navigator) sandbox.navigator = {};
  sandbox.navigator.sendBeacon = fakeSendBeacon;

  // some CF code checks these on XHR constructor
  sandbox.XMLHttpRequest.UNSENT           = 0;
  sandbox.XMLHttpRequest.OPENED           = 1;
  sandbox.XMLHttpRequest.HEADERS_RECEIVED = 2;
  sandbox.XMLHttpRequest.LOADING          = 3;
  sandbox.XMLHttpRequest.DONE             = 4;
}

module.exports = { installNetworking, callBridge, callBridgeAsync, bridgeOp, reqMeta, exposedHeaders, toBase64 };
