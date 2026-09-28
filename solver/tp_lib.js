// tp_lib.js — hàm dùng chung (Node + chèn nguyên văn vào biểu thức breakpoint trong Chrome):
// nhận diện collector không phụ thuộc tên khoá (tên đổi theo build CF).
// SKIPV: giá trị gắn phiên (chữ ký server "...-<ts>-1.x.1.1-...", timestamp ms) — không bao giờ cấy.
// common: khoá có mặt ở MỌI record số; sig = khoá còn lại (không SKIPV) sắp xếp.
const TP_SRC = `
function tpSkipV(v){return (typeof v==='string'&&/^1[0-9]{12}$/.test(v))||(typeof v==='string'&&/-[0-9]{10}-1\.[0-9]\.1\.1-/.test(v))||(typeof v==='number'&&v>1e12);}
function tpRecs(G){var ks=Object.keys(G).filter(function(k){return /^[0-9]+$/.test(k)&&G[k]&&typeof G[k]==='object';});var common=null,last={},dk=null;
  ks.forEach(function(k){var s=Object.keys(G[k]);common=common?common.filter(function(x){return s.indexOf(x)>=0;}):s;var l=s[s.length-1];last[l]=(last[l]||0)+1;if(!dk||last[l]>last[dk])dk=l;});
  return ks.map(function(k){var r=G[k],keys=Object.keys(r);return {k:k,r:r,dur:keys.indexOf(dk)>=0?dk:null,
    sig:keys.filter(function(x){return (common||[]).indexOf(x)<0&&!tpSkipV(r[x]);}).sort().join(','),
    data:keys.filter(function(x){return x!==dk&&!tpSkipV(r[x]);})};});}
`;
eval(TP_SRC);
const buildOf = (G) => { const m = JSON.stringify(G).match(/\/h\/([a-z])\/(?:fo|ci|turnstile)/); return m ? m[1] : '?'; };
module.exports = { TP_SRC, tpRecs, tpSkipV, buildOf };
