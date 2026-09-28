'use strict';
// cf_temporal.js — Temporal (Chrome 153 có, V8 của Node 24 chưa): đúng hình dạng theo dump chrome_temporal.json
// (thứ tự, length, descriptor, toStringTag), lõi chạy được: Now.*, Instant, PlainDate/Time/DateTime, ZonedDateTime.
// ponytail: không có calendar/timezone arithmetic đầy đủ (add/until/round… ném RangeError) — đủ cho probe hình dạng + Now.
const fs = require('fs');
const path = require('path');
let D = null;
try { D = JSON.parse(fs.readFileSync(path.join(__dirname, 'chrome_temporal.json'), 'utf8')); } catch (_) {}

function installTemporal(w, { mark }) {
  if (!D || 'Temporal' in w) return;
  const O = w.Object, SLOT = new WeakMap();
  const TE = (m) => new w.TypeError(m), RE = (m) => new w.RangeError(m);
  const tz = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowNs = () => BigInt(Date.now()) * 1000000n + BigInt(Math.floor((performance.now() % 1) * 1e6));
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  // trường lịch ISO của một epochNs theo tz (dùng Intl của realm Node — cùng ICU)
  const fields = (ns, zone) => {
    const ms = Number(ns / 1000000n), sub = Number(((ns % 1000000n) + 1000000n) % 1000000n);
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone || 'UTC', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms)).map((x) => [x.type, +x.value]));
    const utc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second), off = (utc - (ms - (((ms % 1000) + 1000) % 1000))) / 60000;
    return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second, millisecond: ((ms % 1000) + 1000) % 1000, microsecond: Math.floor(sub / 1000), nanosecond: sub % 1000, offMin: off };
  };
  const dateStr = (f) => `${f.year}-${pad(f.month)}-${pad(f.day)}`;
  const timeStr = (f) => { let s = `${pad(f.hour)}:${pad(f.minute)}:${pad(f.second)}`; const frac = `${pad(f.millisecond, 3)}${pad(f.microsecond, 3)}${pad(f.nanosecond, 3)}`.replace(/0+$/, ''); return frac ? `${s}.${frac}` : s; };
  const offStr = (m) => `${m < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
  const doy = (f) => Math.round((Date.UTC(f.year, f.month - 1, f.day) - Date.UTC(f.year, 0, 1)) / 864e5) + 1;
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const GET = {   // getter chung theo kind của slot
    calendarId: () => 'iso8601', year: (s) => s.f.year, month: (s) => s.f.month, day: (s) => s.f.day, monthCode: (s) => `M${pad(s.f.month)}`,
    hour: (s) => s.f.hour, minute: (s) => s.f.minute, second: (s) => s.f.second, millisecond: (s) => s.f.millisecond, microsecond: (s) => s.f.microsecond, nanosecond: (s) => s.f.nanosecond,
    dayOfWeek: (s) => { const d = new Date(Date.UTC(s.f.year, s.f.month - 1, s.f.day)).getUTCDay(); return d === 0 ? 7 : d; }, dayOfYear: (s) => doy(s.f),
    daysInMonth: (s) => new Date(Date.UTC(s.f.year, s.f.month, 0)).getUTCDate(), daysInYear: (s) => (leap(s.f.year) ? 366 : 365), daysInWeek: () => 7, monthsInYear: () => 12, inLeapYear: (s) => leap(s.f.year),
    era: () => undefined, eraYear: () => undefined, weekOfYear: (s) => Math.ceil((doy(s.f) - GET.dayOfWeek(s) + 10) / 7), yearOfWeek: (s) => s.f.year,
    epochMilliseconds: (s) => Number(s.ns / 1000000n), epochNanoseconds: (s) => s.ns, timeZoneId: (s) => s.tz,
    offset: (s) => offStr(s.f.offMin), offsetNanoseconds: (s) => s.f.offMin * 60e9, hoursInDay: () => 24,
  };
  const STR = { Instant: (s) => `${dateStr(s.f)}T${timeStr(s.f)}Z`, PlainDate: (s) => dateStr(s.f), PlainTime: (s) => timeStr(s.f), PlainDateTime: (s) => `${dateStr(s.f)}T${timeStr(s.f)}`,
    ZonedDateTime: (s) => `${dateStr(s.f)}T${timeStr(s.f)}${offStr(s.f.offMin)}[${s.tz}]`, PlainYearMonth: (s) => `${s.f.year}-${pad(s.f.month)}`, PlainMonthDay: (s) => `${pad(s.f.month)}-${pad(s.f.day)}`, Duration: () => 'PT0S' };
  const C = {};
  const mk = (kind, ns, zone) => { const o = O.create(C[kind].prototype); SLOT.set(o, { kind, ns, tz: zone, f: fields(ns, kind === 'Instant' ? 'UTC' : zone) }); return o; };
  const slot = (o, kind) => { const s = SLOT.get(o); if (!s || s.kind !== kind) throw TE('Illegal invocation'); return s; };
  const fn = (name, len, impl) => { const f = mark({ [name](...a) { return impl.apply(this, a); } }[name]); Object.defineProperty(f, 'length', { value: len, configurable: true }); return f; };
  const def = (obj, [k, kind, en, cf, wr, len], impl) => {
    if (kind === 'f') Object.defineProperty(obj, k, { value: fn(k, len, impl), writable: !!wr, enumerable: !!en, configurable: !!cf });
    else if (kind === 'v') Object.defineProperty(obj, k, { value: len, writable: !!wr, enumerable: !!en, configurable: !!cf });
    else Object.defineProperty(obj, k, { get: mark(Object.getOwnPropertyDescriptor({ get [k]() { return impl.call(this); } }, k).get), enumerable: !!en, configurable: !!cf });
  };
  const T = O.create(O.prototype);
  for (const [kind, cd] of Object.entries(D.classes)) {
    const F = mark(function (...a) {
      if (!new.target) throw TE(`Constructor Temporal.${kind} requires 'new'`);
      if (kind === 'Instant') { if (typeof a[0] !== 'bigint') throw TE('Cannot convert ' + String(a[0]) + ' to a BigInt'); const o = mk('Instant', a[0], 'UTC'); if (new.target !== F) Object.setPrototypeOf(o, new.target.prototype); return o; }
      if (kind === 'PlainDate' || kind === 'PlainDateTime') { const [y, m, d, h = 0, mi = 0, s = 0] = a.map(Number); if (![y, m, d].every(Number.isFinite)) throw RE('Invalid time value'); return mk(kind, BigInt(Date.UTC(y, m - 1, d, h, mi, s)) * 1000000n, 'UTC'); }
      if (kind === 'PlainTime') { const [h = 0, mi = 0, s = 0] = a.map(Number); return mk(kind, BigInt(Date.UTC(1970, 0, 1, h, mi, s)) * 1000000n, 'UTC'); }
      if (kind === 'ZonedDateTime') { if (typeof a[0] !== 'bigint') throw TE('Cannot convert ' + String(a[0]) + ' to a BigInt'); return mk(kind, a[0], String(a[1])); }
      throw RE(`Temporal.${kind}: unsupported`);
    }, kind);
    Object.defineProperty(F, 'length', { value: cd.len, configurable: true });
    Object.setPrototypeOf(F, w.Function.prototype);
    const P = O.create(O.prototype);
    Object.defineProperty(F, 'prototype', { value: P, writable: false, enumerable: false, configurable: false });
    for (const p of cd.statics) def(F, p, function () { throw RE(`Temporal.${kind}.${p[0]}: unsupported`); });
    for (const p of cd.proto) {
      const k = p[0];
      if (k === 'constructor') { Object.defineProperty(P, k, { value: F, writable: true, enumerable: false, configurable: true }); continue; }
      def(P, p, p[1] === 'f'
        ? (k === 'toString' || k === 'toJSON' ? function () { return STR[kind](slot(this, kind)); }
          : k === 'toLocaleString' ? function (...a) { const s = slot(this, kind); return new w.Intl.DateTimeFormat(...a).format(new w.Date(Number(s.ns / 1000000n))); }
          : k === 'valueOf' ? function () { slot(this, kind); throw TE(`Do not use Temporal.${kind}.prototype.valueOf; use Temporal.${kind}.prototype.compare for comparison.`); }
          : k === 'equals' ? function (o) { const s = slot(this, kind), t = SLOT.get(o); return !!t && t.kind === kind && t.ns === s.ns; }
          : function () { slot(this, kind); throw RE(`Temporal.${kind}.prototype.${k}: unsupported`); })
        : function () { const s = slot(this, kind); return GET[k] ? GET[k](s) : undefined; });
    }
    if (cd.tag) Object.defineProperty(P, Symbol.toStringTag, { value: cd.tag, configurable: true });
    C[kind] = F;
  }
  const Now = O.create(O.prototype);
  const NOW = { instant: () => mk('Instant', nowNs(), 'UTC'), timeZoneId: () => tz(), plainDateTimeISO: (z) => mk('PlainDateTime', nowNs(), z === undefined ? tz() : String(z)),
    zonedDateTimeISO: (z) => mk('ZonedDateTime', nowNs(), z === undefined ? tz() : String(z)), plainDateISO: (z) => mk('PlainDate', nowNs(), z === undefined ? tz() : String(z)), plainTimeISO: (z) => mk('PlainTime', nowNs(), z === undefined ? tz() : String(z)) };
  for (const p of D.now.own) def(Now, p, NOW[p[0]] || (() => undefined));
  Object.defineProperty(Now, Symbol.toStringTag, { value: D.now.tag, configurable: true });
  for (const p of D.own) Object.defineProperty(T, p[0], { value: p[0] === 'Now' ? Now : C[p[0]], writable: !!p[4], enumerable: !!p[2], configurable: !!p[3] });
  Object.defineProperty(T, Symbol.toStringTag, { value: D.tag, configurable: true });
  Object.defineProperty(w, 'Temporal', { value: T, writable: !!D.desc.writable, enumerable: !!D.desc.enumerable, configurable: !!D.desc.configurable });
}

module.exports = { installTemporal };
