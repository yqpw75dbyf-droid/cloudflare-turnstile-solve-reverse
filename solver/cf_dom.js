'use strict';
// cf_dom.js — env browser cho iframe challenge CF trên nền jsdom (DOM class thật, realm thật).
// Page script (inline orchestrate) chạy tự nhiên khi parse HTML; mọi overlay cài trong beforeParse.
//   - toString [native code] cho mọi hàm env (cả realm Node lẫn realm page)
//   - Error.stack: lọc frame Node/jsdom (chỉ giữ frame https: như Chrome)
//   - parent/top = WindowProxy cross-origin (chỉ postMessage…, còn lại SecurityError)
//   - message từ parent: MessageEvent isTrusted thật (fireAnEvent), origin/source đúng
//   - fingerprint thật (captured_env.json) phủ lên Navigator/Screen/window
const path = require('path');
const crypto = require('crypto');

// ── Fast timer patch (jsdom-only, không ảnh hưởng worker/Node internals) ─────
// Windows OS timer resolution = 15.6ms → setTimeout(fn, 0) fires after ~15ms.
// Chrome renders setTimeout(fn, 0) trong ~1ms. Chênh lệch làm bkVxJ4 ~10× Chrome.
// Fix: patch timerInitializationSteps trong jsdom Window.js tại compile-time → chỉ
// window-scope timer (page script) dùng setImmediate; worker và Node giữ nguyên.
// ponytail: không dùng global patch → tránh acjq6 inflate do worker gửi quá nhiều msg.
// clearTimeout cũng được patch để clearImmediate đúng cách.

// window/document/location/top: jsdom khoá non-configurable ngay giữa danh sách → không xếp được thứ tự như Chrome.
// Bỏ khoá lúc load Window.js; setup() xếp xong thứ tự rồi mới khoá lại.
let UNFORGEABLE_PATCHED = false;
{
  const M = require('module'), cmp = M.prototype._compile;
  M.prototype._compile = function (src, file) {
    if (/jsdom[\\/]lib[\\/]jsdom[\\/]browser[\\/]Window\.js$/.test(file)) {
      // 1) Bỏ khoá LegacyUnforgeable → setup() xếp thứ tự rồi khoá lại
      const out = src.replace(/\/\/ \[LegacyUnforgeable\]:\s*window: \{ configurable: false \},\s*document: \{ configurable: false \},\s*location: \{ configurable: false \},\s*top: \{ configurable: false \}/, '/* [LegacyUnforgeable]: cf_dom khoá sau */');
      UNFORGEABLE_PATCHED = out !== src;
      // 2) Fast timer: route setTimeout(task, 0|1) → setImmediate (~0.02ms) thay vì Node timer (15ms Windows).
      //    Chỉ bên trong jsdom window → không ảnh hưởng worker hay Node internals.
      //    ponytail: chỉ non-repeat (setInterval giữ nguyên tốc), clearTimeout dùng clearImmediate.
      const patched = out
        .replace(
          'const nodejsTimer = setTimeout(task, timeout);',
          'const nodejsTimer = (!repeat && timeout <= 1) ? { _imm: setImmediate(task) } : setTimeout(task, timeout);'
        )
        .replace(
          'clearTimeout(nodejsTimer);',
          '(nodejsTimer && nodejsTimer._imm ? clearImmediate(nodejsTimer._imm) : clearTimeout(nodejsTimer));'
        );
      src = patched; M.prototype._compile = cmp;
    }
    return cmp.call(this, src, file);
  };
}
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const JD = path.dirname(require.resolve('jsdom/package.json'));
// WindowProperties: object thường thay cho Proxy của jsdom (V8 dừng for-in/duyệt chuỗi prototype tại Proxy; Chrome thì không).
// Named access (window[id|name]) = data property non-enumerable, cập nhật khi element attach/detach/đổi id|name.
{
  const WPm = require(path.join(JD, 'lib/jsdom/living/window-properties.js'));
  const HTMLCollection = require(path.join(JD, 'lib/generated/idl/HTMLCollection.js'));
  const { HTML_NS } = require(path.join(JD, 'lib/jsdom/living/helpers/namespaces.js'));
  const { nodeRoot } = require(path.join(JD, 'lib/jsdom/living/helpers/node.js'));
  const { treeOrderSorter } = require(path.join(JD, 'lib/jsdom/utils.js'));
  const iu = require(path.join(JD, 'lib/generated/idl/utils.js'));
  const NAMED = new Set(['embed', 'form', 'img', 'object', 'iframe', 'frame']);
  const TR = new WeakMap();   // window → { wp, map: Map<name, Set<impl>> }
  const sync = (window, t, name) => {
    const set = t.map.get(name);
    if (name in Object.getPrototypeOf(t.wp)) return;   // tên có trên chuỗi prototype → ẩn (named property visibility)
    if (!set || !set.size) { delete t.wp[name]; return; }
    const sorted = [...set].sort(treeOrderSorter);
    let v = null;
    for (const el of sorted) if ((el.localName === 'iframe' || el.localName === 'frame') && el.getAttributeNS(null, 'name') === name && el.contentWindow) v = el.contentWindow;
    if (!v) v = set.size === 1 ? iu.wrapperForImpl(sorted[0]) : HTMLCollection.create(window, [], { element: iu.implForWrapper(window._document).documentElement, query: () => [...(t.map.get(name) || [])].sort(treeOrderSorter) });
    Object.defineProperty(t.wp, name, { value: v, writable: true, enumerable: false, configurable: true });
  };
  const ctx = (el) => { const window = el._ownerDocument._globalObject; const t = window && TR.get(window); return t && el.namespaceURI === HTML_NS ? [window, t] : null; };
  const add = (t, k, el) => { let s = t.map.get(k); if (!s) t.map.set(k, s = new Set()); s.add(el); };
  const del = (t, k, el) => { const s = t.map.get(k); if (s) { s.delete(el); if (!s.size) t.map.delete(k); } };
  WPm.create = (etProto, window) => {
    const wp = Object.create(etProto, { [Symbol.toStringTag]: { value: 'WindowProperties', configurable: true } });
    TR.set(window, { wp, map: new Map() });
    return wp;
  };
  WPm.elementAttached = (el) => {
    const c = ctx(el); if (!c || nodeRoot(el) !== el._ownerDocument) return; const [window, t] = c;
    const n = NAMED.has(el.localName) ? el.getAttributeNS(null, 'name') : null, id = el.getAttributeNS(null, 'id');
    for (const k of [n, id]) if (k !== null) { add(t, k, el); sync(window, t, k); }
  };
  WPm.elementDetached = (el) => {
    const c = ctx(el); if (!c) return; const [window, t] = c;
    for (const k of [el.getAttributeNS(null, 'id'), el.getAttributeNS(null, 'name')]) if (k !== null) { del(t, k, el); sync(window, t, k); }
  };
  WPm.elementAttributeModified = (el, attr, value, old) => {
    const c = ctx(el); if (!c || nodeRoot(el) !== el._ownerDocument) return; const [window, t] = c;
    if (attr !== 'id' && !(attr === 'name' && NAMED.has(el.localName))) return;
    const other = el.getAttributeNS(null, attr === 'id' ? 'name' : 'id');
    if (old !== null && other !== old) { del(t, old, el); sync(window, t, old); }
    if (value !== null) { add(t, value, el); sync(window, t, value); }
  };
}
const { fireAnEvent } = require(path.join(JD, 'lib/jsdom/living/helpers/events.js'));
const MessageEventI = require(path.join(JD, 'lib/generated/idl/MessageEvent.js'));
const idlUtils = require(path.join(JD, 'lib/generated/idl/utils.js'));
const { installNetworking, callBridge, callBridgeAsync, reqMeta, toBase64 } = require('./net_bridge');
const { installCanvas, h53 } = require('./cf_canvas');
const { installSurface, S: CHROME_SURFACE } = require('./cf_surface');
const HIDDEN = new WeakMap();   // window (global object + proxy) → tên nội bộ jsdom ẩn khỏi getOwnPropertyNames/ownKeys
// thứ tự + cờ enumerable chuẩn Chrome của mỗi danh sách (CHROME_SURFACE tĩnh) → dựng 1 lần/worker thay vì mỗi interface × realm
const SHAPE_CACHE = new WeakMap();
const shapeOf = (list) => { let c = SHAPE_CACHE.get(list); if (!c) SHAPE_CACHE.set(list, c = { order: list.map((p) => p[0]), EN: new Map(list.map((p) => [p[0], !!p[2]])) }); return c; };
const IFACES = Object.entries(CHROME_SURFACE.ifaces);
// own props của window đúng thứ tự + cờ enumerable như Chrome (CF duyệt getOwnPropertyNames cả chuỗi prototype, so với iframe sạch)
function syncWindowShape(w) {
  const { order: names, EN } = shapeOf(CHROME_SURFACE.window);
  const own = Object.getOwnPropertyNames(w), has = (k) => Object.prototype.hasOwnProperty.call(w, k);
  let i = 0; while (i < own.length && own[i] === names[i]) i++;   // tiền tố đã đúng thứ tự (builtin JS) → giữ nguyên
  const keep = new Set(own.slice(0, i));
  const redefine = (k, en) => { const d = Object.getOwnPropertyDescriptor(w, k); if (!d || !d.configurable) return; delete w[k]; if (en !== undefined) d.enumerable = en; Object.defineProperty(w, k, d); };
  for (const k of names) if (!keep.has(k) && has(k)) redefine(k, EN.get(k));
  const proto = Object.getPrototypeOf(w);
  for (const k of own) if (!EN.has(k) && !keep.has(k)) {
    if (k[0] === '_') redefine(k, false);
    else if (k in proto) { try { delete w[k]; } catch (_) {} }   // bản sao own của thứ Chrome để trên prototype (TEMPORARY…)
    else redefine(k);
  }
  for (const k of ['window', 'document', 'location', 'top']) { const d = Object.getOwnPropertyDescriptor(w, k); if (d && d.configurable) Object.defineProperty(w, k, { configurable: false }); }
  const hide = new Set(Object.getOwnPropertyNames(w).filter((k) => k[0] === '_' && !EN.has(k)));
  HIDDEN.set(w, hide); if (w._globalProxy) HIDDEN.set(w._globalProxy, hide);
}
// prototype/constructor của mọi interface: own props đúng thứ tự + cờ enumerable như Chrome; interface nằm trên chuỗi
// CF duyệt (window/document/navigator/screen…) thì xoá luôn thứ Chrome không có
// thứ Chrome không có trên prototype (ontouch* desktop, ref/unref của Node, bản lặp autofocus…) → xoá; trừ phần env cần:
// jsdom tạo <text>/<tspan> là SVGElement (không có SVGTextContentElement) nên method đo chữ phải nằm ở đây
const PROTO_KEEP = { SVGElement: new Set(['getExtentOfChar', 'getStartPositionOfChar', 'getEndPositionOfChar', 'getRotationOfChar', 'getCharNumAtPosition', 'selectSubString', 'getComputedTextLength', 'getNumberOfChars', 'getSubStringLength']),
  AbstractRange: new Set(['startContainer', 'endContainer']) };
function syncProtoShapes(w) {
  const reorder = (obj, list, strict) => {
    const { order, EN } = shapeOf(list);
    const own = Object.getOwnPropertyNames(obj);
    let i = 0; while (i < own.length && own[i] === order[i]) i++;
    if (i === own.length && i === order.length) return;
    const keep = new Set(own.slice(0, i));
    const redefine = (k, en) => { const d = Object.getOwnPropertyDescriptor(obj, k); if (!d || !d.configurable) return; delete obj[k]; if (en !== undefined) d.enumerable = en; Object.defineProperty(obj, k, d); };
    for (const k of order) if (!keep.has(k) && Object.prototype.hasOwnProperty.call(obj, k)) redefine(k, EN.get(k));
    for (const k of own) if (!EN.has(k) && !keep.has(k)) { if (strict && !(strict instanceof Set && strict.has(k))) { try { delete obj[k]; } catch (_) {} } else redefine(k); }
  };
  for (const [name, I] of IFACES) {
    const d = Object.getOwnPropertyDescriptor(w, name), F = d && d.value;
    if (typeof F !== 'function' || !F.prototype) continue;
    try { reorder(F.prototype, I.proto, PROTO_KEEP[name] || true); } catch (_) {}
  }
}
// class của Node (Streams, Request/Response, MessageChannel…) là object DÙNG CHUNG mọi realm → __proto__ chỉ đúng cho 1 realm,
// CF thấy "không native" và khác iframe sạch. Mỗi realm dựng facade riêng: construct = Reflect.construct(Base, args, new.target)
// (instance mang prototype của realm, internal slot của Node), method/getter bọc lại từng realm.
const NodeET = globalThis.EventTarget;
const UNDICI = new Set(['Request', 'Response', 'Headers']);
// BroadcastChannel/MessageChannel của Node giữ MessagePort bằng global handle tới khi close(); page không close →
// listener ghim instance → prototype realm page → cả window không bao giờ GC (worker tái sử dụng rò). close() đóng hết.
const LIVE_PORTS = [];
function closePorts() {
  for (const p of LIVE_PORTS) try { if (p.port1) { p.port1.close(); p.port2.close(); } else globalThis.BroadcastChannel.prototype.close.call(p); } catch (_) {}
  LIVE_PORTS.length = 0;
}
function realmClass(w, name, Base, mark) {
  const O = w.Object;
  const isET = Base.prototype instanceof NodeET;
  const F = mark(function (...a) {
    if (!new.target) throw new w.TypeError(`Failed to construct '${name}': Please use the 'new' operator, this DOM object constructor cannot be called as a function.`);
    let inst;
    // MessageChannel (C++): tạo port theo creation context của object → phải construct trong context Node rồi mới gắn prototype
    if (name === 'MessageChannel') { inst = new Base(...a); Object.setPrototypeOf(inst, new.target.prototype); }
    else inst = Reflect.construct(Base, a, new.target);
    if (name === 'BroadcastChannel' || name === 'MessageChannel') LIVE_PORTS.push(inst);
    return inst;
  }, name);
  Object.defineProperty(F, 'length', { value: Base.length, configurable: true });
  const wrap = (src, dst, skip) => {
    for (const k of Reflect.ownKeys(src)) {
      if (skip.includes(k)) continue;
      const d = Object.getOwnPropertyDescriptor(src, k), nm = typeof k === 'symbol' ? `[${k.description.replace(/^Symbol\./, '')}]` : k;
      if (typeof d.value === 'function') { const f = d.value; d.value = mark({ [nm](...a) { return f.apply(this, a); } }[nm]); Object.defineProperty(d.value, 'length', { value: f.length, configurable: true }); }
      if (d.get) { const g = d.get; d.get = mark(Object.getOwnPropertyDescriptor({ get [nm]() { return g.call(this); } }, nm).get); }
      if (d.set) { const s = d.set; d.set = mark(Object.getOwnPropertyDescriptor({ set [nm](v) { s.call(this, v); } }, nm).set); }
      Object.defineProperty(dst, k, d);
    }
  };
  // undici (Request/Response/Headers) brand-check bằng instanceof class nội bộ → prototype facade phải nằm trên Base.prototype
  // class EventTarget của Node (MessagePort, BroadcastChannel): kiểm tra internal field/template C++ theo chuỗi gốc → cũng giữ Base.prototype
  const P = O.create(UNDICI.has(name) || isET ? Base.prototype : O.prototype);
  wrap(Base.prototype, P, ['constructor']);
  Object.defineProperty(P, 'constructor', { value: F, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(F, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
  wrap(Base, F, ['length', 'name', 'prototype']);
  Object.setPrototypeOf(F, isET && w.EventTarget ? w.EventTarget : w.Function.prototype);
  // chuỗi gốc Node (Base.prototype → NodeEventTarget…) lộ ra khi duyệt sâu → hàm trên đó cũng phải toString native
  for (let o of [Base, Base.prototype]) for (; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o))
    for (const k of Reflect.ownKeys(o)) { const d = Object.getOwnPropertyDescriptor(o, k); for (const v of [d.value, d.get, d.set]) if (typeof v === 'function') NATIVE.add(v); }
  // Node isEventTarget(obj) = obj.constructor[kIsEventTarget] → mang symbol tĩnh của EventTarget Node
  if (isET) for (const s of Object.getOwnPropertySymbols(NodeET)) if (!Object.prototype.hasOwnProperty.call(F, s)) Object.defineProperty(F, s, { ...Object.getOwnPropertyDescriptor(NodeET, s), enumerable: false });
  return F;
}
// EventTarget.prototype.* của page: object jsdom → gốc; object Node (MessagePort…) → EventTarget Node;
// object khác mà Chrome coi là EventTarget (screen…) → kho listener riêng
const ETgen = require(path.join(JD, 'lib/generated/idl/EventTarget.js'));
const ET_STORE = new WeakMap();
function routeET(w, mark) {
  const E = w.EventTarget.prototype;
  const fb = {
    addEventListener(type, cb, o) { if (!cb) return; let m = ET_STORE.get(this); if (!m) ET_STORE.set(this, m = new Map()); const l = m.get(String(type)) || []; if (!l.some((x) => x.cb === cb)) l.push({ cb, once: !!(o && o.once) }); m.set(String(type), l); },
    removeEventListener(type, cb) { const m = ET_STORE.get(this), l = m && m.get(String(type)); if (l) m.set(String(type), l.filter((x) => x.cb !== cb)); },
    dispatchEvent(ev) { const m = ET_STORE.get(this), l = (m && m.get(ev.type)) || []; for (const x of [...l]) { if (x.once) fb.removeEventListener.call(this, ev.type, x.cb); typeof x.cb === 'function' ? x.cb.call(this, ev) : x.cb.handleEvent(ev); } return !ev.defaultPrevented; },
  };
  for (const m of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
    const orig = E[m], nodeM = NodeET.prototype[m];
    const f = mark({ [m](...a) { return this instanceof NodeET ? nodeM.apply(this, a) : ETgen.is(this) || this === undefined || this === null ? orig.apply(this, a) : fb[m].apply(this, a); } }[m]);
    Object.defineProperty(f, 'length', { value: orig.length, configurable: true });
    Object.defineProperty(E, m, { ...Object.getOwnPropertyDescriptor(E, m), value: f });
  }
}
// document.all = object [[IsHTMLDDA]] (typeof 'undefined', == null, falsy) như Chrome — V8 %GetUndetectable (bật natives syntax lúc biên dịch)
let mkUndetectable = null;
const ALL = new WeakMap();
const ALL_NAMES = new WeakMap();
const ALL_NAMED = new Set(['a', 'button', 'embed', 'form', 'frame', 'frameset', 'iframe', 'img', 'input', 'map', 'meta', 'object', 'select', 'textarea']);
const HTMLCollectionG = require(path.join(JD, 'lib/generated/idl/HTMLCollection.js'));
function fixDocMisc(w, mark) {
  if (!mkUndetectable) { const v8 = require('v8'); v8.setFlagsFromString('--allow-natives-syntax'); try { mkUndetectable = new Function('return %GetUndetectable()'); } finally { v8.setFlagsFromString('--no-allow-natives-syntax'); } }
  const DP = w.Document.prototype, HAC = w.HTMLAllCollection;
  const elems = (doc) => doc.getElementsByTagName('*');
  const allOf = (doc) => {
    let a = ALL.get(doc);
    if (!a) { a = mkUndetectable(); if (HAC) Object.setPrototypeOf(a, HAC.prototype); ALL.set(doc, a); ALL.set(a, doc); }
    const list = elems(doc), n = list.length;   // chỉ số sống: đồng bộ own index mỗi lần lấy document.all
    for (let i = 0; i < n; i++) Object.defineProperty(a, i, { value: list[i], writable: false, enumerable: true, configurable: true });
    for (let i = n; Object.prototype.hasOwnProperty.call(a, i); i++) delete a[i];
    // named property (HTMLAllCollection, [LegacyUnenumerableNamedProperties]): id mọi element + name của a/button/embed/form/…
    // nwsapi dùng document.all[id] cho '#id' → thiếu cái này thì document.querySelectorAll('#id') luôn rỗng
    const byName = new Map();
    for (let i = 0; i < n; i++) { const e = list[i], id = e.getAttribute('id'), nm = ALL_NAMED.has(e.localName) ? e.getAttribute('name') : null;
      for (const k of new Set([id, nm])) if (k) (byName.get(k) || byName.set(k, []).get(k)).push(e); }
    for (const k of ALL_NAMES.get(a) || []) if (!byName.has(k)) delete a[k];
    for (const [k, els] of byName) {
      if (String(k >>> 0) === k) continue;
      const v = els.length === 1 ? els[0] : HTMLCollectionG.create(doc.defaultView, [], { element: idlUtils.implForWrapper(doc).documentElement, query: () => els.map((x) => idlUtils.implForWrapper(x)) });
      Object.defineProperty(a, k, { value: v, writable: false, enumerable: false, configurable: true });
    }
    ALL_NAMES.set(a, [...byName.keys()]);
    return a;
  };
  Object.defineProperty(DP, 'all', { get: mark(Object.getOwnPropertyDescriptor({ get all() { return allOf(this); } }, 'all').get), enumerable: true, configurable: true });
  if (HAC) {
    const P = HAC.prototype, docOf = (a) => { const d = ALL.get(a); if (!d) throw new w.TypeError('Illegal invocation'); return d; };
    const pick = (a, k) => { const d = docOf(a); if (k === undefined) return null; const i = Number(k); if (String(i >>> 0) === String(k)) return elems(d)[i] || null; const m = [...elems(d)].filter((e) => e.id === String(k) || e.getAttribute('name') === String(k)); return m.length ? m[0] : null; };
    Object.defineProperty(P, 'length', { get: mark(Object.getOwnPropertyDescriptor({ get length() { return elems(docOf(this)).length; } }, 'length').get), enumerable: true, configurable: true });
    for (const [k, len] of [['item', 0], ['namedItem', 1]]) { const f = mark({ [k](x) { return pick(this, x); } }[k]); Object.defineProperty(f, 'length', { value: len, configurable: true }); Object.defineProperty(P, k, { value: f, writable: true, enumerable: true, configurable: true }); }
  }
  // document.domain: host của origin (about:blank iframe kế thừa document cha)
  Object.defineProperty(DP, 'domain', { get: mark(Object.getOwnPropertyDescriptor({ get domain() {
    let d = this;
    for (let i = 0; i < 5 && d; i++) { const u = String(d.URL || ''); if (/^https?:/.test(u)) return new URL(u).hostname; const v = d.defaultView; d = v && v.frameElement ? v.frameElement.ownerDocument : null; }
    return '';
  } }, 'domain').get), set: mark(Object.getOwnPropertyDescriptor({ set domain(v) {} }, 'domain').set), enumerable: true, configurable: true });
  // jsdom quên khởi tạo impl field onvisibilitychange → getter trả undefined; Chrome trả null
  { const d = Object.getOwnPropertyDescriptor(DP, 'onvisibilitychange'); if (d && d.get) { const g = d.get; Object.defineProperty(DP, 'onvisibilitychange', { ...d, get: mark(Object.getOwnPropertyDescriptor({ get onvisibilitychange() { const v = g.call(this); return v === undefined ? null : v; } }, 'onvisibilitychange').get) }); } }
  // Screen kế thừa EventTarget như Chrome
  if (w.Screen && Object.getPrototypeOf(w.Screen.prototype) !== w.EventTarget.prototype) { Object.setPrototypeOf(w.Screen.prototype, w.EventTarget.prototype); Object.setPrototypeOf(w.Screen, w.EventTarget); }
  routeET(w, mark);
}
// jsdom: HTMLDocument === Document. Chrome: class con riêng (prototype chỉ có constructor), document là HTMLDocument
function fixHTMLDocument(w, mark) {
  if (w.HTMLDocument !== w.Document) return;
  const D = w.Document;
  const C = mark(function HTMLDocument() { throw new w.TypeError('Illegal constructor'); }, 'HTMLDocument');
  Object.defineProperty(C, 'length', { value: 0, configurable: true });
  Object.setPrototypeOf(C, D);
  const P = Object.create(D.prototype);
  Object.defineProperty(C, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
  Object.defineProperty(P, 'constructor', { value: C, writable: true, enumerable: false, configurable: true });
  Object.defineProperty(P, Symbol.toStringTag, { value: 'HTMLDocument', configurable: true });
  Object.defineProperty(w, 'HTMLDocument', { value: C, writable: true, enumerable: false, configurable: true });
  if (w.document && Object.getPrototypeOf(w.document) === D.prototype) Object.setPrototypeOf(w.document, P);
}
// Object.getOwnPropertyNames / Reflect.ownKeys / Object.getOwnPropertyDescriptors của realm page: bỏ tên nội bộ jsdom trên window
function installReflectFilter(w, mark) {
  const wrap = (obj, name, fn) => {
    const d = Object.getOwnPropertyDescriptor(obj, name), orig = d && d.value;
    if (typeof orig !== 'function') return;
    const f = mark({ [name](...a) { return fn(orig, a); } }[name]);
    Object.defineProperty(f, 'length', { value: orig.length, configurable: true });
    Object.defineProperty(obj, name, { ...d, value: f });
  };
  const filt = (orig, a) => { const r = orig.apply(undefined, a), h = HIDDEN.get(a[0]); return h ? r.filter((k) => !h.has(k)) : r; };
  wrap(w.Object, 'getOwnPropertyNames', filt);
  wrap(w.Reflect, 'ownKeys', filt);
  wrap(w.Object, 'getOwnPropertyDescriptors', (orig, a) => { const r = orig.apply(undefined, a), h = HIDDEN.get(a[0]); if (h) for (const k of h) delete r[k]; return r; });
}
const { installJsEngine } = require('./cf_jsengine');
const { installTemporal } = require('./cf_temporal');
const SHADOWS = [];   // mọi shadow root (impl) — để tìm checkbox khi interactive
// jsdom không "attach" ShadowRoot → iframe trong shadow root không có contentWindow (Chrome thì có:
// shadow-including connected). Attach shadow root theo host.
{
  const EI = require(path.join(JD, 'lib/jsdom/living/nodes/Element-impl.js')).implementation.prototype;
  const { _attach, _detach, attachShadow } = EI;
  EI._attach = function () { _attach.call(this); if (this._shadowRoot && !this._shadowRoot._attached) this._shadowRoot._attach(); };
  EI._detach = function () { _detach.call(this); if (this._shadowRoot && this._shadowRoot._attached) this._shadowRoot._detach(); };
  EI.attachShadow = function (init) { const sr = attachShadow.call(this, init); if (this._attached && sr && !sr._attached) sr._attach(); SHADOWS.push(sr); return sr; };
}
// ---- đồng hồ như Chrome (không cross-origin-isolated): TimeClamper 100µs + jitter ----
let CLAMP_SECRET = crypto.randomBytes(4).readUInt32LE(0);   // makeDom đổi mỗi solve (giữ hành vi cũ: process mới = secret mới)
function clampMs(ms) {
  const iv = 1e-4, s = ms / 1000, c = Math.floor(s / iv) * iv;
  let h = Math.imul((Math.round(c / iv) ^ CLAMP_SECRET) >>> 0, 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0;
  return (s >= c + iv * (h / 4294967296) ? c + iv : c) * 1000;
}
{
  const PI = require(path.join(JD, 'lib/jsdom/living/hr-time/Performance-impl.js')).implementation.prototype;
  const now = PI.now;
  PI.now = function () { return clampMs(now.call(this)); };
  // Event.timeStamp: DOMHighResTimeStamp theo timeOrigin của realm (jsdom để Date.now() epoch)
  const EI = require(path.join(JD, 'lib/jsdom/living/events/Event-impl.js')).implementation.prototype;
  Object.defineProperty(EI, 'timeStamp', { configurable: true,
    set(v) { let t; try { t = this._globalObject.performance.now(); } catch (_) {} this._ts = typeof t === 'number' ? t : v; },
    get() { return this._ts; } });
}
const NATIVE = new WeakSet();   // hàm env → toString '[native code]'
let WALKED = new WeakSet();     // đã walk → skip trong iframe sau (prototype jsdom dùng chung) — reset mỗi solve
// Object realm Node (class/impl jsdom dùng chung, cả Function của Node) bị nối __proto__ sang realm page của solve.
// Worker tái sử dụng: phải trả lại khi solve xong — nếu không realm Node trỏ mãi vào window solve đầu
// (rò ~45MB/solve, window không bao giờ được GC) và solve sau thấy prototype thuộc realm của solve khác.
const REPARENTED = [];          // [obj, protoGốc, obj, protoGốc, ...]
const reparent = (o, from, to) => { Object.setPrototypeOf(o, to); REPARENTED.push(o, from); };
function restoreProtos() {
  for (let i = REPARENTED.length - 2; i >= 0; i -= 2) try { Object.setPrototypeOf(REPARENTED[i], REPARENTED[i + 1]); } catch (_) {}
  REPARENTED.length = 0;
}
const BLOBS = new Map();
const RESIZE = new WeakMap();   // window → hàm đổi innerWidth/innerHeight (không lộ property)
const VISIBLE = new WeakMap();  // window → widget đang hiện (sau interactiveBegin)
const LAYOUT = new WeakMap(), LAYOUT_LIST = [];   // element → [x,y,w,h] (layout giả cho widget)
// iframe con (loadFrame → createWindow): áp env y như window chính trước khi ai chạm vào
let frameSetup = null;
// đặt lại đồng hồ realm: performance.now() lúc này = nowMs (timeOrigin như Chrome: đầu navigation / lúc chèn iframe)
function rebaseClock(win, nowMs) {
  const pi = idlUtils.implForWrapper(win.performance), at = performance.now() - nowMs;
  pi._nowAtTimeOrigin = at; pi.timeOrigin = Math.round((performance.timeOrigin + at) * 10) / 10;
}
// pool iframe about:blank dựng sẵn (jsdom + setup ~40-70ms/window, Chrome ~1ms) → CF chèn iframe là có ngay
// used: frame CF đã lấy trong solve này; expect: số frame 1 solve cần — học từ solve thành công trong worker (build b = 7).
// Không nạp dư: bản cũ luôn giữ 3 frame dự phòng → cuối mỗi solve 3 frame thừa (~450ms CPU + ~45MB).
const FRAME_POOL = { opts: null, list: [], used: 0, expect: Infinity, fill: () => {} };
// mọi window frame dựng trong solve hiện tại → close() khi solve xong (worker tái sử dụng: dừng timer/rAF, trả RAM)
const CREATED = [];
let LAST_MAIN = null;   // window chính của solve hiện tại (JSDOM tạo nó bằng createWindow gốc, không qua make)
const POOL_KEYS = ['parentOrigin', 'dispatcher', 'loadSubresources', 'userAgent', 'referrer', 'cookieJar', 'pool', 'encoding', 'runScripts', 'commonForOrigin', 'pretendToBeVisual'];
{
  const WM = require(path.join(JD, 'lib/jsdom/browser/Window.js'));
  const createWindow = WM.createWindow;
  const make = (opts) => { const win = createWindow.call(WM, opts); CREATED.push(win); if (frameSetup) frameSetup(win._globalProxy || win); return win; };
  WM.createWindow = function (opts) {
    const P = FRAME_POOL;
    const ours = P.opts && opts.url === 'about:blank' && POOL_KEYS.every((k) => opts[k] === P.opts[k]);
    if (ours) P.used++;
    if (ours && P.list.length) {
      const win = P.list.shift();
      rebaseClock(win, 0.2);
      if (P.list.length < 3) setTimeout(() => P.fill(P.list.length + 1), 20);   // bù từng cái một, lúc rảnh
      return win;
    }
    return make(opts);
  };
  FRAME_POOL.fill = (n) => { const P = FRAME_POOL; while (P.opts && P.list.length < n && P.used + P.list.length < P.expect) P.list.push(make(P.opts)); };
}
// Response của fetch: url/type thật (instance tạo bằng constructor có url '' / type 'default')
const RESP = new WeakMap();
for (const k of ['url', 'type']) {
  const g = Object.getOwnPropertyDescriptor(Response.prototype, k).get;
  Object.defineProperty(Response.prototype, k, { get: mark(Object.getOwnPropertyDescriptor({ get [k]() { const r = RESP.get(this); return r ? r[k] : g.call(this); } }, k).get), enumerable: true, configurable: true });
}
// transport của jsdom (XHR, iframe/script/img subresource) → curl_cffi bridge (TLS/H2 Chrome, proxy)
const HOP = new Set(['user-agent', 'accept-language', 'accept-encoding', 'cookie', 'connection', 'host', 'content-length']);
const DEST = { img: 'image', image: 'image', script: 'script', link: 'style', iframe: 'iframe', frame: 'iframe', audio: 'audio', video: 'video' };
const bridgeInterceptor = (docOrigin, log, solveId) => requestInterceptor(async (req, { element }) => {
  const m = reqMeta(req.url, docOrigin), method = req.method.toUpperCase();
  // Xây header theo thứ tự Chrome: JS-set trước, sec-fetch-* + origin sau
  const h = {};
  req.headers.forEach((v, k) => { if (!HOP.has(k)) h[k] = v; });
  if (h.referer && !m.sameOrigin) delete h.referer;   // Referrer-Policy: same-origin
  const dest = element ? DEST[element.localName] || 'empty' : 'empty';
  const isNav = element && dest === 'iframe';
  if (isNav) {
    // navigate: Upgrade-Insecure-Requests + Priority như Chrome iframe navigation
    h['upgrade-insecure-requests'] = '1';
    h['priority'] = 'u=0, i';
    h['sec-fetch-storage-access'] = 'active';
  }
  Object.assign(h, { 'sec-fetch-site': m.site, 'sec-fetch-mode': isNav ? 'navigate' : (element ? 'no-cors' : 'cors'), 'sec-fetch-dest': dest });
  if (!element && (!m.sameOrigin || (method !== 'GET' && method !== 'HEAD'))) h.origin = docOrigin;
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  if (process.env.NETLOG) log(`[xhr] ${method} ${req.url.slice(0, 140)} body=${body ? body.length : 0}${element ? ' el=' + element.localName : ''}`);
  if (process.env.EBLOG && body && req.url.includes('/g/eb/')) { log(`[eb body hex] ${body.slice(0, 120).toString('hex')}`); try { log(`[eb body str] ${body.toString('utf8').slice(0, 300)}`); } catch(_){} }
  const r = await callBridgeAsync({ method, url: req.url, headers: h, body: toBase64(body), impersonate: process.env.CF_IMP || 'chrome146', proxy: process.env.CF_PROXY || null, solve_id: solveId });
  if (r.error) { log(`[xhr] !! ${r.error} ${req.url.slice(0, 110)}`); return Response.error(); }
  const out = Buffer.from(r.body || '', 'base64');
  if (process.env.NETLOG) log(`[xhr] <- ${r.status} len=${out.length} ${req.url.slice(0, 110)}`);
  const hdrs = Object.entries(r.headers || {}).filter(([k]) => !/^(content-encoding|content-length|transfer-encoding)$/i.test(k)).map(([k, v]) => [k, String(v)]);
  return new Response([101, 204, 205, 304].includes(r.status) ? null : out, { status: r.status, headers: hdrs });
});
const callBridgeGet = (u, solveId) => callBridge({ method: 'GET', url: u, headers: { 'Sec-Fetch-Dest': 'worker', 'Sec-Fetch-Mode': 'same-origin', 'Sec-Fetch-Site': 'same-origin' }, impersonate: process.env.CF_IMP || 'chrome146', proxy: process.env.CF_PROXY || null, solve_id: solveId }).body || '';

// ---- native toString ---------------------------------------------------------
const nativeStr = (fn) => /^bound /.test(fn.name) ? 'function () { [native code] }' : `function ${fn.name || ''}() { [native code] }`;
function mark(fn, name) {
  if (name !== undefined) try { Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (_) {}
  NATIVE.add(fn);
  return fn;
}
function patchToString(FP) {
  const real = FP.toString;
  if (NATIVE.has(real)) return;
  const ts = mark({ toString() { return NATIVE.has(this) ? nativeStr(this) : real.call(this); } }.toString, 'toString');
  Object.defineProperty(FP, 'toString', { value: ts, writable: true, configurable: true, enumerable: false });
}
patchToString(Function.prototype);   // realm Node: class/hàm jsdom sống ở đây

// ---- Error.stack: bỏ frame không phải https (Node shim, jsdom, node:internal) ----
// Node gọi Error.prepareStackTrace của main realm cho lỗi từ vm context nếu context không tự đặt.
Error.prepareStackTrace = (err, cs) => {
  const web = (c) => /^https?:/.test(c.getFileName() || '');
  const keep = cs.some(web) ? cs.filter((c) => web(c) || !c.getFileName()) : cs;   // giữ frame builtin/eval (không file)
  let head; try { head = String(err); } catch (_) { head = 'Error'; }
  return head + keep.map((c) => '\n    at ' + c).join('');
};

function makeDom({ html, url, referrer, parentOrigin, fp, log = () => {}, onParentMessage, traceTimers = false, navTiming, solveId = '' }) {
  // worker tái sử dụng chạy các solve NỐI TIẾP (không song song trong 1 thread) → state cấp module của solve trước bỏ đi;
  // solve trước lỗi giữa chừng (chưa close) → đóng nốt window của nó, không để timer/rAF chạy mãi
  for (const win of [...CREATED, LAST_MAIN]) if (win) try { win.close(); } catch (_) {}
  LAST_MAIN = null;
  SHADOWS.length = 0; LAYOUT_LIST.length = 0; BLOBS.clear(); CREATED.length = 0;
  restoreProtos(); WALKED = new WeakSet();   // realm Node sạch như process mới → solve này nối vào realm CỦA NÓ
  closePorts();
  CLAMP_SECRET = crypto.randomBytes(4).readUInt32LE(0);
  const WK_STATES = [];   // Worker giả của solve này → đánh dead khi close (timer của chúng là timer Node, window.close không dừng)
  const env = fp.env || fp, uach = fp.uach || {};
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => log('[jsdomError]', e.message, ((e.detail && e.detail.stack) || e.stack || '').split('\n').slice(0, 5).join(' | ')));
  // KHÔNG format tham số console của page: CF đặt bẫy '%c%d' + object có toString/valueOf để phát hiện
  // DevTools mở (Chrome khi DevTools đóng không đụng tới tham số). Chỉ in chuỗi thuần.
  for (const t of ['log', 'warn', 'error', 'info']) vc.on(t, (...a) => { if (typeof a[0] === 'string' && !a[0].includes('%') && a.every((x) => typeof x !== 'object' && typeof x !== 'function')) log(`[page.${t}]`, a.join(' ').slice(0, 300)); });

  let mainW, parentWin;

  // áp cho window chính và MỌI iframe con (realm sạch CF dùng để so native phải cùng env)
  let _setupCount = 0;
  function setup(win, isFrame = false) {
    const _t0 = Date.now(), _n = ++_setupCount;
    const w = win;
    if (!isFrame) mainW = w;
    const toPage = (x) => (x === undefined ? undefined : w.JSON.parse(JSON.stringify(x)));   // structured clone vào realm này
    patchToString(w.Function.prototype);
    installJsEngine(w, { mark, log });
    const O = w.Object, WF = w.Function;
    // hàm LÁ tạo mới cho realm này (method/getter/setter, không có con cần duyệt): nối proto page + đánh dấu walk ngay
    // khi tạo → walk bỏ qua, khỏi ghi REPARENTED rồi hoàn tác (chúng chết cùng window). Kết quả y như để walk làm.
    const own = (fn, name) => { mark(fn, name); try { Object.setPrototypeOf(fn, WF.prototype); } catch (_) {} WALKED.add(fn); return fn; };
    // accessor kiểu WebIDL (tên getter "get x", không có prototype)
    const acc = (obj, name, get) => {
      const g = mark(Object.getOwnPropertyDescriptor({ get [name]() { return get.call(this); } }, name).get);
      try { Object.defineProperty(obj, name, { get: g, set: undefined, enumerable: true, configurable: true }); }
      catch (e) { log('[acc] không redefine được', name, e.message); }
    };
    const method = (obj, name, fn, length) => {
      const m = mark({ [name](...a) { return fn.apply(this, a); } }[name]);
      if (length !== undefined) Object.defineProperty(m, 'length', { value: length, configurable: true });
      Object.defineProperty(obj, name, { value: m, writable: true, enumerable: true, configurable: true });
      return m;
    };
    // interface mới (Chrome có, jsdom không): ctor ném Illegal constructor, prototype thuộc realm page
    const iface = (name, parent) => {
      const C = mark(function () { throw new w.TypeError('Illegal constructor'); }, name);
      Object.setPrototypeOf(C, parent || WF.prototype);
      const P = O.create(parent ? parent.prototype : O.prototype);
      Object.defineProperty(C, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
      Object.defineProperty(P, 'constructor', { value: C, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(P, w.Symbol.toStringTag, { value: name, configurable: true });
      Object.defineProperty(w, name, { value: C, writable: true, enumerable: false, configurable: true });
      return C;
    };
    const DOMEx = (msg, n) => new w.DOMException(msg, n);

    // ---- navigator ----------------------------------------------------------
    const NP = w.Navigator.prototype;
    const langs = O.freeze(w.Array.from(env.languages || ['en-US']));
    const navVals = {
      userAgent: env.userAgent, appVersion: env.appVersion || String(env.userAgent).replace(/^Mozilla\//, ''),
      platform: env.platform || 'Win32', vendor: env.vendor || 'Google Inc.', vendorSub: '', product: 'Gecko',
      productSub: '20030107', appName: 'Netscape', appCodeName: 'Mozilla', language: langs[0], languages: langs,
      hardwareConcurrency: env.hardwareConcurrency || 8, deviceMemory: env.deviceMemory || 8,
      maxTouchPoints: env.maxTouchPoints || 0, webdriver: false, cookieEnabled: true, onLine: true,
      doNotTrack: null, pdfViewerEnabled: true,
    };
    for (const [k, v] of Object.entries(navVals)) acc(NP, k, () => v);

    const UAD = iface('NavigatorUAData');
    const brands = uach.brands || [{ brand: 'Chromium', version: '153' }];
    const lowUA = () => ({ brands, mobile: !!uach.mobile, platform: uach.platform || 'Windows' });
    acc(UAD.prototype, 'brands', () => toPage(brands));
    acc(UAD.prototype, 'mobile', () => !!uach.mobile);
    acc(UAD.prototype, 'platform', () => uach.platform || 'Windows');
    method(UAD.prototype, 'getHighEntropyValues', (hints) => {
      const out = lowUA();
      for (const h of Array.from(hints || [])) if (h in uach) out[h] = uach[h];
      if ([].includes.call(hints || [], 'fullVersionList') && uach.fullVersionList) out.fullVersionList = uach.fullVersionList;
      return w.Promise.resolve(toPage(out));
    }, 1);
    method(UAD.prototype, 'toJSON', () => toPage(lowUA()), 0);
    const uad = O.create(UAD.prototype);
    acc(NP, 'userAgentData', () => uad);

    // plugins / mimeTypes: 5 PDF plugin như Chrome desktop
    const PL = iface('Plugin'), MT = iface('MimeType'), DATA = new WeakMap();
    for (const k of ['name', 'filename', 'description', 'length']) acc(PL.prototype, k, function () { return DATA.get(this)[k]; });
    for (const k of ['type', 'suffixes', 'description', 'enabledPlugin']) acc(MT.prototype, k, function () { return DATA.get(this)[k]; });
    const mkList = (proto, items, keyOf) => {
      const o = O.create(proto);
      items.forEach((it, i) => Object.defineProperty(o, i, { value: it, enumerable: true, configurable: true }));
      items.forEach((it) => Object.defineProperty(o, keyOf(it), { value: it, enumerable: false, configurable: true }));
      DATA.set(o, { items, length: items.length });
      return o;
    };
    const plugNames = env.plugins || ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    const mimeDefs = [['application/pdf', 'pdf'], ['text/pdf', 'pdf']];
    const plugins = plugNames.map((n) => { const p = O.create(PL.prototype); DATA.set(p, { name: n, filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 }); return p; });
    const mimes = mimeDefs.map(([t, s]) => { const m = O.create(MT.prototype); DATA.set(m, { type: t, suffixes: s, description: 'Portable Document Format', enabledPlugin: plugins[0] }); return m; });
    plugins.forEach((p) => mimes.forEach((m, i) => Object.defineProperty(p, i, { value: m, enumerable: true, configurable: true })));
    for (const [Arr, items, keyOf] of [[w.PluginArray, plugins, (p) => DATA.get(p).name], [w.MimeTypeArray, mimes, (m) => DATA.get(m).type]]) {
      acc(Arr.prototype, 'length', function () { return DATA.get(this).length; });
      method(Arr.prototype, 'item', function (i) { return DATA.get(this).items[i >>> 0] || null; }, 1);
      method(Arr.prototype, 'namedItem', function (n) { return DATA.get(this).items.find((x) => keyOf(x) === String(n)) || null; }, 1);
      Object.defineProperty(Arr.prototype, w.Symbol.iterator, { value: w.Array.prototype.values, writable: true, configurable: true });
    }
    method(w.PluginArray.prototype, 'refresh', () => undefined, 0);
    const pluginArr = mkList(w.PluginArray.prototype, plugins, (p) => DATA.get(p).name);
    const mimeArr = mkList(w.MimeTypeArray.prototype, mimes, (m) => DATA.get(m).type);
    acc(NP, 'plugins', () => pluginArr);
    acc(NP, 'mimeTypes', () => mimeArr);

    const conn = O.create(iface('NetworkInformation', w.EventTarget).prototype);
    // Chrome đo được: downlink=1.4 Mbps, rtt=100ms (bội 25 như Chrome làm tròn — CYsxg7/zYUn5)
    const connVals = { downlink: env.connection && env.connection.downlink != null ? env.connection.downlink : 1.4, effectiveType: '4g', rtt: env.connection && env.connection.rtt != null ? env.connection.rtt : 100, saveData: false };
    for (const [k, v] of Object.entries(connVals)) acc(w.NetworkInformation.prototype, k, () => v);
    acc(NP, 'connection', () => conn);
    const perms = O.create(iface('Permissions').prototype);
    // Cross-origin iframe: phần lớn quyền bị Permissions Policy chặn → "denied" (xVwa3)
    const _PERM_DENIED = new Set(['geolocation','camera','microphone','notifications','push','midi','clipboard-read','clipboard-write','payment-handler','screen-wake-lock','idle-detection','local-fonts','window-management','display-capture','captured-surface-control','keyboard-lock','speaker-selection','top-level-storage-access','accelerometer','gyroscope','magnetometer','pointer-lock']);
    const _PERM_VALID = new Set([..._PERM_DENIED,'background-sync','persistent-storage','storage-access']);
    method(w.Permissions.prototype, 'query', (d) => {
      const name = d && d.name;
      if (!_PERM_VALID.has(name)) return w.Promise.reject(new w.TypeError(`Failed to execute 'query' on 'Permissions': Failed to read the 'name' property from 'PermissionDescriptor': The provided value '${name}' is not a valid enum value of type PermissionName.`));
      return w.Promise.resolve(toPage({ name, state: _PERM_DENIED.has(name) ? 'denied' : 'prompt', onchange: null }));
    }, 1);
    acc(NP, 'permissions', () => perms);

    // ---- screen / window metrics (thật từ capture) ---------------------------
    const s = env.screen || {};
    const scr = { width: s.width || 1920, height: s.height || 1080, availWidth: s.availWidth || 1920, availHeight: s.availHeight || 1040,
      availLeft: 0, availTop: 0, colorDepth: s.colorDepth || 24, pixelDepth: s.pixelDepth || 24, isExtended: false };
    for (const [k, v] of Object.entries(scr)) acc(w.Screen.prototype, k, () => v);
    const wm = env.window || {};
    const winVals = { innerWidth: wm.innerWidth || 0, innerHeight: wm.innerHeight || 0, outerWidth: wm.outerWidth || 1313,
      outerHeight: wm.outerHeight || 931, screenX: wm.screenX || 0, screenY: wm.screenY || 0, screenLeft: wm.screenX || 0,
      screenTop: wm.screenY || 0, devicePixelRatio: env.devicePixelRatio || 1 };
    // [Replaceable] như Chrome: có setter, gán thì thành own data property
    const repl = (name, get) => Object.defineProperty(w, name, { enumerable: true, configurable: true,
      get: mark(Object.getOwnPropertyDescriptor({ get [name]() { return get.call(this); } }, name).get),
      set: mark(Object.getOwnPropertyDescriptor({ set [name](v) { Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true }); } }, name).set) });
    for (const k of Object.keys(winVals)) repl(k, () => winVals[k]);
    { const pg = Object.getOwnPropertyDescriptor(w, 'performance'); if (pg && pg.get && !pg.set) repl('performance', pg.get); }
    // window.name: accessor (jsdom để data property)
    { const d = Object.getOwnPropertyDescriptor(w, 'name'); if (d && 'value' in d) { let nm = String(d.value); Object.defineProperty(w, 'name', { enumerable: true, configurable: true,
      get: mark(Object.getOwnPropertyDescriptor({ get name() { return nm; } }, 'name').get), set: mark(Object.getOwnPropertyDescriptor({ set name(v) { nm = String(v); } }, 'name').set) }); } }
    RESIZE.set(w, (wd, ht) => { winVals.innerWidth = wd; winVals.innerHeight = ht; });   // widget hiện ra (interactive)

    // ---- cross-origin parent/top --------------------------------------------
    const postMessage = mark({ postMessage(message) {
      const clone = JSON.parse(JSON.stringify(message));
      setTimeout(() => { try { onParentMessage(clone); } catch (e) { log('[parent] handler err', e.stack); } }, 0);
    } }.postMessage);
    const xo = Object.create(null);
    const XO_OK = { postMessage, closed: false, length: 1, opener: null,
      blur: mark({ blur() {} }.blur), focus: mark({ focus() {} }.focus), close: mark({ close() {} }.close) };
    if (!isFrame) parentWin = new Proxy(xo, {
      get(_, k) {
        if (k in XO_OK) return XO_OK[k];
        if (k === 'window' || k === 'self' || k === 'frames' || k === 'top' || k === 'parent') return parentWin;
        if (k === 'then' || typeof k === 'symbol') return undefined;
        throw DOMEx(`Failed to read a named property '${String(k)}' from 'Window': Blocked a frame with origin "${new URL(url).origin}" from accessing a cross-origin frame.`, 'SecurityError');
      },
      set() { throw DOMEx('Blocked a frame from accessing a cross-origin frame.', 'SecurityError'); },
      has(_, k) { return k in XO_OK || ['window', 'self', 'frames', 'top', 'parent'].includes(k); },
      getPrototypeOf: () => null,
    });
    // top là [LegacyUnforgeable] (non-configurable) → đổi field nội bộ jsdom, giữ getter native
    if (!isFrame) w._top = w._parent = parentWin;   // frame con: jsdom tự set _parent=window chính, _top=parent.top
    // location.ancestorOrigins (Chrome-only)
    const anc = O.create(iface('DOMStringList').prototype);
    Object.defineProperty(anc, 0, { value: parentOrigin, enumerable: true });
    acc(w.DOMStringList.prototype, 'length', () => 1);
    method(w.DOMStringList.prototype, 'item', (i) => (i == 0 ? parentOrigin : null), 1);
    method(w.DOMStringList.prototype, 'contains', (x) => x === parentOrigin, 1);
    try { acc(w.location, 'ancestorOrigins', () => anc); } catch (_) {}

    // ---- network: mọi request đi qua curl_cffi bridge -----------------------
    const net = {};
    installNetworking(net, { referer: url, origin: new URL(url).origin, impersonate: process.env.CF_IMP || 'chrome146', proxy: process.env.CF_PROXY || undefined, solveId });
    // XMLHttpRequest: giữ class gốc của jsdom (đúng prototype/event trusted), transport = bridgeInterceptor
    // fetch: Response thật (undici) — url/type thật qua WeakMap, instance không có own prop
    for (const n of ['Headers', 'Request', 'Response']) if (!(n in w)) Object.defineProperty(w, n, { value: realmClass(w, n, globalThis[n], mark), writable: true, configurable: true, enumerable: false });
    const nodeFetch = net.fetch;
    const toResponse = async (r) => {
      const buf = await r.arrayBuffer();
      const resp = Reflect.construct(Response, [[101, 204, 205, 304].includes(r.status) ? null : buf, { status: r.status, statusText: r.statusText, headers: [...r.headers] }], w.Response);
      RESP.set(resp, { url: r.url, type: r.type });
      return resp;
    };
    Object.defineProperty(w, 'fetch', { value: mark({ async fetch(u, o) {
      const us = String(u && u.url ? u.url : u);
      let resp; try { resp = await nodeFetch(us, o).then(toResponse); } catch(ex) { throw new w.TypeError('Failed to fetch'); }
      return resp;
    } }.fetch), writable: true, configurable: true, enumerable: true });
    method(NP, 'sendBeacon', net.navigator.sendBeacon, 1);

    // ---- canvas 2D / WebGL1 / WebGL2: đủ bề mặt API như Chrome (cf_canvas.js) ----
    installCanvas(w, { mark, method, acc, iface, env, toPage });

    // ---- SVG geometry: getBBox từ hình học thật của shape con (jsdom không có layout) ----
    const num = (el, a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : d; };
    const shapeBox = (el) => {
      const t = el.localName;
      if (t === 'circle') { const r = num(el, 'r'); return [num(el, 'cx') - r, num(el, 'cy') - r, num(el, 'cx') + r, num(el, 'cy') + r]; }
      if (t === 'ellipse') { const rx = num(el, 'rx'), ry = num(el, 'ry'); return [num(el, 'cx') - rx, num(el, 'cy') - ry, num(el, 'cx') + rx, num(el, 'cy') + ry]; }
      if (t === 'rect' || t === 'image' || t === 'use' || t === 'foreignObject') return [num(el, 'x'), num(el, 'y'), num(el, 'x') + num(el, 'width'), num(el, 'y') + num(el, 'height')];
      if (t === 'line') return [Math.min(num(el, 'x1'), num(el, 'x2')), Math.min(num(el, 'y1'), num(el, 'y2')), Math.max(num(el, 'x1'), num(el, 'x2')), Math.max(num(el, 'y1'), num(el, 'y2'))];
      if (t === 'path' || t === 'polygon' || t === 'polyline') {
        const nums = (el.getAttribute(t === 'path' ? 'd' : 'points') || '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
        const xs = [], ys = []; for (let i = 0; i + 1 < nums.length; i += 2) { xs.push(+nums[i]); ys.push(+nums[i + 1]); }
        return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
      }
      if (t === 'text' || t === 'tspan') { const len = (el.textContent || '').length * 7.2; return [num(el, 'x'), num(el, 'y') - 12, num(el, 'x') + len, num(el, 'y') + 3]; }
      let b = null;   // g / svg / a …: hợp các con
      for (const c of el.children) { const cb = shapeBox(c); if (cb) b = b ? [Math.min(b[0], cb[0]), Math.min(b[1], cb[1]), Math.max(b[2], cb[2]), Math.max(b[3], cb[3])] : cb; }
      return b;
    };
    // ---- layout tối thiểu (jsdom không layout): rect cho phần tử widget đã đăng ký + hit-test ----
    const rectOf = (el) => {
      const r = LAYOUT.get(el);
      if (r) return r;
      if (!VISIBLE.get(w)) return null;
      const root = el.getRootNode && el.getRootNode();
      return root && root !== w.document && root.host ? [0, 0, winVals.innerWidth, winVals.innerHeight] : null;   // phần tử khác trong widget: cả khung
    };
    const GBCR = w.Element.prototype.getBoundingClientRect;
    method(w.Element.prototype, 'getBoundingClientRect', function () { const r = rectOf(this); return r ? new w.DOMRect(r[0], r[1], r[2], r[3]) : GBCR.call(this); }, 0);
    const hitDeep = (x, y) => {
      if (!VISIBLE.get(w) || x < 0 || y < 0 || x >= winVals.innerWidth || y >= winVals.innerHeight) return null;
      let best = null;
      for (const [el, r] of LAYOUT_LIST) if (el.isConnected && x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3] && (!best || r[2] * r[3] < best[1][2] * best[1][3])) best = [el, r];
      return best ? best[0] : w.document.body;
    };
    const retarget = (el, scope) => { while (el && el.getRootNode() !== scope && el.getRootNode().host) el = el.getRootNode().host; return el; };
    const efp = (scope) => function (x, y) { return retarget(hitDeep(+x, +y), scope === 'doc' ? w.document : this); };
    method(w.Document.prototype, 'elementFromPoint', function (x, y) { return efp('doc').call(this, x, y); }, 2);
    method(w.Document.prototype, 'elementsFromPoint', function (x, y) { const e = efp('doc').call(this, x, y); const out = []; for (let n = e; n; n = n.parentElement) out.push(n); return w.Array.from(out); }, 2);
    method(w.ShadowRoot.prototype, 'elementFromPoint', function (x, y) { return efp('sr').call(this, x, y); }, 2);
    method(w.ShadowRoot.prototype, 'elementsFromPoint', function (x, y) { const e = efp('sr').call(this, x, y); const out = []; for (let n = e; n; n = n.parentElement) out.push(n); return w.Array.from(out); }, 2);

    // <text>/<tspan> trong jsdom là SVGElement chung → đặt method text lên SVGElement
    const charBox = (el, i) => { const x0 = parseFloat(el.getAttribute('x')) || 0, y0 = parseFloat(el.getAttribute('y')) || 0; return [x0 + i * 7.2, y0 - 12, 7.2, 15]; };
    if (w.SVGElement) for (const [n, f, l] of [
      ['getExtentOfChar', function (i) { const b = charBox(this, i >>> 0); return new w.DOMRect(b[0], b[1], b[2], b[3]); }, 1],
      ['getStartPositionOfChar', function (i) { const b = charBox(this, i >>> 0); return new w.DOMPoint(b[0], b[1] + 12); }, 1],
      ['getEndPositionOfChar', function (i) { const b = charBox(this, i >>> 0); return new w.DOMPoint(b[0] + b[2], b[1] + 12); }, 1],
      ['getRotationOfChar', function () { return 0; }, 1], ['getCharNumAtPosition', function () { return -1; }, 1], ['selectSubString', function () {}, 2],
      ['getComputedTextLength', function () { return (this.textContent || '').length * 7.2; }, 0],
      ['getNumberOfChars', function () { return (this.textContent || '').length; }, 0], ['getSubStringLength', function (a, n) { return Math.max(0, Math.min(n, (this.textContent || '').length - a)) * 7.2; }, 2]])
      if (!(n in w.SVGElement.prototype)) method(w.SVGElement.prototype, n, f, l);
    // ImageData (jsdom không có khi thiếu gói canvas)
    if (!w.ImageData) {
      const ID = mark(function ImageData(a, b, c) {
        if (!new.target) throw new w.TypeError("Failed to construct 'ImageData': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
        const isData = a && typeof a === 'object';
        const wd = isData ? b >>> 0 : a >>> 0, ht = isData ? (c !== undefined ? c >>> 0 : (a.length / 4 / wd) >>> 0) : b >>> 0;
        if (!wd || !ht) throw new w.DOMException("Failed to construct 'ImageData': The source width is zero or not a number.", 'IndexSizeError');
        DATA.set(this, { data: isData ? a : new w.Uint8ClampedArray(wd * ht * 4), width: wd, height: ht });
      }, 'ImageData');
      Object.setPrototypeOf(ID, WF.prototype); Object.setPrototypeOf(ID.prototype, O.prototype);
      for (const k of ['data', 'width', 'height']) acc(ID.prototype, k, function () { return DATA.get(this)[k]; });
      acc(ID.prototype, 'colorSpace', () => 'srgb');
      Object.defineProperty(ID.prototype, w.Symbol.toStringTag, { value: 'ImageData', configurable: true });
      Object.defineProperty(w, 'ImageData', { value: ID, writable: true, configurable: true, enumerable: false });
    }
    if (w.SVGGraphicsElement) {
      const SGP = w.SVGGraphicsElement.prototype;
      method(SGP, 'getBBox', function () { const b = shapeBox(this) || [0, 0, 0, 0]; return new w.DOMRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); }, 0);
      if (w.SVGGeometryElement) method(w.SVGGeometryElement.prototype, 'getTotalLength', function () { const b = shapeBox(this) || [0, 0, 0, 0]; return 2 * ((b[2] - b[0]) + (b[3] - b[1])); }, 0);
      if (w.SVGTextContentElement) method(w.SVGTextContentElement.prototype, 'getComputedTextLength', function () { return (this.textContent || '').length * 7.2; }, 0);
    }

    // document.fonts: do cf_surface lo (getter trên Document.prototype như Chrome, check/load replay từ Chrome thật)

    // ---- Chrome-only globals mà jsdom thiếu ----------------------------------
    const def = (name, v) => { if (!(name in w)) Object.defineProperty(w, name, { value: v, writable: true, configurable: true, enumerable: true }); };
    // thuộc tính chỉ đọc của Window (getter, không setter) như Chrome
    const ro = (name, v) => { if (!(name in w)) Object.defineProperty(w, name, { get: mark(Object.getOwnPropertyDescriptor({ get [name]() { return v; } }, name).get), enumerable: true, configurable: true }); };
    def('chrome', toPage({ app: { isInstalled: false, InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' }, RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' } } }));
    w.chrome.csi = mark({ csi() { return toPage({ startE: Date.now(), onloadT: Date.now(), pageT: performance.now(), tran: 15 }); } }.csi);
    w.chrome.loadTimes = mark({ loadTimes() { return toPage({ connectionInfo: 'h2', npnNegotiatedProtocol: 'h2', wasNpnNegotiated: true, wasFetchedViaSpdy: true }); } }.loadTimes);
    const TTF = iface('TrustedTypePolicyFactory'), TTP = iface('TrustedTypePolicy');
    method(TTF.prototype, 'createPolicy', (name, rules = {}) => {
      const p = O.create(TTP.prototype);
      for (const m of ['createHTML', 'createScript', 'createScriptURL']) method(p, m, (v, ...a) => (typeof rules[m] === 'function' ? String(rules[m](v, ...a)) : String(v)), 1);
      Object.defineProperty(p, 'name', { value: name, enumerable: true });
      return p;
    }, 1);
    for (const m of ['isHTML', 'isScript', 'isScriptURL']) method(TTF.prototype, m, () => false, 1);
    method(TTF.prototype, 'getAttributeType', () => null, 2);
    method(TTF.prototype, 'getPropertyType', () => null, 2);
    acc(TTF.prototype, 'defaultPolicy', () => null);
    acc(TTF.prototype, 'emptyHTML', () => '');
    acc(TTF.prototype, 'emptyScript', () => '');
    ro('trustedTypes', O.create(TTF.prototype));
    const MQL = iface('MediaQueryList', w.EventTarget);
    const mq = (q) => {
      const t = String(q).toLowerCase();
      if (/prefers-color-scheme:\s*dark|prefers-reduced-motion:\s*reduce|forced-colors:\s*active|inverted-colors:\s*inverted|pointer:\s*(coarse|none)|hover:\s*none/.test(t)) return false;
      const mw = t.match(/(min|max)-width:\s*(\d+)px/); if (mw) return mw[1] === 'min' ? winVals.innerWidth >= +mw[2] : winVals.innerWidth <= +mw[2];
      return true;
    };
    method(w, 'matchMedia', (q) => { const m = O.create(MQL.prototype); Object.defineProperties(m, { media: { value: String(q) }, matches: { value: mq(q) }, onchange: { value: null, writable: true } }); return m; }, 1);
    for (const m of ['addListener', 'removeListener']) method(MQL.prototype, m, () => undefined, 1);
    if (!w.crypto || !w.crypto.subtle) try { acc(O.getPrototypeOf(w.crypto), 'subtle', () => crypto.webcrypto.subtle); } catch (_) {}
    ro('isSecureContext', true);
    ro('crossOriginIsolated', false);
    ro('originAgentCluster', true);   // header Origin-Agent-Cluster: ?1
    def('TextEncoder', TextEncoder); def('TextDecoder', TextDecoder);
    // structuredClone thật của V8 (BigInt, Map, Date, lỗi DataCloneError…) rồi chuyển object sang realm page
    const toRealm = (x, seen = new Map()) => {
      if (x === null || typeof x !== 'object') return x;
      if (seen.has(x)) return seen.get(x);
      const tag = Object.prototype.toString.call(x).slice(8, -1);
      let o;
      if (Array.isArray(x)) { o = new w.Array(); seen.set(x, o); x.forEach((v, i) => { o[i] = toRealm(v, seen); }); return o; }
      if (tag === 'Date') return new w.Date(x.getTime());
      if (tag === 'RegExp') return new w.RegExp(x.source, x.flags);
      if (tag === 'Map') { o = new w.Map(); seen.set(x, o); x.forEach((v, k) => o.set(toRealm(k, seen), toRealm(v, seen))); return o; }
      if (tag === 'Set') { o = new w.Set(); seen.set(x, o); x.forEach((v) => o.add(toRealm(v, seen))); return o; }
      if (tag === 'ArrayBuffer') { o = new w.ArrayBuffer(x.byteLength); new w.Uint8Array(o).set(new Uint8Array(x)); return o; }
      if (ArrayBuffer.isView(x) && w[tag]) return new w[tag](toRealm(x.buffer, seen), x.byteOffset, tag === 'DataView' ? x.byteLength : x.length);
      if (/Error$/.test(tag) && w[x.name]) { o = new w[x.name](x.message); return o; }
      if (tag === 'Object') { o = new w.Object(); seen.set(x, o); for (const k of Object.keys(x)) o[k] = toRealm(x[k], seen); return o; }
      return x;
    };
    def('structuredClone', mark({ structuredClone(v) {
      if (arguments.length === 0) throw new w.TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
      let c; try { c = structuredClone(v); } catch (e) { throw DOMEx(`Failed to execute 'structuredClone' on 'Window': ${String(e.message).replace(/^.*?could not be cloned\.?/, (m) => m)}`, 'DataCloneError'); }
      return toRealm(c);
    } }.structuredClone));
    def('requestIdleCallback', mark({ requestIdleCallback(fn) { return w.setTimeout(() => fn(toPage({ didTimeout: false })), 1); } }.requestIdleCallback));
    def('cancelIdleCallback', mark({ cancelIdleCallback(id) { w.clearTimeout(id); } }.cancelIdleCallback));
    // ---- Performance Timeline: navigation entry của chính document iframe (số đo thật của request) ----
    const nt = navTiming || {};
    const fetchMs = Math.max(120, nt.fetchMs || 560), decoded = nt.htmlLen || 250000, encoded = Math.round(decoded / 2.72);
    const NAV = { name: url, entryType: 'navigation', startTime: 0, initiatorType: 'navigation', deliveryType: '', nextHopProtocol: 'h2',
      renderBlockingStatus: 'non-blocking', workerStart: 0, redirectStart: 0, redirectEnd: 0, fetchStart: 1.2, domainLookupStart: 1.2,
      domainLookupEnd: 1.2, connectStart: 1.2, secureConnectionStart: 1.2, connectEnd: 1.2, requestStart: 4.1,
      responseStart: Math.round(fetchMs * 0.44), firstInterimResponseStart: 0, finalResponseHeadersStart: Math.round(fetchMs * 0.44),
      responseEnd: fetchMs, transferSize: encoded + 300, encodedBodySize: encoded, decodedBodySize: decoded, responseStatus: 200,
      contentType: 'text/html', serverTiming: [], unloadEventStart: 0, unloadEventEnd: 0, type: 'navigate', redirectCount: 0,
      activationStart: 0, criticalCHRestart: 0 };
    const loadT = { domInteractive: 0, domContentLoadedEventStart: 0, domContentLoadedEventEnd: 0, domComplete: 0, loadEventStart: 0, loadEventEnd: 0 };
    w.addEventListener('DOMContentLoaded', () => { const t = w.performance.now(); loadT.domInteractive = t - 2; loadT.domContentLoadedEventStart = t; loadT.domContentLoadedEventEnd = t + 0.3; });
    w.addEventListener('load', () => { const t = w.performance.now(); Object.assign(loadT, { domComplete: t - 0.5, loadEventStart: t, loadEventEnd: t + 0.2 }); });
    const PE = iface('PerformanceEntry'), PRT = iface('PerformanceResourceTiming', PE), PNT = iface('PerformanceNavigationTiming', PRT);
    const navEntry = O.create(PNT.prototype);
    for (const k of Object.keys(NAV)) acc(k in { name: 1, entryType: 1, startTime: 1 } ? PE.prototype : k in { type: 1, redirectCount: 1, unloadEventStart: 1, unloadEventEnd: 1, activationStart: 1, criticalCHRestart: 1 } ? PNT.prototype : PRT.prototype, k, () => (k === 'serverTiming' ? w.Array.of() : NAV[k]));
    for (const k of Object.keys(loadT)) acc(PNT.prototype, k, () => loadT[k]);
    acc(PE.prototype, 'duration', () => loadT.loadEventEnd);
    method(PE.prototype, 'toJSON', function () { const o = new w.Object(); for (const k of [...Object.keys(NAV), ...Object.keys(loadT), 'duration']) o[k] = this[k]; return o; }, 0);
    // Resource timing buffer: XHR calls → PerformanceResourceTiming entries (rPXg2)
    const RTING = [], RT_OBS = [];
    const mkRTE = (name, dur, bodySize, status) => {
      const t = w.performance.now(), st = Math.max(1, t - dur), rs = st + Math.round(dur * 0.35);
      const rv = { name, entryType: 'resource', startTime: st, duration: dur, initiatorType: 'xmlhttprequest',
        nextHopProtocol: 'h2', workerStart: 0, redirectStart: 0, redirectEnd: 0, fetchStart: st,
        domainLookupStart: st, domainLookupEnd: st, connectStart: st, connectEnd: st, secureConnectionStart: st,
        requestStart: st + 1, responseStart: rs, firstInterimResponseStart: 0, finalResponseHeadersStart: rs,
        responseEnd: t, transferSize: bodySize + 300, encodedBodySize: bodySize, decodedBodySize: bodySize,
        responseStatus: status || 200, contentType: '', renderBlockingStatus: 'non-blocking', deliveryType: '', serverTiming: [] };
      const obj = O.create(PRT.prototype);
      for (const [k, v] of Object.entries(rv)) Object.defineProperty(obj, k, { value: v, enumerable: true, configurable: true, writable: true });
      method(obj, 'toJSON', function () { return toPage(rv); }, 0);
      return obj;
    };
    // Instrument XHR → resource timing entries (fo#1 VM download, ci/ init, etc.)
    if (!isFrame) {
      const XM = new WeakMap();
      const _xOpen = w.XMLHttpRequest.prototype.open, _xSend = w.XMLHttpRequest.prototype.send;
      Object.defineProperty(w.XMLHttpRequest.prototype, 'open', { value: mark(function open(m2, u2) {
        XM.set(this, { url: String(u2 || ''), t0: 0 });
        return _xOpen.apply(this, arguments);
      }), writable: true, configurable: true });
      Object.defineProperty(w.XMLHttpRequest.prototype, 'send', { value: mark(function send() {
        const meta = XM.get(this);
        if (meta) {
          meta.t0 = w.performance.now();
          this.addEventListener('loadend', () => {
            const dur = Math.max(1, w.performance.now() - meta.t0);
            let bs = 0;
            try { const b = this.response; if (b != null && typeof b.byteLength === 'number') bs = b.byteLength; } catch (_) {}
            if (!bs) try { const rt = this.responseText; bs = rt ? rt.length : 0; } catch (_) {}
            const e = mkRTE(meta.url, dur, bs, this.status);
            RTING.push(e); RT_OBS.forEach((fn) => fn(e));
          });
        }
        return _xSend.apply(this, arguments);
      }), writable: true, configurable: true });
    }
    // Media: <link rel=preload as=image> + <img src> → fetch via bridge, ONE request per URL (cf_media.js)
    if (!isFrame) { try { const { installMedia } = require('./cf_media'); installMedia(w, { callBridgeAsync: (q) => callBridgeAsync({ ...q, solve_id: solveId }), mkRTE, RTING, RT_OBS, impersonate: process.env.CF_IMP || 'chrome146', proxy: process.env.CF_PROXY || undefined, docOrigin: new URL(url).origin, iframeUrl: url, log, mark, acc, method }); } catch (e) { log('[media] install lỗi:', e.message); } }
    const entries = (type) => {
      const nav = !isFrame && (!type || type === 'navigation') ? [navEntry] : [];
      const res = (!type || type === 'resource') ? RTING : [];
      return w.Array.of(...nav, ...res);
    };
    const perfProto = O.getPrototypeOf(w.performance);
    const pm = (n, fn, len) => { if (typeof perfProto[n] !== 'function') method(perfProto, n, fn, len); };
    // getEntries() trả về resources only (nav đến từ observer callback, tránh duplicate trong rPXg2)
    pm('getEntries', () => entries('resource'), 0);
    pm('getEntriesByType', (t) => entries(String(t)), 1);
    pm('getEntriesByName', (n, t) => {
      const name = String(n), type = t ? String(t) : null;
      if (name === url) return entries(type);
      const filtered = RTING.filter(e => e.name === name && (!type || e.entryType === type));
      return w.Array.of(...filtered);
    }, 1);
    for (const n of ['mark', 'measure', 'clearMarks', 'clearMeasures', 'clearResourceTimings', 'setResourceTimingBufferSize']) pm(n, () => undefined, 0);
    if (!('memory' in w.performance)) acc(perfProto, 'memory', () => toPage({ jsHeapSizeLimit: 4294705152, totalJSHeapSize: 13800000, usedJSHeapSize: 11900000 }));
    // PerformanceObserver: navigation buffered + resource entries (RT_OBS stream)
    const PO = mark(function PerformanceObserver(cb) {
      if (!new.target) throw new w.TypeError("Failed to construct 'PerformanceObserver': Please use the 'new' operator.");
      DATA.set(this, { cb, types: [] });
    }, 'PerformanceObserver');
    Object.setPrototypeOf(PO, WF.prototype); Object.setPrototypeOf(PO.prototype, O.prototype);
    Object.defineProperty(PO, 'supportedEntryTypes', { get: mark(Object.getOwnPropertyDescriptor({ get supportedEntryTypes() { return O.freeze(w.Array.of('element', 'event', 'first-input', 'largest-contentful-paint', 'layout-shift', 'long-animation-frame', 'longtask', 'mark', 'measure', 'navigation', 'paint', 'resource', 'visibility-state')); } }, 'supportedEntryTypes').get), configurable: true, enumerable: true });
    method(PO.prototype, 'observe', function (opt = {}) {
      const d = DATA.get(this), types = opt.entryTypes ? Array.from(opt.entryTypes) : [opt.type];
      d.types.push(...types);
      if ((opt.buffered || opt.entryTypes) && types.includes('navigation')) {
        const fire = () => { const list = O.create(O.prototype); method(list, 'getEntries', () => entries('navigation')); method(list, 'getEntriesByType', (t) => entries(String(t))); method(list, 'getEntriesByName', () => entries('navigation')); d.cb.call(this, list, this); };
        (loadT.loadEventEnd ? w.setTimeout(fire, 0) : w.addEventListener('load', () => w.setTimeout(fire, 0)));
      }
      if (types.includes('resource')) {
        const self2 = this;
        if ((opt.buffered || opt.entryTypes) && RTING.length) {
          // buffered: Chrome giao entry đã có trong callback BẤT ĐỒNG BỘ (task sau)
          const snap = RTING.slice();
          const listBuf = O.create(O.prototype); method(listBuf, 'getEntries', () => w.Array.of(...snap)); method(listBuf, 'getEntriesByType', (t2) => String(t2) === 'resource' ? w.Array.of(...snap) : w.Array.of()); method(listBuf, 'getEntriesByName', () => w.Array.of());
          w.setTimeout(() => { try { d.cb.call(self2, listBuf, self2); } catch (_) {} }, 0);
        }
        RT_OBS.push((e) => { if (!d.types.length) return; const list = O.create(O.prototype); method(list, 'getEntries', () => w.Array.of(e)); method(list, 'getEntriesByType', (t2) => String(t2) === 'resource' ? w.Array.of(e) : w.Array.of()); method(list, 'getEntriesByName', () => w.Array.of()); try { d.cb.call(self2, list, self2); } catch (_) {} });
      }
    }, 0);
    method(PO.prototype, 'disconnect', function () { DATA.get(this).types = []; }, 0);
    method(PO.prototype, 'takeRecords', () => w.Array.of(), 0);
    Object.defineProperty(w, 'PerformanceObserver', { value: PO, writable: true, configurable: true, enumerable: false });
    // observer DOM: constructible, không bao giờ callback (iframe ẩn 0x0)
    const Obs = (n) => {
      const C = mark(function (cb) { if (!new.target) throw new w.TypeError(`Failed to construct '${n}': Please use the 'new' operator.`); }, n);
      Object.setPrototypeOf(C, WF.prototype); Object.setPrototypeOf(C.prototype, O.prototype);
      for (const m of ['observe', 'unobserve', 'disconnect']) method(C.prototype, m, () => undefined, m === 'disconnect' ? 0 : 1);
      method(C.prototype, 'takeRecords', () => w.Array.of(), 0);
      Object.defineProperty(w, n, { value: C, writable: true, configurable: true, enumerable: false });
    };
    for (const n of ['ResizeObserver', 'IntersectionObserver']) if (!(n in w)) Obs(n);

    // ---- blob: URL + Worker thật (chạy script blob trong realm riêng, message 2 chiều) ----
    const origin = new URL(url).origin;   // BLOBS dùng chung mọi realm cùng origin (module-level)
    for (const [n, fn] of [['createObjectURL', (b) => { const id = `blob:${origin}/${crypto.randomUUID()}`; BLOBS.set(id, b); return id; }],
      ['revokeObjectURL', (id) => { BLOBS.delete(String(id)); }]])
      Object.defineProperty(w.URL, n, { value: mark({ [n](x) { return fn(x); } }[n]), writable: true, configurable: true, enumerable: true });
    const impl = (o) => idlUtils.implForWrapper(o);
    const fire = (target, type, init) => fireAnEvent(type, impl(target), MessageEventI, init);
    const blobText = async (b) => (typeof b.text === 'function' ? b.text() : Buffer.from(impl(b)._buffer).toString('utf8'));
    const WK = mark(function Worker(scriptURL) {
      if (!new.target) throw new w.TypeError("Failed to construct 'Worker': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
      const src = String(scriptURL), blob = BLOBS.get(src);
      if (!blob && !src.startsWith(origin)) throw DOMEx(`Failed to construct 'Worker': Script at '${src}' cannot be accessed from origin '${origin}'.`, 'SecurityError');
      const et = new w.EventTarget();
      Object.setPrototypeOf(et, WK.prototype);
      const st = { dead: false, inbox: [], wctx: null, onmessage: null, onerror: null, t0: performance.now() };   // t0: timeOrigin riêng của worker
      DATA.set(et, st);
      WK_STATES.push(st);
      et.addEventListener('message', (e) => st.onmessage && st.onmessage.call(et, e));
      et.addEventListener('error', (e) => st.onerror && st.onerror.call(et, e));
      (async () => {
        const code = blob ? await blobText(blob) : Buffer.from(callBridgeGet(src, solveId), 'base64').toString('utf8');
        log(`[worker] start src=${src.slice(0, 60)} blob=${!!blob} len=${code.length} head=${JSON.stringify(code.slice(0, 2000))}`);
        if (st.dead) return;
        const { buildWorkerGlobal } = require('./cf_worker');
        const { navigator: wkNav, trustedTypes: wkTT } = buildWorkerGlobal({ navVals, langs });
        const g = { console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder,
          atob: w.atob, btoa: w.btoa, crypto: crypto.webcrypto, performance: { now: () => clampMs(performance.now() - st.t0), timeOrigin: Math.round((performance.timeOrigin + st.t0) * 10) / 10 },
          navigator: wkNav, trustedTypes: wkTT,
          location: toPage({ href: src, origin, protocol: 'blob:' }), name: '', onmessage: null, _l: [] };
        const wnet = {}; installNetworking(wnet, { referer: url, origin, impersonate: process.env.CF_IMP || 'chrome146', proxy: process.env.CF_PROXY || undefined, solveId });
        { const _wkF = wnet.fetch; g.fetch = async function fetch(input, opts) {
          const us = typeof input === 'string' ? input : (input && input.href) || String(input);
          const t0 = performance.now(); let r;
          try { r = await _wkF.call(this, input, opts); } catch(ex) {
            if (us.includes('/pat/')) { const e = mkRTE(us, Math.max(1,performance.now()-t0), 0, 0); RTING.push(e); RT_OBS.forEach(fn=>fn(e)); } throw ex;
          }
          if (us.includes('/pat/')) { const e = mkRTE(us, Math.max(1,performance.now()-t0), 0, r.status||200); RTING.push(e); RT_OBS.forEach(fn=>fn(e)); }
          return r;
        }; }
        g.queueMicrotask = queueMicrotask; g.structuredClone = (v) => JSON.parse(JSON.stringify(v));
        g.self = g;
        g.postMessage = (data) => { log(`[worker→page] ${JSON.stringify(data).slice(0, 160)}`); if (!st.dead) setTimeout(() => fire(et, 'message', { data: toPage(data), origin: '', lastEventId: '', ports: w.Array.of() }), 0); };
        g.addEventListener = (t, h) => { if (t === 'message') g._l.push(h); };
        g.close = () => { st.dead = true; };
        st.wctx = require('vm').createContext(g);
        try { require('vm').runInContext(code, st.wctx, { filename: src }); }
        catch (e) { setTimeout(() => fire(et, 'error', { data: undefined }), 0); log('[worker] lỗi', e.message); }
        st.deliver = (data) => { log(`[page→worker] ${JSON.stringify(data).slice(0, process.env.WLOG_FULL ? 1e7 : 3000)}`); const ev = { isTrusted: true, type: 'message', data: JSON.parse(JSON.stringify(data)), origin: '', source: null, lastEventId: '', ports: [], timeStamp: g.performance.now() }; /* MessageEvent trong worker: origin '' source null */ try { if (g.onmessage) g.onmessage(ev); g._l.forEach((h) => h(ev)); } catch (e) { log('[worker] uncaught', e.message); setTimeout(() => fire(et, 'error', { data: undefined }), 0); } };
        st.inbox.splice(0).forEach((d) => st.deliver(d));
      })().catch((e) => log('[worker] start lỗi', e.message));
      return et;
    }, 'Worker');
    Object.setPrototypeOf(WK, w.EventTarget); Object.setPrototypeOf(WK.prototype, w.EventTarget.prototype);
    method(WK.prototype, 'postMessage', function (data) { const st = DATA.get(this); if (st.dead) return; st.deliver ? setTimeout(() => st.deliver(data), 0) : st.inbox.push(data); }, 1);
    method(WK.prototype, 'terminate', function () { DATA.get(this).dead = true; }, 0);
    for (const h of ['onmessage', 'onerror', 'onmessageerror']) Object.defineProperty(WK.prototype, h, { configurable: true, enumerable: true,
      get: mark(Object.getOwnPropertyDescriptor({ get [h]() { return DATA.get(this)[h] || null; } }, h).get),
      set: mark(Object.getOwnPropertyDescriptor({ set [h](v) { DATA.get(this)[h] = typeof v === 'function' ? v : null; } }, h).set) });
    Object.defineProperty(w, 'Worker', { value: WK, writable: true, configurable: true, enumerable: false });
    // Web Streams, MessageChannel, BroadcastChannel, CSS — Chrome có sẵn, jsdom thiếu
    for (const n of ['ReadableStream', 'WritableStream', 'TransformStream', 'CompressionStream', 'DecompressionStream', 'TextEncoderStream', 'TextDecoderStream', 'MessageChannel', 'MessagePort', 'BroadcastChannel'])
      if (!(n in w) && typeof globalThis[n] === 'function') Object.defineProperty(w, n, { value: realmClass(w, n, globalThis[n], mark), writable: true, configurable: true, enumerable: false });
    if (!('CSS' in w)) {
      const css = O.create(O.prototype);
      method(css, 'supports', (a, b) => (b === undefined ? /^\(?\s*[a-z-]+\s*:/.test(String(a)) : true), 1);
      method(css, 'escape', (s) => String(s).replace(/([^\w-])/g, '\\$1'), 1);
      Object.defineProperty(css, w.Symbol.toStringTag, { value: 'CSS', configurable: true });
      Object.defineProperty(w, 'CSS', { value: css, writable: true, configurable: true, enumerable: false });
    }
    // Notification.permission: Chrome profile đã denied (xVwa3)
    const NF = iface('Notification', w.EventTarget); Object.defineProperty(NF, 'permission', { get: mark(Object.getOwnPropertyDescriptor({ get permission() { return 'denied'; } }, 'permission').get), configurable: true, enumerable: true });

    // Visibility/focus: challenge iframe luôn visible+focused trong Chrome (VSuQ0 WeWd3 ngAw1 tooe6 IkNV1→false)
    acc(w.Document.prototype, 'visibilityState', () => 'visible');
    acc(w.Document.prototype, 'hidden', () => false);
    method(w.Document.prototype, 'hasFocus', () => true, 0);

    // ps_profile: localStorage persistent cho challenges.cloudflare.com (dJYZ1 mc_acc_p)
    if (!isFrame) {
      try {
        const _lsProf = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'ps_profile.json'), 'utf8'));
        const _ls = w.localStorage;
        if (_ls && _lsProf.localStorage) for (const [_k, _v] of Object.entries(_lsProf.localStorage)) try { _ls.setItem(_k, _v); } catch(_le) {}
      } catch(_e) {} // chưa có ps_profile.json → bỏ qua
    }

    // ---- phần còn lại của bề mặt Chrome (interface/prop thiếu, xoá global thừa) — cf_surface.js ----
    if (!process.env.NOSURFACE) installSurface(w, { mark, own, method, acc, h53, log, isFrame });


    // ── Block AudioContext: Chrome cross-origin iframe ném NotAllowedError (Permissions-Policy).
    // CF probe CMJGg7 kiểm tra typeof AudioContext → 'unavailable' khi undefined.
    // Đặt về undefined (không delete) để 'n in w' = false hay typeof = 'undefined'.
    for (const n of ['AudioContext', 'OfflineAudioContext', 'webkitAudioContext', 'AudioWorklet']) {
      try { delete w[n]; } catch (_) {}
      try { Object.defineProperty(w, n, { value: undefined, writable: true, configurable: true, enumerable: false }); } catch (_) {}
    }

    // ---- Intl: default locale = navigator.language để khớp Chrome (AAxL9,LxEyU6,...) ----
    if (!isFrame) {
      const _intlLang = () => w.navigator && w.navigator.language || 'vi-VN';
      for (const n of ['DateTimeFormat','NumberFormat','Collator','DisplayNames','ListFormat','PluralRules','RelativeTimeFormat','Segmenter']) {
        if (!w.Intl || !w.Intl[n]) continue;
        const orig = w.Intl[n];
        const wrap = mark(function(locale, opts) {
          if (locale === undefined) locale = _intlLang();
          return new.target ? Reflect.construct(orig, [locale, opts], new.target) : orig(locale, opts);
        }, n);
        Object.defineProperty(wrap, 'length', { value: orig.length, configurable: true });
        try { Object.assign(wrap, orig); } catch (_) {}
        try { wrap.prototype = orig.prototype; } catch (_) {}
        try { Object.defineProperty(w.Intl, n, { value: wrap, writable: true, configurable: true }); } catch (_) {}
      }
    }

    // ---- ẩn thuộc tính nội bộ của jsdom khỏi Object.keys/for-in --------------
    for (const k of Object.getOwnPropertyNames(w)) {
      if (!/^_/.test(k) || k === '_cf_chl_opt') continue;
      try { const d = Object.getOwnPropertyDescriptor(w, k); if (d.configurable && d.enumerable) Object.defineProperty(w, k, { enumerable: false }); } catch (_) {}
    }

    // ---- debug: log setTimeout ---------------------------------------------
    if (traceTimers) {
      const ST = w.setTimeout; let n = 0;
      const seenStacks = new Set();
      Object.defineProperty(w, 'setTimeout', { value: mark({ setTimeout(fn, ms, ...a) {
        const id = ++n; log(`[ST#${id}] ms=${ms} fn=${String(fn).replace(/\s+/g, ' ').slice(0, 70)}`);
        const st = (new Error().stack || '').split('\n').slice(2, 6).map((s) => s.trim().slice(0, 160)).join(' <- ');
        if (!seenStacks.has(st)) { seenStacks.add(st); log(`   [ST#${id} from] ${st}`); }
        return ST.call(w, fn, ms, ...a);
      } }.setTimeout), writable: true, configurable: true, enumerable: true });
    }

    // ---- debug DUMPJSON=1: lưu mọi JSON.stringify lớn (plaintext payload trước khi CF mã hoá) ----
    if (process.env.DUMPJSON) {
      const JS = w.JSON.stringify; let nd = 0;
      method(w.JSON, 'stringify', function (...a) {
        const out = JS.apply(this, a);
        if (typeof out === 'string' && out.length > 1500) { const f = require('path').join(__dirname, `dumpjson_${isFrame ? 'f' : 'm'}_${++nd}.json`); require('fs').writeFileSync(f, out); log(`[dumpjson] ${out.length}B → ${f}`); }
        return out;
      }, 3);
    }

    // ---- debug APITRACE=1: log lần đầu mỗi API host được chạm (getter/method) kèm thời điểm ----
    if (process.env.APITRACE && !isFrame) {
      const T0 = Date.now(), seenApi = new Set();
      const note = (n) => { if (!seenApi.has(n)) { seenApi.add(n); log(`[api +${((Date.now() - T0) / 1000).toFixed(1)}s] ${n}`); } };
      const wrapObj = (obj, label) => {
        if (!obj) return;
        for (const k of Object.getOwnPropertyNames(obj)) {
          if (k === 'constructor' || k === 'toString') continue;
          let d; try { d = Object.getOwnPropertyDescriptor(obj, k); } catch (_) { continue; }
          if (!d || !d.configurable) continue;
          const nm = `${label}.${k}`;
          if (typeof d.value === 'function' && !/^[A-Z]/.test(k)) {
            const f = d.value;
            const wf = mark({ [k](...a) { note(nm + '()'); return new.target ? Reflect.construct(f, a, new.target) : f.apply(this, a); } }[k]);
            Object.defineProperty(wf, 'length', { value: f.length, configurable: true });
            Object.defineProperty(obj, k, { ...d, value: wf });
          } else if (d.get) {
            const g = d.get;
            const wg = mark(Object.getOwnPropertyDescriptor({ get [k]() { note(nm); return g.call(this); } }, k).get);
            Object.defineProperty(obj, k, { ...d, get: wg });
          }
        }
      };
      for (const C of ['Navigator', 'NavigatorUAData', 'Document', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement', 'HTMLIFrameElement', 'EventTarget',
        'Screen', 'Performance', 'Crypto', 'SubtleCrypto', 'CanvasRenderingContext2D', 'WebGLRenderingContext', 'WebGL2RenderingContext', 'Location', 'History',
        'Storage', 'ShadowRoot', 'CSSStyleDeclaration', 'PluginArray', 'MimeTypeArray', 'Permissions', 'MediaQueryList', 'XMLHttpRequest', 'Worker', 'DOMRect', 'Range', 'Selection'])
        if (w[C] && w[C].prototype) wrapObj(w[C].prototype, C);
      wrapObj(w, 'window');
    }

    // ---- class jsdom sống ở realm Node → nối prototype gốc về realm page (navigator instanceof Object) ----
    for (const k of Object.getOwnPropertyNames(w)) {
      let v; try { const d = Object.getOwnPropertyDescriptor(w, k); v = d && d.value; } catch (_) { continue; }
      if (typeof v !== 'function' || v === WF || v === O) continue;
      if (Object.getPrototypeOf(v) === Function.prototype) reparent(v, Function.prototype, WF.prototype);
      const p = v.prototype;
      if (p && typeof p === 'object' && Object.getPrototypeOf(p) === Object.prototype) try { reparent(p, Object.prototype, O.prototype); } catch (_) {}
    }

    // ---- rAF: timestamp theo đồng hồ realm (jsdom dùng mốc lúc tạo window), mọi callback cùng frame cùng giá trị ----
    if (typeof w.requestAnimationFrame === 'function') {
      const raf = w.requestAnimationFrame; let fts = null;
      method(w, 'requestAnimationFrame', function (cb) {
        if (typeof cb !== 'function') return raf.call(this, cb);
        return raf.call(this, () => { if (fts === null) { fts = w.performance.now(); setImmediate(() => { fts = null; }); } return cb(fts); });
      }, 1);
    }

    // ---- hình dạng window như Chrome + ẩn nội bộ jsdom khỏi reflection ----
    try { installTemporal(w, { mark }); fixDocMisc(w, mark); } catch (e) { log('[docmisc] lỗi', e.stack); }
    if (!process.env.NOSHAPE) { try { fixHTMLDocument(w, mark); syncProtoShapes(w); syncWindowShape(w); installReflectFilter(w, mark); } catch (e) { log('[shape] lỗi', e.message); } }

    // ---- đánh dấu native mọi hàm env hiện có (trước khi page script chạy) ----
    // ponytail: WALKED dùng chung giữa các realm → frame sau bỏ qua prototype jsdom đã đi
    const seen = new Set();
    // BFS (không phải DFS): object luôn được thăm ở độ sâu nhỏ nhất — DFS có giới hạn độ sâu sẽ bỏ sót method nếu
    // gặp prototype lần đầu qua đường dài (vd AudioContext→BaseAudioContext→EventTarget.prototype ở depth 4)
    const fixFn = (o) => { NATIVE.add(o); if (Object.getPrototypeOf(o) === Function.prototype && WF.prototype !== Function.prototype) try { reparent(o, Function.prototype, WF.prototype); } catch (_) {} };
    // 2 mảng song song thay vì [o, depth] mỗi phần tử + lọc/đánh dấu seen lúc đưa vào hàng (bớt ~hàng trăm nghìn mảng
    // rác mỗi realm). BFS → lần đầu gặp một object luôn ở độ sâu nhỏ nhất → cùng tập object/độ sâu như lọc lúc lấy ra.
    const walk = (root) => {
      const qo = [], qd = [];
      const push = (v, d) => { if (v !== null && (typeof v === 'object' || typeof v === 'function') && d <= 4 && !seen.has(v)) { seen.add(v); qo.push(v); qd.push(d); } };
      push(root, 0);
      for (let qi = 0; qi < qo.length; qi++) {
        const o = qo[qi], depth = qd[qi];
        if (WALKED.has(o)) { if (typeof o === 'function') fixFn(o); continue; }   // đã đi ở realm trước → skip subtree nhưng vẫn fix __proto__ realm
        WALKED.add(o);
        if (typeof o === 'function') { fixFn(o); push(o.prototype, depth + 1); }
        let names; try { names = Reflect.ownKeys(o); } catch (_) { continue; }
        for (let i = 0; i < names.length; i++) {
          let d; try { d = Object.getOwnPropertyDescriptor(o, names[i]); } catch (_) { continue; }
          if (!d) continue;
          const v = d.value;
          if (v && (typeof v === 'function' || (typeof v === 'object' && depth < 3))) push(v, depth + 1);
          if (d.get) push(d.get, depth + 1);
          if (d.set) push(d.set, depth + 1);
        }
        try { push(Object.getPrototypeOf(o), depth + 1); } catch (_) {}
      }
    };
    walk(w);
    // Fix bổ sung: walk bỏ qua own-props của Function.prototype (depth = 5 > limit 4)
    // Lý do: Function.prototype được duyệt lần đầu ở depth 4 (qua __proto__ chain của method)
    // → own-props của nó sẽ ở depth 5 → bị bỏ qua. Cần fix trực tiếp.
    {
      const nodeFP = Function.prototype;
      const pageProto = WF.prototype;
      if (nodeFP !== pageProto) {
        for (const proto of [WF.prototype, O.prototype]) {
          for (const k of Reflect.ownKeys(proto)) {
            try {
              const d = Object.getOwnPropertyDescriptor(proto, k);
              if (!d) continue;
              for (const v of [d.value, d.get, d.set]) {
                if (typeof v === 'function' && Object.getPrototypeOf(v) === nodeFP) {
                  reparent(v, nodeFP, pageProto);
                  NATIVE.add(v); WALKED.add(v);
                }
              }
            } catch(_) {}
          }
        }
      }
    }
    // chẩn đoán sau walk (chỉ khi ENGINE_SPY > 0)
    if (process.env.ENGINE_SPY > '0') try {
      const d1 = w.eval('Object.getPrototypeOf(Function.prototype.toString) === Function.prototype');
      const d2 = w.eval('(function f(){}) instanceof Function');
      log(`[setup#${_n}] diag: fp.toString proto=${d1} instanceof=${d2}`);
    } catch(de) { log('[setup diag]', de.message); }

    log(`[setup#${_n}] ${isFrame?'frame':'main'} ${Date.now()-_t0}ms seen=${seen.size}`);
  }

  // mainW chưa có = đang tạo window chính (beforeParse lo) → bỏ qua
  frameSetup = (fw) => { if (!mainW || fw === mainW) return; try { setup(fw, true); } catch (e) { log('[frame setup] lỗi', e.stack); } };
  const dom = new JSDOM(html, { url, referrer, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, beforeParse: (win) => {
    setup(win);
    LAST_MAIN = win;
    // pool iframe dựng trong lúc "đang tải" trang, rồi đặt timeOrigin = đầu navigation (script chạy sau responseEnd như Chrome)
    const pd = idlUtils.implForWrapper(win.document), dv = pd._defaultView;
    FRAME_POOL.list = []; FRAME_POOL.used = 0;
    FRAME_POOL.opts = process.env.NOPOOL ? null : { parsingMode: 'html', url: 'about:blank', parentOrigin: pd._origin, dispatcher: dv._dispatcher, loadSubresources: dv._loadSubresources,
      userAgent: dv._userAgent, referrer: pd.URL, cookieJar: pd._cookieJar, pool: pd._pool, encoding: pd._encoding, runScripts: dv._runScripts,
      commonForOrigin: dv._commonForOrigin, pretendToBeVisual: dv._pretendToBeVisual };
    FRAME_POOL.fill(+(process.env.FRAME_POOL || 3));  // 3 đủ cho CF; 10 = 400ms block thừa
    rebaseClock(win, Math.max(120, (navTiming && navTiming.fetchMs) || 560) + 6 + Math.random() * 6);
  },
    resources: { userAgent: env.userAgent, interceptors: [bridgeInterceptor(new URL(url).origin, log, solveId)] } });

  // parent → iframe: MessageEvent trusted, origin/source đúng, data clone vào realm page
  function deliverToChild(data) {
    const w = mainW;
    fireAnEvent('message', w, MessageEventI, { data: data === undefined ? undefined : w.JSON.parse(JSON.stringify(data)), origin: parentOrigin, source: parentWin, lastEventId: '', ports: w.Object.freeze(w.Array.of()) });
  }
  // debug/interactive: HTML của mọi shadow root (closed cũng thấy qua impl)
  const shadowHTML = () => SHADOWS.map((sr) => idlUtils.wrapperForImpl(sr).innerHTML);
  const findInShadows = (sel) => { for (const sr of SHADOWS) { const el = idlUtils.wrapperForImpl(sr).querySelector(sel); if (el) return el; } return null; };

  // ---- interactive: widget hiện ra + click như người (event trusted, quỹ đạo chuột tự nhiên) ----
  const MouseEventI = require(path.join(JD, 'lib/generated/idl/MouseEvent.js'));
  const PointerEventI = require(path.join(JD, 'lib/generated/idl/PointerEvent.js'));
  const EventI = require(path.join(JD, 'lib/generated/idl/Event.js'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => a + Math.random() * (b - a);
  // layout widget Turnstile 300x65: checkbox 24x24 tại (16,20), label + text bên phải (xấp xỉ layout thật)
  function showWidget(width = 300, height = 65) {
    RESIZE.get(mainW)(width, height);
    VISIBLE.set(mainW, true);
    // iframe nhận focus khi widget hiện (cross-origin click): document visible + focused
    try {
      Object.defineProperty(mainW.document, 'visibilityState', { get: () => 'visible', configurable: true });
      Object.defineProperty(mainW.document, 'hidden', { get: () => false, configurable: true });
      Object.defineProperty(mainW.document, 'hasFocus', { value: mark({ hasFocus() { return true; } }.hasFocus), configurable: true, writable: true });
    } catch (_) {}
    const cb = findInShadows('input[type=checkbox]');
    if (cb) {
      const put = (el, r) => { if (el) { LAYOUT.set(el, r); LAYOUT_LIST.push([el, r]); } };
      const label = cb.closest('label');
      put(label, [16, 20, 190, 24]);
      put(cb, [16, 20, 24, 24]);
      if (label) { const sp = label.querySelectorAll('span'); put(sp[0], [16, 20, 24, 24]); put(sp[1], [52, 23, 150, 18]); }
      let n = label && label.parentElement; for (; n; n = n.parentElement) put(n, [0, 0, width, height]);
    }
    fireAnEvent('resize', mainW, EventI, {});
  }
  async function humanClick(el, { x = rnd(22, 34), y = rnd(26, 38) } = {}) {
    const w = mainW, S = { x: w.screenX + rnd(620, 760), y: w.screenY + rnd(290, 420) };   // vị trí iframe trên màn hình
    let prevCx = null, prevCy = null;
    const base = (cx, cy, extra = {}) => ({ bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy,
      screenX: Math.round(S.x + cx), screenY: Math.round(S.y + cy),
      movementX: prevCx !== null ? cx - prevCx : 0, movementY: prevCy !== null ? cy - prevCy : 0, ...extra });
    // pointer: tất cả field Chrome gửi cho mouse pointer (tiltX/Y/twist/altitude/azimuth Chrome 153)
    const ptr = (cx, cy, extra = {}) => base(cx, cy, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: 0,
      tiltX: 0, tiltY: 0, twist: 0, altitudeAngle: Math.PI / 2, azimuthAngle: 0, ...extra });
    const fire = (type, I, init, target = el) => fireAnEvent(type, idlUtils.implForWrapper(target), I, init);
    // quỹ đạo Bezier bậc 2 từ mép trái/dưới vào checkbox, có jitter + tốc độ không đều
    const p0 = { x: rnd(-40, 5), y: rnd(55, 90) }, p1 = { x: rnd(40, 140), y: rnd(0, 60) }, n = Math.round(rnd(22, 38));
    let entered = false;
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const cx = Math.round((1 - e) ** 2 * p0.x + 2 * (1 - e) * e * p1.x + e * e * x + rnd(-1.2, 1.2));
      const cy = Math.round((1 - e) ** 2 * p0.y + 2 * (1 - e) * e * p1.y + e * e * y + rnd(-1.2, 1.2));
      if (cx < 0 || cy < 0 || cy > 65) { prevCx = cx; prevCy = cy; await sleep(rnd(8, 20)); continue; }   // chưa vào iframe
      const tgt = w.document.body || w.document.documentElement;
      if (!entered && Math.hypot(cx - x, cy - y) < 14) {
        entered = true;
        fire('pointerover', PointerEventI, ptr(cx, cy)); fire('pointerenter', PointerEventI, { ...ptr(cx, cy), bubbles: false });
        fire('mouseover', MouseEventI, base(cx, cy)); fire('mouseenter', MouseEventI, { ...base(cx, cy), bubbles: false });
      }
      fire('pointermove', PointerEventI, ptr(cx, cy), entered ? el : tgt);
      fire('mousemove', MouseEventI, base(cx, cy), entered ? el : tgt);
      prevCx = cx; prevCy = cy;
      await sleep(rnd(9, 26));
    }
    await sleep(rnd(90, 220));
    const cx = Math.round(x), cy = Math.round(y);
    // window focus trước mousedown: Chrome fires focus trên iframe window khi user click vào
    try { fireAnEvent('focus', w, EventI, { bubbles: false, cancelable: false }); } catch (_) {}
    prevCx = cx; prevCy = cy;
    fire('pointerdown', PointerEventI, ptr(cx, cy, { button: 0, buttons: 1, pressure: 0.5 }));
    fire('mousedown', MouseEventI, base(cx, cy, { button: 0, buttons: 1, detail: 1 }));
    try { el.focus(); } catch (_) {}
    await sleep(rnd(78, 108));   // ~88ms như Chrome real click
    fire('pointerup', PointerEventI, ptr(cx, cy, { button: 0, buttons: 0 }));
    fire('mouseup', MouseEventI, base(cx, cy, { button: 0, buttons: 0, detail: 1 }));
    fire('click', MouseEventI, base(cx, cy, { button: 0, buttons: 0, detail: 1 }));   // checkbox tự toggle + input/change trusted
  }
  // dọn sau solve (worker tái sử dụng): jsdom close() dừng timer/rAF (pretendToBeVisual) + huỷ request đang bay của
  // window chính và mọi frame (kể cả frame trong pool chưa dùng); Worker giả chạy timer Node → chỉ đánh dead.
  function close(ok) {
    // chỉ học từ solve thành công (solve lỗi sớm dùng ít frame → học sai sẽ làm solve sau thiếu frame)
    if (ok) FRAME_POOL.expect = FRAME_POOL.expect === Infinity ? FRAME_POOL.used : Math.max(FRAME_POOL.expect, FRAME_POOL.used);
    // Worker giả chạy timer Node (window.close không dừng): timer 5s/10s còn treo giữ global g → g.atob/fetch… → window
    // → đánh dead + xoá hết thuộc tính của g để cắt đường tới window (callback muộn chỉ ném lỗi, bị nuốt).
    for (const st of WK_STATES) {
      st.dead = true;
      if (st.wctx) for (const k of Object.keys(st.wctx)) try { delete st.wctx[k]; } catch (_) {}
    }
    frameSetup = null; FRAME_POOL.opts = null; FRAME_POOL.list = [];
    for (const win of [...CREATED, mainW]) { try { win.close(); } catch (_) {} }
    CREATED.length = 0; SHADOWS.length = 0; LAYOUT_LIST.length = 0; BLOBS.clear(); LAST_MAIN = null;
    restoreProtos();   // nhả realm Node khỏi window này → window được GC
    closePorts();      // BroadcastChannel/MessageChannel page mở → global handle ghim window
  }
  return { dom, window: mainW, deliverToChild, NATIVE, mark, shadowHTML, findInShadows, showWidget, humanClick, close };
}

module.exports = { makeDom, NATIVE, mark };
