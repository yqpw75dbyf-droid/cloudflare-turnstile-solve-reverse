'use strict';
// cf_media.js — <link rel=preload as=image> + <img src> loading cho jsdom (không dùng canvas).
// Dùng _attrModified (sync) để bắt URL khi CF set attribute.
// ONE request per URL (preload cache). Gắn vào img wrapper → load/error events đúng lúc.
// Xuất installMedia(w, opts) — gọi từ cf_dom.js setup() sau khi mkRTE/RTING/RT_OBS sẵn sàng.

const path = require('path');

// jsdom paths
const JD = path.dirname(require.resolve('jsdom/package.json', { paths: [__dirname] }));
let idlUtils;
try { idlUtils = require(path.join(JD, 'lib/generated/idl/utils.js')); } catch (_) {}

// ── Đọc kích thước ảnh từ bytes (PNG/JPEG/WebP/GIF/SVG) ──────────────────────
function imgSize(buf, ct) {
  try {
    const s = String(ct || '').toLowerCase();
    if (s.includes('svg')) {
      const txt = buf.slice(0, 4096).toString('utf8');
      const mw = txt.match(/\bwidth="(\d+)"/i), mh = txt.match(/\bheight="(\d+)"/i);
      return mw && mh ? [+mw[1], +mh[1]] : [100, 100];
    }
    if (buf.length < 24) return [1, 1];
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46)
      return [buf.readUInt16LE(6), buf.readUInt16LE(8)];
    // JPEG: scan SOF markers
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 8 < buf.length) {
        if (buf[i] !== 0xff) break;
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        if (m === 0xd9 || m === 0xda) break;
        if (i + 4 > buf.length) break;
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return [100, 100];
    }
    // WebP
    if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) {
      const cc = buf.toString('ascii', 12, 16);
      if (cc === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (cc === 'VP8L' && buf.length >= 26) { const b = buf.readUInt32LE(21); return [(b & 0x3fff)+1, ((b>>14)&0x3fff)+1]; }
      if (cc === 'VP8X' && buf.length >= 34) return [((buf[24]|buf[25]<<8|buf[26]<<16)&0xffffff)+1, ((buf[27]|buf[28]<<8|buf[29]<<16)&0xffffff)+1];
    }
  } catch (_) {}
  return [1, 1];
}

// ── Module-level: patch jsdom impl prototypes (chạy một lần khi require) ──────
// DOC_HANDLERS: docURL → { handleLink(href, co), handleImg(implNode, rawSrc, co) }
const DOC_HANDLERS = new Map();
let _patched = false;

function _patchJsdom() {
  if (_patched) return;
  _patched = true;

  // Link[rel=preload as=image]
  try {
    const LP = require(path.join(JD, 'lib/jsdom/living/nodes/HTMLLinkElement-impl.js')).implementation.prototype;
    const origLA = LP._attrModified;
    LP._attrModified = function (name, value, old) {
      const r = origLA ? origLA.apply(this, arguments) : undefined;
      if (name === 'href' || name === 'rel' || name === 'as') {
        const rel = (this.getAttribute('rel') || '').toLowerCase().split(/\s+/);
        const as_ = (this.getAttribute('as') || '').toLowerCase();
        const href = this.getAttribute('href') || '';
        const docUrl = this._ownerDocument && this._ownerDocument.URL;
        const isPreload = rel.includes('preload') || rel.includes('prefetch');
        // FIX10: CF sets rel→href→as; fire on href change for /ci/ URLs (before as=image is set)
        if (name === 'href' && isPreload && href && href.includes('/cdn-cgi/') && href.includes('/ci/')) {
          const h = DOC_HANDLERS.get(docUrl);
          if (h) { h.handleLink(href, this.getAttribute('crossorigin')); return r; }
        }
        // fallback: fire on as=image (for CF versions that set as before href)
        if (isPreload && as_ === 'image' && href) {
          const h = DOC_HANDLERS.get(docUrl);
          if (h) h.handleLink(href, this.getAttribute('crossorigin'));
        }
      }
      return r;
    };
  } catch (_) {}

  // Img[src]
  try {
    const IP = require(path.join(JD, 'lib/jsdom/living/nodes/HTMLImageElement-impl.js')).implementation.prototype;
    const origIA = IP._attrModified;
    IP._attrModified = function (name, value, old) {
      const r = origIA ? origIA.apply(this, arguments) : undefined;
      if (name === 'src' && value) {
        const h = DOC_HANDLERS.get(this._ownerDocument && this._ownerDocument.URL);
        if (h) h.handleImg(this, value, this.getAttribute('crossorigin'));
      }
      return r;
    };
  } catch (_) {}
}

// Patch ngay tại require time
_patchJsdom();

// ── installMedia ─────────────────────────────────────────────────────────────
function installMedia(w, { callBridgeAsync, mkRTE, RTING, RT_OBS, impersonate, proxy, docOrigin, iframeUrl, log, mark, acc, method }) {
  // worker tái sử dụng: chỉ window chính mỗi solve gọi hàm này → bỏ handler của solve trước (URL có wid ngẫu nhiên → Map phình mãi)
  DOC_HANDLERS.clear();
  // Per-document preload cache: URL → Promise<{buf,ct,status,dur}>
  const PCACHE = new Map();
  // Link-preload RTE entries pushed synchronously from handleLink (keyed by URL)
  const LRTE = new Map();

  const fetchMedia = (url, crossorigin) => {
    if (PCACHE.has(url)) return PCACHE.get(url);
    const p = (async () => {
      const t0 = performance.now();
      const h = {
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': crossorigin ? 'cors' : 'no-cors',
        'Sec-Fetch-Site': 'same-origin', 'Referer': iframeUrl, 'Priority': 'u=4, i=?0',
      };
      if (crossorigin) h['Origin'] = docOrigin;
      try {
        const r = await callBridgeAsync({ method: 'GET', url, headers: h, body: null, impersonate, proxy: proxy || null });
        const dur = Math.max(10, Math.round(performance.now() - t0));
        const buf = r.body ? Buffer.from(r.body, 'base64') : Buffer.alloc(0);
        const ct = (r.headers && (r.headers['content-type'] || r.headers['Content-Type'])) || '';
        if (process.env.NETLOG) log(`[ci] <- ${r.status} len=${buf.length} dur=${dur}ms "${ct.slice(0, 40)}" ${url.slice(0, 90)}`);
        return { buf, ct, status: r.status || 0, dur };
      } catch (e) {
        const dur = Math.max(10, Math.round(performance.now() - t0));
        log(`[ci] !! ${e.message.slice(0, 80)}`);
        return { buf: Buffer.alloc(0), ct: '', status: 0, dur };
      }
    })();
    PCACHE.set(url, p);
    return p;
  };

  // Per-img state (WeakMap trên wrapper)
  const ISTATE = new WeakMap();
  const getS = (img) => ISTATE.get(img) || { src: '', complete: false, nw: 0, nh: 0, resolvers: [] };

  function onLoaded(img, result, fromPreload, rte) {
    const [nw, nh] = imgSize(result.buf, result.ct);
    const prev = getS(img);
    ISTATE.set(img, { src: prev.src, complete: true, nw, nh, resolvers: [] });
    // Cập nhật RTE entry placeholder với giá trị thật
    if (rte) {
      const t = w.performance.now(), dur = result.dur, bs = result.buf.length;
      const st = Math.max(1, t - dur), rs = st + Math.round(dur * 0.35);
      try {
        rte.duration = dur; rte.startTime = st; rte.fetchStart = st;
        rte.requestStart = st + 1; rte.responseStart = rs;
        // FIX: do NOT overwrite responseEnd — keep fake value set at RT_OBS fire time
        rte.transferSize = bs + 300;
        rte.encodedBodySize = bs; rte.decodedBodySize = bs;
        rte.responseStatus = result.status;
        Object.defineProperty(rte, 'initiatorType', { value: fromPreload ? 'link' : 'img', configurable: true, writable: true, enumerable: true });
      } catch (_) {}
    }
    for (const [res] of prev.resolvers || []) { try { res(); } catch (_) {} }
    w.setTimeout(() => { try { img.dispatchEvent(new w.Event('load')); } catch (_) {} }, 0);
  }

  function onError(img) {
    const prev = getS(img);
    ISTATE.set(img, { src: prev.src, complete: true, nw: 0, nh: 0, resolvers: [] });
    for (const [, rej] of prev.resolvers || []) { try { rej(new w.DOMException('broken', 'EncodingError')); } catch (_) {} }
    w.setTimeout(() => { try { img.dispatchEvent(new w.Event('error')); } catch (_) {} }, 0);
  }

  // resource timing đúng như Chrome: entry xuất hiện (và PerformanceObserver được gọi) khi tải XONG,
  // startTime = lúc bắt đầu tải, responseEnd = lúc xong, kích thước thật
  function pushRTE(url, t0, result, initiator) {
    const bs = result.buf.length;
    const rte = mkRTE(url, Math.max(1, w.performance.now() - t0), bs, result.status);
    try { Object.defineProperty(rte, 'initiatorType', { value: initiator, configurable: true, writable: true, enumerable: true }); } catch (_) {}
    RTING.push(rte);
    RT_OBS.forEach((fn) => fn(rte));
  }

  // <img src>: complete=false khi đang tải; xong → naturalWidth/Height từ header ảnh thật → sự kiện load (CF đọc kích thước ở onload)
  function startLoad(imgWrapper, url, crossorigin) {
    const prev = getS(imgWrapper);
    if (prev.src === url && (prev.complete || prev.loading)) return;
    ISTATE.set(imgWrapper, { src: url, complete: false, nw: 0, nh: 0, loading: true, resolvers: prev.resolvers || [] });
    const fromPreload = PCACHE.has(url), t0 = w.performance.now();
    fetchMedia(url, crossorigin).then((result) => {
      if (getS(imgWrapper).src !== url) return;                     // src đã đổi
      if (!fromPreload) pushRTE(url, t0, result, 'img');            // ảnh lấy từ preload cache: Chrome không thêm entry
      if (result.status >= 200 && result.status < 300 && result.buf.length > 0) onLoaded(imgWrapper, result, fromPreload, null);
      else onError(imgWrapper);
    }).catch(() => onError(imgWrapper));
  }

  // Đăng ký handler cho document URL này
  DOC_HANDLERS.set(iframeUrl, {
    handleLink(rawHref, crossorigin) {
      let url; try { url = new URL(rawHref, iframeUrl).href; } catch (_) { url = rawHref; }
      if (LRTE.has(url)) return; // đã xử lý
      LRTE.set(url, true);
      if (process.env.NETLOG) log(`[ci] link preload href=${url.slice(0, 90)}`);
      const t0 = w.performance.now();
      fetchMedia(url, crossorigin).then((result) => pushRTE(url, t0, result, 'link')).catch(() => {});
    },
    handleImg(impl, rawSrc, crossorigin) {
      let url; try { url = new URL(rawSrc, iframeUrl).href; } catch (_) { url = rawSrc; }
      if (process.env.NETLOG) log(`[ci] img attr src=${url.slice(0, 90)}`);
      let imgWrapper;
      try { imgWrapper = idlUtils && idlUtils.wrapperForImpl(impl); } catch (_) {}
      if (!imgWrapper) return;
      startLoad(imgWrapper, url, crossorigin);
    },
  });

  // Gắn naturalWidth/naturalHeight/complete/currentSrc/decode vào HTMLImageElement.prototype
  const HIP = w.HTMLImageElement && w.HTMLImageElement.prototype;
  if (HIP) {
    acc(HIP, 'naturalWidth', function () { return (ISTATE.get(this) || {}).nw || 0; });
    acc(HIP, 'naturalHeight', function () { return (ISTATE.get(this) || {}).nh || 0; });
    for (const [k, nk] of [['width', 'nw'], ['height', 'nh']]) {
      const d = Object.getOwnPropertyDescriptor(HIP, k);
      if (d && d.get) Object.defineProperty(HIP, k, { ...d, get: mark(Object.getOwnPropertyDescriptor({ get [k]() { return this.hasAttribute(k) ? d.get.call(this) : (ISTATE.get(this) || {})[nk] || 0; } }, k).get) });
    }
    acc(HIP, 'complete', function () {
      const s = ISTATE.get(this);
      if (!s) { const a = this.getAttribute && this.getAttribute('src'); return !a; }
      return !!s.complete;
    });
    acc(HIP, 'currentSrc', function () {
      return (ISTATE.get(this) || {}).src || (this.getAttribute && this.getAttribute('src') || '');
    });
    method(HIP, 'decode', function () {
      const self = this;
      const s = ISTATE.get(self);
      if (s && s.complete)
        return s.nw > 0 ? w.Promise.resolve() : w.Promise.reject(new w.DOMException('broken', 'EncodingError'));
      return new w.Promise((res, rej) => {
        const st = ISTATE.get(self) || { resolvers: [] };
        st.resolvers = (st.resolvers || []).concat([[res, rej]]);
        ISTATE.set(self, st);
      });
    }, 0);
  }

  return { fetchMedia, PCACHE };
}

module.exports = { installMedia, imgSize };
