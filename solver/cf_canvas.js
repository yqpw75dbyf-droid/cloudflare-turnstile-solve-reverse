'use strict';
// cf_canvas.js — Canvas2D / WebGL1 / WebGL2 đủ bề mặt API như Chrome (không render thật).
// Bề mặt (method/hằng/thuộc tính) sinh từ lib.dom.d.ts → web_surfaces.json (gen_surfaces.js).
// ponytail: không rasterize — getImageData/readPixels trả buffer rỗng; nâng cấp bằng @napi-rs/canvas nếu CF chấm pixel.
const zlib = require('zlib');
const SURF = require('./web_surfaces.json');

// ---- PNG hợp lệ (RGBA) cho toDataURL ----
function png(width, height, rgba) {
  const crc = (buf) => zlib.crc32(buf) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy ? rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4) : null;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ---- màu CSS → dạng serialize của canvas ----
const NAMED = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', lime: '#00ff00', navy: '#000080',
  teal: '#008080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', pink: '#ffc0cb', brown: '#a52a2a', transparent: 'rgba(0, 0, 0, 0)' };
function normColor(v, prev) {
  if (typeof v !== 'string') return prev;
  const s = v.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length === 6) return '#' + h;
    if (h.length === 8) { const a = parseInt(h.slice(6), 16) / 255; return a === 1 ? '#' + h.slice(0, 6) : `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${+a.toFixed(3)})`; }
    return prev;
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const [r, g, b] = [m[1], m[2], m[3]].map((x) => Math.round(Math.min(255, +x)));
    let a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4];
    if (a >= 1) return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `rgba(${r}, ${g}, ${b}, ${+a.toFixed(3)})`;
  }
  return prev;
}

// ---- record / replay kết quả đo thật từ Chrome ----
// PROBEREC=1: ghi toàn bộ thao tác canvas/WebGL (thứ tự, typed array, ref object) → probe_ops.json
// probe_results.json (do probe_replayer.html chạy trong Chrome thật sinh ra): key → kết quả thật để phát lại
const REC = process.env.PROBEREC ? [] : null;
let REPLAY = {};
try { REPLAY = require('./probe_results.json').results || {}; } catch (_) {}
const h53 = (str, seed = 0) => {   // cyrb53 — cùng hàm trong probe_replayer.html
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};
const replayStats = { hit: 0, miss: 0, missKeys: [] };
if (REC) process.on('exit', () => { require('fs').writeFileSync(require('path').join(__dirname, 'probe_ops.json'), JSON.stringify(REC)); });
if (process.env.REPLAYLOG) process.on('exit', () => console.log(`[replay] hit=${replayStats.hit} miss=${replayStats.miss} ${replayStats.missKeys.slice(0, 8).join(',')}`));

function installCanvas(w, { mark, method, acc, iface, env, toPage }) {
  const O = w.Object, DATA = new WeakMap();
  const wg = env.webgl || {};
  // mỗi canvas: id + lịch sử thao tác đã serialize (khoá content-addressed); object WebGL/gradient: ref id
  const CANVAS = new WeakMap(), REF = new WeakMap();
  let cid = 0, rid = 0;
  const cvOf = (el) => {
    let c = CANVAS.get(el);
    if (!c) { c = { id: ++cid, ops: [['size', el.width, el.height]] }; CANVAS.set(el, c); if (REC) REC.push({ c: c.id, k: 'cv', m: 'size', a: [el.width, el.height] }); }
    return c;
  };
  const ser = (x, outArg) => {
    if (x === null || (typeof x !== 'object' && typeof x !== 'function')) return x;
    if (ArrayBuffer.isView(x)) return outArg ? { ta: x.constructor.name, n: x.length } : { ta: x.constructor.name, d: Array.from(x) };
    if (x && x.constructor && x.constructor.name === 'ArrayBuffer') return { ab: Array.from(new Uint8Array(x)) };
    if (CANVAS.has(x)) { const c = CANVAS.get(x); return { canvas: c.id, h: h53(JSON.stringify(c.ops)) }; }
    if (REF.has(x)) return { ref: REF.get(x) };
    if (DATA.has(x) && DATA.get(x).data && DATA.get(x).width) return { imgdata: [DATA.get(x).width, DATA.get(x).height], d: Array.from(DATA.get(x).data) };
    if (Array.isArray(x)) return x.map((v) => ser(v));
    if (x.constructor === w.Object || x.constructor === Object) { const o = {}; for (const k of Object.keys(x)) o[k] = ser(x[k]); return { o }; }
    return { obj: (x.constructor && x.constructor.name) || typeof x };
  };
  // ghi 1 thao tác vào lịch sử canvas (+ log toàn cục khi PROBEREC); trả key nếu là phép đọc
  const rec = (el, kind, m, args, { read = false, ret, outIdx = -1 } = {}) => {
    const c = cvOf(el);
    const a = Array.from(args, (x, i) => ser(x, i === outIdx));
    const entry = [kind, m, a];
    const key = read ? h53(JSON.stringify([c.ops, entry])) : undefined;
    if (REC) REC.push({ c: c.id, k: kind, m, a, r: ret, read: key });
    c.ops.push(entry);
    return key;
  };
  const replay = (key) => { if (key in REPLAY) { replayStats.hit++; return REPLAY[key]; } replayStats.miss++; if (replayStats.missKeys.length < 50) replayStats.missKeys.push(key); return undefined; };
  const b64 = (x) => Buffer.from(x, 'base64');


  // ===== Canvas 2D =====
  const C2D = iface('CanvasRenderingContext2D');
  const GRAD = iface('CanvasGradient'), PAT = iface('CanvasPattern'), TM = iface('TextMetrics');
  method(GRAD.prototype, 'addColorStop', () => undefined, 2);
  method(PAT.prototype, 'setTransform', () => undefined, 0);
  const TM_KEYS = ['width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight', 'fontBoundingBoxAscent', 'fontBoundingBoxDescent', 'actualBoundingBoxAscent', 'actualBoundingBoxDescent', 'emHeightAscent', 'emHeightDescent', 'hangingBaseline', 'alphabeticBaseline', 'ideographicBaseline'];
  for (const k of TM_KEYS) acc(TM.prototype, k, function () { return DATA.get(this)[k]; });
  const D2 = { direction: 'ltr', fillStyle: '#000000', filter: 'none', font: '10px sans-serif', fontKerning: 'auto', fontStretch: 'normal', fontVariantCaps: 'normal',
    globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, imageSmoothingQuality: 'low', letterSpacing: '0px', lineCap: 'butt',
    lineDashOffset: 0, lineJoin: 'miter', lineWidth: 1, miterLimit: 10, shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0,
    strokeStyle: '#000000', textAlign: 'start', textBaseline: 'alphabetic', textRendering: 'auto', wordSpacing: '0px' };
  for (const k of SURF.CanvasRenderingContext2D.attrs) {
    const getter = mark(Object.getOwnPropertyDescriptor({ get [k]() { const st = DATA.get(this); return k === 'canvas' ? st.canvas : st.s[k]; } }, k).get);
    const setter = k === 'canvas' ? undefined : mark(Object.getOwnPropertyDescriptor({ set [k](v) {
      const st = DATA.get(this); rec(st.canvas, '2d', '=' + k, [v]);
      if (k === 'fillStyle' || k === 'strokeStyle' || k === 'shadowColor') st.s[k] = (v && typeof v === 'object') ? v : normColor(v, st.s[k]);
      else if (typeof D2[k] === 'number') { const n = +v; if (Number.isFinite(n) && !(k.endsWith('Width') && n <= 0)) st.s[k] = n; }
      else if (typeof D2[k] === 'boolean') st.s[k] = !!v;
      else st.s[k] = String(v);
    } }, k).set);
    Object.defineProperty(C2D.prototype, k, { get: getter, set: setter, enumerable: true, configurable: true });
  }
  const fontPx = (f) => { const m = /(\d+(?:\.\d+)?)px/.exec(f || ''); return m ? +m[1] : 10; };
  const R2 = {
    measureText(t) {
      const px = fontPx(DATA.get(this).s.font), wdt = String(t).length * px * 0.5561;
      const tm = O.create(TM.prototype);
      DATA.set(tm, { width: wdt, actualBoundingBoxLeft: 0, actualBoundingBoxRight: wdt, fontBoundingBoxAscent: px * 0.905, fontBoundingBoxDescent: px * 0.212,
        actualBoundingBoxAscent: px * 0.716, actualBoundingBoxDescent: px * 0.015, emHeightAscent: px * 0.8, emHeightDescent: px * 0.2, hangingBaseline: px * 0.72, alphabeticBaseline: 0, ideographicBaseline: -px * 0.212 });
      return tm;
    },
    getImageData(x, y, sw, sh) { return new w.ImageData(Math.max(1, Math.abs(sw | 0)), Math.max(1, Math.abs(sh | 0))); },
    createImageData(a, b) { return typeof a === 'object' ? new w.ImageData(a.width, a.height) : new w.ImageData(Math.max(1, Math.abs(a | 0)), Math.max(1, Math.abs(b | 0))); },
    createLinearGradient() { return O.create(GRAD.prototype); }, createRadialGradient() { return O.create(GRAD.prototype); },
    createConicGradient() { return O.create(GRAD.prototype); }, createPattern() { return O.create(PAT.prototype); },
    getLineDash() { return w.Array.from(DATA.get(this).dash); }, setLineDash(a) { DATA.get(this).dash = Array.from(a || []); },
    isPointInPath() { return false; }, isPointInStroke() { return false; },
    getTransform() { return new w.DOMMatrix([1, 0, 0, 1, 0, 0]); },
    getContextAttributes() { return toPage({ alpha: true, colorSpace: 'srgb', desynchronized: false, willReadFrequently: false }); },
    save() { const st = DATA.get(this); st.stack.push({ ...st.s }); }, restore() { const st = DATA.get(this); if (st.stack.length) st.s = st.stack.pop(); },
    reset() { const st = DATA.get(this); st.s = { ...D2 }; st.stack = []; }, isContextLost() { return false; },
  };
  const READBACK2D = new Set(['getImageData', 'measureText', 'isPointInPath', 'isPointInStroke']);
  for (const k of SURF.CanvasRenderingContext2D.methods) {
    const impl = R2[k] || (() => undefined);
    method(C2D.prototype, k, function (...a) {
      const st = DATA.get(this);
      if (!st) return impl.apply(this, a);
      const key = rec(st.canvas, '2d', k, a, { read: READBACK2D.has(k) });
      const out = impl.apply(this, a);
      if (key) {
        const r = replay(key);
        if (r && k === 'getImageData' && r.d) { const data = out.data; if (data) data.set(b64(r.d).subarray(0, data.length)); }
        else if (r && k === 'measureText') Object.assign(DATA.get(out), r);
        else if (r !== undefined && (k === 'isPointInPath' || k === 'isPointInStroke')) return r;
      }
      if (out && typeof out === 'object' && k.startsWith('create')) REF.set(out, ++rid);
      return out;
    });
  }
  const new2D = (canvas) => { const c = O.create(C2D.prototype); DATA.set(c, { canvas, s: { ...D2 }, stack: [], dash: [] }); return c; };

  // ===== WebGL =====
  const GLT = {};
  for (const t of ['WebGLShader', 'WebGLProgram', 'WebGLBuffer', 'WebGLTexture', 'WebGLFramebuffer', 'WebGLRenderbuffer', 'WebGLUniformLocation', 'WebGLActiveInfo',
    'WebGLShaderPrecisionFormat', 'WebGLVertexArrayObject', 'WebGLQuery', 'WebGLSampler', 'WebGLSync', 'WebGLTransformFeedback']) GLT[t] = iface(t);
  for (const k of ['rangeMin', 'rangeMax', 'precision']) acc(GLT.WebGLShaderPrecisionFormat.prototype, k, function () { return DATA.get(this)[k]; });
  for (const k of ['size', 'type', 'name']) acc(GLT.WebGLActiveInfo.prototype, k, function () { return DATA.get(this)[k]; });
  const obj = (t, d = {}) => { const o = O.create(GLT[t].prototype); DATA.set(o, d); return o; };
  const I32 = (a) => new w.Int32Array(a), F32 = (a) => new w.Float32Array(a);
  // tham số ANGLE D3D11 (Microsoft Basic Render Driver) — khớp renderer đã capture
  const P = {
    0x1F00: wg.vendor || 'WebKit', 0x1F01: wg.renderer || 'WebKit WebGL', 0x1F02: wg.version || 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
    0x8B8C: wg.shadingLanguageVersion || 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
    0x9245: wg.unmaskedVendor || 'Google Inc. (Microsoft)', 0x9246: wg.unmaskedRenderer || 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    0x0D33: 16384, 0x84E8: 16384, 0x851C: 16384, 0x8869: 16, 0x8DFB: 4096, 0x8DFD: 1024, 0x8DFC: 30, 0x8872: 16, 0x8B4C: 16, 0x8B4D: 32,
    0x0D3A: () => I32([32767, 32767]), 0x846E: () => F32([1, 1]), 0x846D: () => F32([1, 1024]), 0x0D50: 4, 0x0D52: 8, 0x0D53: 8, 0x0D54: 8, 0x0D55: 8,
    0x0D56: 24, 0x0D57: 0, 0x0BA2: () => I32([0, 0, 300, 150]), 0x0C10: () => I32([0, 0, 300, 150]), 0x0C22: () => F32([0, 0, 0, 0]), 0x0B73: 1,
    0x0BE2: false, 0x0B71: false, 0x0B44: false, 0x0C11: false, 0x0B90: false, 0x8D57: 4, 0x84FF: 16, 0x8073: 2048, 0x88FF: 2048, 0x8CDF: 8, 0x8824: 8,
    0x8D6B: 4294967294, 0x80E9: 2147483647, 0x80E8: 2147483647, 0x9125: 120, 0x8A2D: 12, 0x8B49: 4096, 0x8905: 7, 0x8904: -8, 0x9111: 0, 0x84FD: 2,
    0x8C8A: 4, 0x8C80: 4, 0x8C8B: 120, 0x8A30: 65536, 0x8A2F: 24, 0x8B4B: 120, 0x9122: 120, 0x8A2B: 12, 0x8B4A: 16384, 0x8A2E: 24,
    0x8A31: 212992, 0x8A33: 200704, 0x8A34: 256, 0x8B8D: null, 0x8CA6: null, 0x8CA7: null, 0x8069: null,
  };
  const EXT1 = ['ANGLE_instanced_arrays', 'EXT_blend_minmax', 'EXT_clip_control', 'EXT_color_buffer_half_float', 'EXT_depth_clamp', 'EXT_disjoint_timer_query', 'EXT_float_blend',
    'EXT_frag_depth', 'EXT_polygon_offset_clamp', 'EXT_shader_texture_lod', 'EXT_texture_compression_bptc', 'EXT_texture_compression_rgtc', 'EXT_texture_filter_anisotropic',
    'EXT_texture_mirror_clamp_to_edge', 'EXT_sRGB', 'KHR_parallel_shader_compile', 'OES_element_index_uint', 'OES_fbo_render_mipmap', 'OES_standard_derivatives',
    'OES_texture_float', 'OES_texture_float_linear', 'OES_texture_half_float', 'OES_texture_half_float_linear', 'OES_vertex_array_object', 'WEBGL_blend_func_extended',
    'WEBGL_color_buffer_float', 'WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'WEBGL_debug_renderer_info', 'WEBGL_debug_shaders',
    'WEBGL_depth_texture', 'WEBGL_draw_buffers', 'WEBGL_lose_context', 'WEBGL_multi_draw', 'WEBGL_polygon_mode'];
  const EXT2 = wg.extensions && wg.extensions.length ? wg.extensions : EXT1;
  const EXT_CONST = { WEBGL_debug_renderer_info: { UNMASKED_VENDOR_WEBGL: 0x9245, UNMASKED_RENDERER_WEBGL: 0x9246 }, EXT_texture_filter_anisotropic: { TEXTURE_MAX_ANISOTROPY_EXT: 0x84FE, MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84FF } };
  const EXT_METH = {
    WEBGL_lose_context: ['loseContext', 'restoreContext'],
    ANGLE_instanced_arrays: ['drawArraysInstancedANGLE', 'drawElementsInstancedANGLE', 'vertexAttribDivisorANGLE'],
    OES_vertex_array_object: ['createVertexArrayOES', 'deleteVertexArrayOES', 'isVertexArrayOES', 'bindVertexArrayOES'],
    WEBGL_draw_buffers: ['drawBuffersWEBGL'], WEBGL_debug_shaders: ['getTranslatedShaderSource'],
    WEBGL_multi_draw: ['multiDrawArraysWEBGL', 'multiDrawElementsWEBGL', 'multiDrawArraysInstancedWEBGL', 'multiDrawElementsInstancedWEBGL'],
    EXT_disjoint_timer_query: ['createQueryEXT', 'deleteQueryEXT', 'isQueryEXT', 'beginQueryEXT', 'endQueryEXT', 'queryCounterEXT', 'getQueryEXT', 'getQueryObjectEXT'],
    EXT_disjoint_timer_query_webgl2: ['queryCounterEXT'], OES_draw_buffers_indexed: ['enableiOES', 'disableiOES', 'blendEquationiOES', 'blendEquationSeparateiOES', 'blendFunciOES', 'blendFuncSeparateiOES', 'colorMaskiOES'],
    WEBGL_polygon_mode: ['polygonModeWEBGL'], EXT_clip_control: ['clipControlEXT'], EXT_polygon_offset_clamp: ['polygonOffsetClampEXT'],
  };
  const EXT_RET = { createVertexArrayOES: () => obj('WebGLVertexArrayObject'), isVertexArrayOES: () => true, createQueryEXT: () => obj('WebGLQuery'), isQueryEXT: () => true, getTranslatedShaderSource: () => '' };
  const extObj = {};
  const getExt = (list, n) => {
    n = String(n);
    if (!list.includes(n)) return null;
    if (!extObj[n]) {
      const E = iface(n); extObj[n] = O.create(E.prototype);
      for (const [k, v] of Object.entries(EXT_CONST[n] || {})) Object.defineProperty(E.prototype, k, { value: v, enumerable: true });
      for (const m of EXT_METH[n] || []) method(E.prototype, m, EXT_RET[m] || (() => undefined));
    }
    return extObj[n];
  };
  const precision = (st, pt) => { const isInt = pt >= 0x8DF3; const d = isInt ? { rangeMin: 31, rangeMax: 30, precision: 0 } : { rangeMin: 127, rangeMax: 127, precision: 23 }; return obj('WebGLShaderPrecisionFormat', d); };
  const mkGL = (name, surf, exts) => {
    const G = iface(name);
    for (const [k, v] of Object.entries(surf.consts)) { Object.defineProperty(G, k, { value: v, enumerable: true }); Object.defineProperty(G.prototype, k, { value: v, enumerable: true }); }
    const R = {
      getParameter(p) { const v = P[p]; return typeof v === 'function' ? v() : v === undefined ? null : v; },
      getExtension(n) { return getExt(exts, n); }, getSupportedExtensions() { return w.Array.from(exts); },
      getContextAttributes() { const d = DATA.get(this); return toPage(d ? d.attrs : GLATTR); }, isContextLost() { return false; }, getError() { return 0; },
      getShaderPrecisionFormat(st, pt) { return precision(st, pt); },
      createShader(t) { return obj('WebGLShader', { type: t, src: '' }); }, createProgram() { return obj('WebGLProgram', {}); },
      createBuffer() { return obj('WebGLBuffer'); }, createTexture() { return obj('WebGLTexture'); }, createFramebuffer() { return obj('WebGLFramebuffer'); },
      createRenderbuffer() { return obj('WebGLRenderbuffer'); }, createVertexArray() { return obj('WebGLVertexArrayObject'); }, createQuery() { return obj('WebGLQuery'); },
      createSampler() { return obj('WebGLSampler'); }, createTransformFeedback() { return obj('WebGLTransformFeedback'); }, fenceSync() { return obj('WebGLSync'); },
      shaderSource(s, src) { if (s && DATA.get(s)) DATA.get(s).src = String(src); }, getShaderSource(s) { return (DATA.get(s) || {}).src || null; },
      getShaderParameter(s, p) { return p === 0x8B4F ? (DATA.get(s) || {}).type : p === 0x8B80 ? false : true; },
      getProgramParameter(pr, p) { return p === 0x8B80 ? false : p === 0x8B85 ? 2 : p === 0x8B89 || p === 0x8B86 ? 1 : true; },
      getShaderInfoLog() { return ''; }, getProgramInfoLog() { return ''; }, getAttribLocation() { return 0; },
      getUniformLocation() { return obj('WebGLUniformLocation'); }, getActiveAttrib() { return obj('WebGLActiveInfo', { size: 1, type: 0x8B50, name: 'a' }); },
      getActiveUniform() { return obj('WebGLActiveInfo', { size: 1, type: 0x8B50, name: 'u' }); }, checkFramebufferStatus() { return 0x8CD5; },
      isEnabled() { return false; }, getBufferParameter() { return 0; }, getTexParameter() { return null; }, getVertexAttrib() { return null; },
      getInternalformatParameter() { return I32([4, 2, 1]); }, getIndexedParameter() { return null; }, clientWaitSync() { return 0x911A; },
      getSyncParameter() { return 0x9119; }, getFragDataLocation() { return -1; }, getUniformBlockIndex() { return 0xFFFFFFFF; },
      makeXRCompatible() { return w.Promise.resolve(); },
    };
    const STATIC_READ = new Set(['getParameter', 'getSupportedExtensions', 'getContextAttributes', 'getShaderPrecisionFormat', 'getExtension', 'getInternalformatParameter']);
    for (const k of surf.methods) {
      const impl = R[k] || (/^is[A-Z]/.test(k) ? (() => true) : () => undefined);
      method(G.prototype, k, function (...a) {
        const st = DATA.get(this);
        if (!st) return impl.apply(this, a);
        const isRead = k === 'readPixels' || STATIC_READ.has(k);
        const retId = /^create|^fenceSync$|^getUniformLocation$/.test(k) ? ++rid : undefined;
        // phép đọc tĩnh (getParameter…): khoá không phụ thuộc lịch sử
        let key;
        if (STATIC_READ.has(k)) { const sa = Array.from(a, (x) => ser(x)); key = h53(JSON.stringify([name, k, sa])); if (REC) REC.push({ c: cvOf(st.canvas).id, k: name, m: k, a: sa, read: key, static: true }); }
        else key = rec(st.canvas, name, k, a, { read: isRead, ret: retId, outIdx: k === 'readPixels' ? 6 : -1 });
        const out = impl.apply(this, a);
        if (retId && out && typeof out === 'object') REF.set(out, retId);
        if (isRead) {
          const r = replay(key);
          if (r !== undefined) {
            if (k === 'readPixels' && r && r.d && a[6]) a[6].set(b64(r.d).subarray(0, a[6].length));
            else if (k === 'getParameter' || k === 'getInternalformatParameter') return r && r.ta ? new w[r.ta](r.d) : r;
            else if (k === 'getSupportedExtensions') return w.Array.from(r || []);
            else if (k === 'getContextAttributes') return toPage(r);
            else if (k === 'getShaderPrecisionFormat') return r ? obj('WebGLShaderPrecisionFormat', r) : null;
          }
        }
        return out;
      });
    }
    for (const k of ['drawingBufferWidth', 'drawingBufferHeight']) acc(G.prototype, k, function () { const c = DATA.get(this).canvas; return k === 'drawingBufferWidth' ? c.width : c.height; });
    acc(G.prototype, 'canvas', function () { return DATA.get(this).canvas; });
    for (const k of ['drawingBufferColorSpace', 'unpackColorSpace']) acc(G.prototype, k, () => 'srgb');
    return G;
  };
  const GL1 = mkGL('WebGLRenderingContext', SURF.WebGLRenderingContext, EXT1);
  const GL2 = mkGL('WebGL2RenderingContext', SURF.WebGL2RenderingContext, EXT2);
  const GLATTR = { alpha: true, antialias: true, depth: true, desynchronized: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default',
    premultipliedAlpha: true, preserveDrawingBuffer: false, stencil: false, xrCompatible: false };
  const newGL = (G, canvas, attrs) => { const c = O.create(G.prototype); DATA.set(c, { canvas, attrs: { ...GLATTR, ...(attrs && typeof attrs === 'object' ? { antialias: attrs.antialias !== false, alpha: attrs.alpha !== false, depth: attrs.depth !== false, stencil: !!attrs.stencil, preserveDrawingBuffer: !!attrs.preserveDrawingBuffer, powerPreference: attrs.powerPreference || 'default' } : {}) } }); return c; };

  // ===== HTMLCanvasElement =====
  const CTX = new WeakMap();
  method(w.HTMLCanvasElement.prototype, 'getContext', function (kind, attrs) {
    const k = String(kind);
    const cur = CTX.get(this);
    if (cur) return cur.kind === k || (cur.kind === 'experimental-webgl' && k === 'webgl') ? cur.ctx : null;   // 1 canvas = 1 loại context
    const ctx = k === '2d' ? new2D(this) : (k === 'webgl' || k === 'experimental-webgl') ? newGL(GL1, this, attrs) : k === 'webgl2' ? newGL(GL2, this, attrs) : null;
    if (ctx) { CTX.set(this, { kind: k, ctx }); rec(this, 'cv', 'getContext', [k, attrs && typeof attrs === 'object' ? { ...attrs } : attrs]); }
    return ctx;
  }, 1);
  method(w.HTMLCanvasElement.prototype, 'toDataURL', function (type) {
    const wd = this.width || 300, ht = this.height || 150;
    const key = rec(this, 'cv', 'toDataURL', [type], { read: true });
    const r = replay(key); if (typeof r === 'string') return r;
    if (!wd || !ht) return 'data:,';
    return 'data:image/png;base64,' + png(wd, ht, Buffer.alloc(wd * ht * 4)).toString('base64');
  }, 0);
  for (const k of ['width', 'height']) {   // đổi kích thước canvas → vào lịch sử
    const d = Object.getOwnPropertyDescriptor(w.HTMLCanvasElement.prototype, k);
    if (d && d.set) Object.defineProperty(w.HTMLCanvasElement.prototype, k, { ...d, set: mark(Object.getOwnPropertyDescriptor({ set [k](v) { d.set.call(this, v); if (CANVAS.has(this)) rec(this, 'cv', '=' + k, [this[k]]); } }, k).set) });
  }
  method(w.HTMLCanvasElement.prototype, 'toBlob', function (cb) { const b = new w.Blob([png(this.width || 300, this.height || 150, Buffer.alloc((this.width || 300) * (this.height || 150) * 4))], { type: 'image/png' }); w.setTimeout(() => cb(b), 0); }, 1);
}

module.exports = { installCanvas, png, normColor, h53 };
