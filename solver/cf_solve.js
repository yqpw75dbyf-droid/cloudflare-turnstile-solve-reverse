'use strict';
// cf_solve.js — browserless Turnstile: GET HTML challenge → jsdom (cf_dom) chạy inline orchestrate
// → parent-ghost nói đúng protocol api.js (init echo → extraParams → execute) → token.
// Cần net_bridge_server.py (:5091).  ENV: CF_PROXY, CF_SITEKEY, CF_IMP, CF_TIMEOUT, TRACE=1, NETLOG=1
const fs = require('fs');
const path = require('path');
const http = require('http');
// BRIDGE_PORT: mỗi phiên song song dùng bridge riêng (session curl_cffi là global trong bridge)
const BRIDGE_PORT = +(process.env.BRIDGE_PORT || 5091);
process.env.NET_BRIDGE_URL = process.env.NET_BRIDGE_URL || `http://127.0.0.1:${BRIDGE_PORT}/req`;
const { callBridgeAsync, bridgeOp } = require('./net_bridge');
const { makeDom } = require('./cf_dom');
const { startFoHook, loadProfile } = require('./cf_fohook');

const SITEKEY = process.env.CF_SITEKEY || '0x4AAAAAADhe4dnArEQXuOfl';
const PROXY = process.env.CF_PROXY || '';
const IMP = process.env.CF_IMP || 'chrome146';
const TIMEOUT = +(process.env.CF_TIMEOUT || 90000);
const DIR = __dirname;
// mặc định im lặng — chỉ in token/fail; CF_DEBUG=1 để bật lại toàn bộ log chẩn đoán
const log = process.env.CF_DEBUG ? (...a) => console.log(...a) : () => {};

const fp = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'captured_env.json'), 'utf8'));
const env = fp.env || fp, uach = fp.uach || {};
const pctx = JSON.parse(fs.readFileSync(path.join(DIR, 'parent_ctx.json'), 'utf8'));
const SRC = 'cloudflare-challenge';

// header HTTP phiên (curl_cffi) khớp fingerprint JS: UA, UA-CH low-entropy, Accept-Language
function sessionHeaders() {
  const langs = env.languages || ['en-US'];
  return {
    'User-Agent': env.userAgent,
    'sec-ch-ua': (uach.brands || []).map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
    'sec-ch-ua-mobile': uach.mobile ? '?1' : '?0',
    'sec-ch-ua-platform': `"${uach.platform || 'Windows'}"`,
    'Accept-Language': langs.map((l, i) => (i ? `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}` : l)).join(','),
  };
}

function bridgeReset(solveId) {
  const payload = { proxy: PROXY || null, impersonate: IMP, headers: sessionHeaders(), solve_id: solveId };
  if (bridgeOp) return bridgeOp('reset', payload).then((r) => { if (r.error) throw new Error('bridge reset: ' + r.error); });
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: BRIDGE_PORT, path: '/reset', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
    (res) => { res.resume(); res.statusCode === 200 ? resolve() : reject(new Error('bridge /reset ' + res.statusCode)); });
    req.on('error', () => reject(new Error('net_bridge_server.py chưa chạy (:' + BRIDGE_PORT + ')')));
    req.end(body);
  });
}

// build hiện hành: api.js 302 → /turnstile/v0/<build>/<hash>/api.js; api.js dựng iframe /h/<build>/ từ chính URL đó.
// Ít khi đổi → cache CF_APIJS_TTL (mặc định 5 phút) thay vì tải lại mỗi solve (~150-250ms). Chrome thật cũng lấy api.js
// từ cache (extraParams khai deliveryType 'cache'); response api.js không set cookie (HAR) → bỏ qua không đổi gì phía CF.
const APIJS_TTL = +(process.env.CF_APIJS_TTL || 300000);
let APIJS = null;   // { bm, at } — theo worker
async function apiBuild(solveId) {
  if (APIJS && Date.now() - APIJS.at < APIJS_TTL) return APIJS.bm;
  const aj = await callBridgeAsync({ method: 'GET', url: pctx.au, impersonate: IMP, proxy: PROXY || null, solve_id: solveId, headers: {
    'Accept': '*/*', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script', 'Sec-Fetch-Storage-Access': 'active',
    'Referer': pctx.parentOrigin + '/', 'Priority': 'u=1' } });
  const bm = String(aj.url || '').match(/\/turnstile\/v0\/([a-z])\/([0-9a-f]+)\/api\.js/);
  if (aj.status !== 200 || !bm) throw new Error(`api.js ${aj.status} ${aj.url} — không lấy được build`);
  APIJS = { bm, at: Date.now() };
  return bm;
}

// sitekey/solveId theo tham số: cf_host.js chạy nhiều solve nối tiếp trong 1 worker (env chỉ là mặc định khi chạy lẻ)
async function solve({ sitekey = SITEKEY, solveId = process.env.SOLVE_ID || '' } = {}) {
  await bridgeReset(solveId);
  const renderStart = Date.now();
  const loadInit = renderStart - 180;           // api.js "đã load" ~180ms trước render (timeLoadInitMs thật)
  const wid = Math.random().toString(36).slice(2, 7);
  const bm = await apiBuild(solveId);
  log(`[api.js] build=${bm[1]} hash=${bm[2]}`);
  // hybrid: field fingerprint tĩnh lấy từ profile Chrome thật (capture offline), field gắn phiên env tự tính
  if (process.env.CF_HYBRID !== '0') {
    const prof = loadProfile(bm[1]);
    if (prof) { startFoHook(prof, log); log(`[fohook] profile build=${bm[1]} (${prof.n} run Chrome)`); }
    else log(`[fohook] CHƯA có chrome_profile_${bm[1]}.json — chạy offline: UNITS=none node tp_chrome.js (vài lần) rồi node _mk_profile.js ${bm[1]}`);
  }
  const url = `https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/${bm[1]}/turnstile/f/av0/rch/${wid}/${sitekey}/auto/fbE/new/normal?lang=auto`;
  const tFetch = Date.now();
  const r = await callBridgeAsync({ method: 'GET', url, impersonate: IMP, proxy: PROXY || null, solve_id: solveId, headers: {
    'Upgrade-Insecure-Requests': '1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Storage-Access': 'active',
    'Referer': pctx.parentOrigin + '/', 'Priority': 'u=0, i' } });
  const fetchMs = Date.now() - tFetch;
  let html = Buffer.from(r.body || '', 'base64').toString('utf8');
  // Blank nonce attrs → Chrome ẩn nonce (getAttribute='' thay vì giá trị thật) → script[nonce] collector chạy
  html = html.replace(/(<script\b[^>]*?\s)nonce="[^"]*"/g, '$1nonce=""');
  const htmlLen = Buffer.byteLength(html);
  log(`[html] ${r.status} len=${html.length} wid=${wid}`);
  if (r.status !== 200) { APIJS = null; throw new Error('challenge HTML ' + r.status + ': ' + html.slice(0, 200)); }   // có thể build đổi → lấy lại api.js
  if (process.env.CF_DEBUG) fs.writeFileSync(path.join(DIR, 'challenge_latest.html'), html);   // chẩn đoán; bỏ ghi đĩa ~250KB mỗi solve
  // VMOPTRACE=<file> (chẩn đoán, ground truth cho disassembler Rust): bọc mọi `case N: H.call(this)` của dispatcher VM →
  // ghi opcode, pc trước/sau handler (= số byte toán hạng), khoá, byte thô; tổng hợp theo opcode + chuỗi lệnh của từng bytecode.
  if (process.env.VMOPTRACE) {
    // VM đa hình theo phiên (số opcode, hằng trừ, công thức khoá đổi) → chỉ bám cấu trúc: switch(H[PC]=op+1, op=H[KEY]^...(CODE[op],SUB)..., ...){case
    const c0 = html.search(/case\s*\d+\s*:\s*\w+\s*\[\s*\w+\([\w.]+\)\s*\]\s*\(this\)/);
    const s0 = html.lastIndexOf('switch(', c0);
    if (c0 < 0 || s0 < 0) throw new Error('VMOPTRACE: không nhận ra dispatcher');
    const hdr = html.slice(s0 + 7, html.indexOf('){case', s0));      // H[PC]=op+1, op=H[KEY]^..CODE[op]..SUB.., H[KEY]=..., op
    const [, H, PC] = hdr.match(/^(\w+)\[(\w+)\]=/) || [];
    const OPV = (hdr.match(/,(\w+)$/) || [])[1];
    const KEY = [...hdr.matchAll(new RegExp(`${H}\\[(\\w+)\\]=`, 'g'))].map((m) => m[1]).find((k) => k !== PC);
    const cm = [...hdr.matchAll(new RegExp(`(\\w+)\\[${OPV}\\]\\s*(?:,|-)\\s*(\\d+)`, 'g'))].find((m) => m[1] !== H);
    if (!H || !OPV || !KEY || !cm) throw new Error('VMOPTRACE: header lạ: ' + hdr.slice(0, 240));
    const [, CODE, SUB] = cm;
    log(`[vmoptrace] header: ${hdr.slice(0, 240)}`);
    let nc = 0;
    html = html.replace(/case\s*(\d+)\s*:\s*(\w+)\s*\[\s*\w+\([\w.]+\)\s*\]\s*\(this\)\s*;/g, (m, op, fn) => (nc++, `case ${op}:__vmT(this,${op},${fn},${H},${PC},${KEY},${CODE});`));
    html = html.replace(/<head>/i, `<head><script>(function(){var S={},Q=[],seen=new Map(),nid=0,MAX=400000;
      Object.defineProperty(window,'__VMOPS',{value:{S:S,Q:Q,sub:${SUB},codes:seen}});
      Object.defineProperty(window,'__vmT',{value:function(self,op,fn,H,pc,ki,code){var b=H[pc],k=H[ki],id=seen.get(code);if(id===undefined){id=nid++;seen.set(code,id);}
        var r;try{r=fn.call(self)}finally{var a=H[pc],s=S[op]||(S[op]={n:0,lens:{},fn:fn.name,samples:[]});s.n++;var d=(typeof a==='number'&&a===a)?a-b:'x';s.lens[d]=(s.lens[d]||0)+1;
        if(s.samples.length<4&&typeof d==='number'&&d>=0&&d<64){var raw=[];for(var i=b;i<a;i++)raw.push(code[i]);s.samples.push({vm:id,pc:b,key:k,raw:raw});}
        if(Q.length<MAX)Q.push([id,op,b,a,k]);}return r}});})()</script>`);
    log(`[vmoptrace] dispatcher H=${H} pc=${PC} key=${KEY} code=${CODE} sub=${SUB}; bọc ${nc} case`);
    process.on('exit', () => { try { const V = dom && dom.window.__VMOPS; if (V) { const codes = []; for (const [c, id] of V.codes) codes[id] = { len: c.length, b64: Buffer.from(Array.from(c)).toString('base64') }; fs.writeFileSync(process.env.VMOPTRACE, JSON.stringify({ sub: V.sub, header: hdr, H, PC, KEY, CODE, codes, stats: V.S, seq: V.Q })); } } catch (e) { console.error('vmoptrace lỗi', e.message); } });
  }
  // ELK_TRAP=log|force (chỉ chẩn đoán field eLkTe8 = object có toJSON; Chrome gửi "dhDQs5", env gửi object):
  // bẫy setter trên Object.prototype → accessor riêng; log mỗi lần bị đọc (kết quả toJSON + stack); force: trả toJSON() khi đọc
  if (process.env.ELK_TRAP) {
    const force = process.env.ELK_TRAP === 'force';
    html = html.replace(/<head>/i, `<head><script>(function(){var n=0;Object.defineProperty(Object.prototype,'eLkTe8',{configurable:true,set:function(v){var o=this;
      Object.defineProperty(o,'eLkTe8',{configurable:true,enumerable:true,get:function(){var r;try{r=v&&typeof v.toJSON==='function'?v.toJSON('eLkTe8'):'(no toJSON)'}catch(e){r='ERR '+e}
        if(n++<6)console.log('[elk-get] typeof='+typeof v+' toJSON()='+JSON.stringify(r)+' keys='+JSON.stringify(v&&Object.keys(v))+' stack='+String(new Error().stack).split(String.fromCharCode(10)).slice(1,6).join(' <- ').replace(/https:[^)]*lang=auto/g,'').slice(0,700));
        return ${force ? 'r' : 'v'}},set:function(x){v=x}})}});})()</script>`);
  }
  // VMTRACE=1 (chỉ chẩn đoán): ring-buffer các lệnh GET/SET thuộc tính của VM → window.__VT
  if (process.env.VMTRACE) {
    let ng = 0, ns = 0;
    html = html.replace(/(\w+)\[(\w+)\]=\1\[(\w+)\]\[\1\[(\w+)\]\]/g, (m, R, a, b, c) => (ng++, `${R}[${a}]=__vt(${R}[${b}],${R}[${c}])`));
    html = html.replace(/(\w+)\[(\w+)\]\[\1\[(\w+)\]\]=\1\[(\w+)\]/g, (m, R, a, b, c) => (ns++, `__vs(${R}[${a}],${R}[${b}],${R}[${c}])`));
    html = html.replace(/<head>/i, `<head><script>(function(){var B=[],d=function(v){try{if(v===null)return 'null';var t=typeof v;if(t==='string')return JSON.stringify(v.slice(0,40));if(t!=='object'&&t!=='function')return t+':'+String(v).slice(0,20);if(t==='function')return 'fn:'+v.name;if(Array.isArray(v)&&v.length<=4&&v.every(function(x){return typeof x==='number'}))return 'Nums['+v.map(function(x){return Object.is(x,-0)?'-0':String(x)}).join(',')+']';return Object.prototype.toString.call(v).slice(8,-1)+(v.nodeName?':'+v.nodeName:'')}catch(e){return '?'}};
      Object.defineProperty(window,'__VT',{value:B});
      Object.defineProperty(window,'__vt',{value:function(o,k){B.push('G '+d(o)+' .'+d(k));if(B.length>400000)B.shift();var r=o[k];B[B.length-1]+=' -> '+d(r);return r}});
      Object.defineProperty(window,'__vs',{value:function(o,k,v){B.push('S '+d(o)+' .'+d(k)+' = '+d(v));if(B.length>400000)B.shift();
        if(k==='title'&&(o===undefined||o===null||!o.nodeName)){var NL=String.fromCharCode(10);(window.__VTTS=window.__VTTS||[]).push((o==null?'FAIL':'ok')+NL+B.slice(-400).join(NL));}o[k]=v}});
      [[Document.prototype,['createElement','createElementNS','createTextNode','createDocumentFragment','querySelectorAll','querySelector','getElementById']],[Element.prototype,['setAttribute','setAttributeNS','attachShadow','append','prepend','after','before','replaceWith','insertAdjacentHTML','insertAdjacentElement','querySelectorAll','querySelector']],
       [Node.prototype,['appendChild','insertBefore','removeChild','replaceChild','cloneNode']],[DocumentFragment.prototype,['querySelectorAll','querySelector','append','getElementById']],[typeof ShadowRoot!=='undefined'?ShadowRoot.prototype:{},['querySelectorAll','append']]].forEach(function(p){p[1].forEach(function(m){var f=p[0][m];if(typeof f!=='function')return;
        p[0][m]=function(){var a=[].slice.call(arguments).map(d).join(',');B.push('C '+d(this)+' .'+m+'('+a+')');if(B.length>400000)B.shift();var r=f.apply(this,arguments);B[B.length-1]+=' -> '+d(r)+(r&&r.length!==undefined&&typeof r!=='string'?'#'+r.length:'');return r}})});})()</script>`);
    log(`[vmtrace] GET=${ng} SET=${ns}`);
    process.on('exit', () => { try { fs.writeFileSync(path.join(DIR, (process.env.VT_PREFIX || 'vt') + '_title.txt'), ((dom && dom.window.__VTTS) || []).join('\n==========\n')); } catch (_) {} });
    process.on('exit', () => { try { fs.writeFileSync(path.join(DIR, (process.env.VT_PREFIX || 'vt') + '_all.txt'), ((dom && dom.window.__VT) || []).join('\n')); } catch (_) {} });
  }

  // ch trong extraParams = hash build của api.js (api.js hardcode đúng giá trị trong URL của nó)
  const CH = bm[2];

  let resolveTok; const tokenP = new Promise((res) => { resolveTok = res; });
  const st = { renderEnd: renderStart + 4 };
  // PWGF4: cs timing phải nhỏ (~3ms) như Chrome thật (api.js load → render gần như ngay lập tức)
  const CS_T = 3 + Math.floor(Math.random() * 3);
  // cs format: object (CF map {m,t,s,c} từ object, không phải array index)
  const cs = () => [{ m: 'a', t: CS_T, s: pctx.csStack, c: 1 }];
  let dom;
  const send = (m) => setTimeout(() => dom.deliverToChild(m), 0);

  function onParentMessage(m) {
    if (!m || m.source !== SRC) return;
    log(`[iframe→parent] ${m.event} ${JSON.stringify(m).slice(0, 150)}`);
    switch (m.event) {
      case 'init':
        st.initStart = Date.now();
        send({ event: 'init', source: SRC, widgetId: m.widgetId });
        break;
      case 'requestExtraParams': {
        st.paramsStart = Date.now();
        const Xt = Date.now();
        const ch = CH;
        const now = Date.now();
        send({
          action: undefined, apiJsMismatchReloadAttempts: 0, apiJsMismatchReloadCompletedCount: 0,
          // rPXg2: api.js từ cache (transferSize=0) — CF iframe merge vào resource list
          apiJsResourceTiming: { name: pctx.au, entryType: 'resource', startTime: 25, duration: 17 + Math.floor(Math.random() * 5),
            initiatorType: 'script', nextHopProtocol: 'h2', workerStart: 0, redirectStart: 0, redirectEnd: 0,
            fetchStart: 25, domainLookupStart: 25, domainLookupEnd: 25, connectStart: 25, connectEnd: 25,
            secureConnectionStart: 25, requestStart: 29, responseStart: 42, firstInterimResponseStart: 0,
            finalResponseHeadersStart: 42, responseEnd: 42, transferSize: 0, encodedBodySize: 0, decodedBodySize: 84560,
            responseStatus: 200, contentType: 'text/javascript', renderBlockingStatus: 'non-blocking',
            deliveryType: 'cache', serverTiming: [] },
          appearance: pctx.params.appearance, au: pctx.au, cData: undefined, ch, chlPageData: undefined, cs: cs(),
          event: 'extraParams', execution: pctx.params.execution, 'expiry-interval': pctx.params['expiry-interval'],
          language: pctx.params.language, rcV: undefined, 'refresh-expired': pctx.params['refresh-expired'],
          'refresh-timeout': pctx.params['refresh-timeout'], retry: pctx.params.retry, 'retry-interval': pctx.params['retry-interval'],
          scs: undefined, source: SRC, timeExtraParamsMs: now - renderStart, timeInitMs: st.initStart - st.renderEnd,
          timeLoadInitMs: now - loadInit, timeParamsMs: st.paramsStart - st.initStart, timeRenderMs: st.renderEnd - renderStart,
          timeTiefMs: Date.now() - Xt, upgradeAttempts: 0, upgradeCompletedCount: 0, url: pctx.url, wPr: pctx.wPr, widgetId: m.widgetId,
        });
        send({ cs: cs(), event: 'execute', source: SRC, widgetId: m.widgetId });
        break;
      }
      case 'interactiveBegin':
        // api.js: appearance interaction-only → hiện widget (Er) → iframe 300x65; người dùng click sau ~1-3s
        setTimeout(() => dom.showWidget(300, 65), 60);
        setTimeout(async () => {
          const cb = dom.findInShadows('input[type=checkbox]');
          if (!cb) { log('[interactive] không thấy checkbox'); fs.writeFileSync(path.join(DIR, 'shadow_interactive.html'), dom.shadowHTML().join('\n<!-- ===== -->\n')); return; }
          log('[interactive] click checkbox ...');
          await dom.humanClick(cb);
          log(`[interactive] clicked, checked=${cb.checked}`);
        }, 1400 + Math.random() * 1200);
        break;
      case 'complete': resolveTok({ token: m.token }); break;
      case 'fail': case 'reject': case 'error': resolveTok({ error: m.event, detail: m }); break;
      default: break;
    }
  }

  log('[dom] parse + chạy inline orchestrate ...');
  if (process.env.HTML_OUT) fs.writeFileSync(process.env.HTML_OUT, html);   // chẩn đoán: HTML cuối (sau mọi bọc) để map vị trí stack
  dom = makeDom({ html, url, referrer: pctx.parentOrigin + '/', parentOrigin: pctx.parentOrigin, fp, log, onParentMessage, traceTimers: !!process.env.TRACE, navTiming: { fetchMs, htmlLen }, solveId });
  // PQPROBE=<file> (chẩn đoán mã hoá fo): khi global PQak3 (biến đổi khoá XTEA, do VM tạo) xuất hiện → ghi source + output mẫu
  if (process.env.PQPROBE) {
    const iv = setInterval(() => {
      const w = dom && dom.window, f = w && w.PQak3;
      if (typeof f !== 'function') return;
      clearInterval(iv);
      const probe = (arr) => { try { const r = f(w.Uint8Array.from(arr)); return { in: arr, type: Object.prototype.toString.call(r), out: Array.from(r || []) }; } catch (e) { return { in: arr, err: String(e) }; } };
      const seq = Array.from({ length: 16 }, (_, i) => i), zero = Array(128).fill(0), ff = Array(16).fill(255);
      fs.writeFileSync(process.env.PQPROBE, JSON.stringify({ src: String(f).slice(0, 20000), len: f.length, probes: [probe(zero), probe(seq), probe(ff), probe(seq.map((i) => i * 17 & 255)), probe(seq), probe(zero)] }, null, 1));
      log('[pqprobe] ghi ' + process.env.PQPROBE);
    }, 5);
  }
  log('[dom] main body xong, chờ token ...');
  let timer;
  const res = await Promise.race([tokenP, new Promise((res) => { timer = setTimeout(() => res({ error: 'timeout' }), TIMEOUT); })]);
  clearTimeout(timer);
  try { dom.close(!!res.token); } catch (_) {}   // worker tái sử dụng: dừng timer/rAF + trả RAM ngay, trước solve kế
  return res;
}

process.on('uncaughtException', (e) => log('[uncaught]', (e && e.stack || String(e)).split('\n').slice(0, 4).join(' | ')));
process.on('unhandledRejection', (e) => log('[unhandledRejection]', (e && e.stack || String(e)).split('\n').slice(0, 3).join(' | ')));

if (require.main === module) {
  solve().then((r) => {
    // token/fail luôn in (server parse stdout để lấy kết quả), độc lập với CF_DEBUG
    if (r.token) console.log('\n*** TOKEN ***\n' + r.token);
    else console.log('\n[!] FAILED', JSON.stringify(r).slice(0, 400));
    process.exit(r.token ? 0 : 1);
  }).catch((e) => { console.log('[FATAL]', (e && e.stack) || e); process.exit(2); });
}
module.exports = { solve };
