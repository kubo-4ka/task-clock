'use strict';
/* 汎用ユーティリティ（日時・書式・DOM） */

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function now() { return Date.now(); }
function pad(n) { return String(n).padStart(2, '0'); }
function readJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function esc(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 表記揺れ吸収（全角英数・半角カナなどをNFKCで寄せて比較） */
function nfkc(v) {
  const t = String(v ?? '').trim();
  try { return t.normalize('NFKC'); } catch { return t; }
}
function cmpKey(v) { return nfkc(v).toLocaleLowerCase('ja-JP'); }
function uniqTags(list, max = 8) {
  const out = [], seen = new Set();
  for (const raw of list || []) {
    const t = String(raw || '').trim().replace(/^#/, '');
    const k = cmpKey(t);
    if (t && !seen.has(k)) { seen.add(k); out.push(t); }
    if (out.length >= max) break;
  }
  return out;
}
function parseTagText(text) { return uniqTags(String(text || '').split(/[\s,、，]+/)); }

/* ---- 日付 ---- */
function dateKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayStart(ts = Date.now()) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dayEnd(ts = Date.now()) { return dayStart(ts) + DAY_MS - 1; }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
function weekStart(ts = Date.now()) {
  const d = new Date(dayStart(ts));
  const diff = (d.getDay() + 6) % 7; // 月曜始まり
  d.setDate(d.getDate() - diff);
  return d.getTime();
}
function monthStart(ts = Date.now()) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
function monthEnd(ts = Date.now()) { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1; }
function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN;
}
function parseLocalDateTime(v) {
  if (!v) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return parseDateKey(v);
  return new Date(v).getTime();
}
function toDateTimeInput(ts) {
  const d = new Date(ts);
  return `${dateKey(ts)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toTimeInput(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function minutesFromHHMM(v, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  return m ? (+m[1]) * 60 + (+m[2]) : fallback;
}
function hhmmFromMinutes(min) { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
function fmtDay(key) {
  const ts = typeof key === 'number' ? key : parseDateKey(key);
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}
function fmtDayFull(key) {
  const ts = typeof key === 'number' ? key : parseDateKey(key);
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}（${WEEKDAYS[d.getDay()]}）`;
}
function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDue(v) {
  if (!v) return '';
  const ts = parseLocalDateTime(v);
  if (Number.isNaN(ts)) return String(v);
  const d = new Date(ts);
  const base = `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
  return v.length > 10 ? `${base} ${fmtTime(ts)}` : base;
}
function daysBetween(fromTs, toTs = Date.now()) {
  return Math.round((dayStart(toTs) - dayStart(fromTs)) / DAY_MS);
}

/* ---- 日本の祝日（内閣府の規則に基づく計算。2020年以降を想定） ---- */
const _jpHolidayCache = new Map();
function jpHolidays(year) {
  if (_jpHolidayCache.has(year)) return _jpHolidayCache.get(year);
  const m = new Map();
  const k = (mo, d) => `${year}-${pad(mo)}-${pad(d)}`;
  const nthMonday = (mo, n) => { const first = new Date(year, mo - 1, 1).getDay(); return 1 + ((8 - first) % 7) + (n - 1) * 7; };
  [[1, 1, '元日'], [2, 11, '建国記念の日'], [2, 23, '天皇誕生日'], [4, 29, '昭和の日'], [5, 3, '憲法記念日'], [5, 4, 'みどりの日'], [5, 5, 'こどもの日'], [8, 11, '山の日'], [11, 3, '文化の日'], [11, 23, '勤労感謝の日']]
    .forEach(([mo, d, n]) => m.set(k(mo, d), n));
  m.set(k(1, nthMonday(1, 2)), '成人の日');
  m.set(k(7, nthMonday(7, 3)), '海の日');
  m.set(k(9, nthMonday(9, 3)), '敬老の日');
  m.set(k(10, nthMonday(10, 2)), 'スポーツの日');
  const y = year - 1980;
  m.set(k(3, Math.floor(20.8431 + 0.242194 * y - Math.floor(y / 4))), '春分の日');
  m.set(k(9, Math.floor(23.2488 + 0.242194 * y - Math.floor(y / 4))), '秋分の日');
  // 国民の休日：祝日に挟まれた平日
  for (const key of [...m.keys()]) {
    const next2 = dateKey(addDays(parseDateKey(key), 2)), next1 = dateKey(addDays(parseDateKey(key), 1));
    if (m.has(next2) && !m.has(next1) && new Date(parseDateKey(next1)).getDay() !== 0) m.set(next1, '国民の休日');
  }
  // 振替休日：日曜の祝日の後の最初の平日
  for (const key of [...m.keys()].sort()) {
    if (new Date(parseDateKey(key)).getDay() !== 0) continue;
    let d = addDays(parseDateKey(key), 1);
    while (m.has(dateKey(d))) d = addDays(d, 1);
    m.set(dateKey(d), '振替休日');
  }
  _jpHolidayCache.set(year, m);
  return m;
}

/* ---- 時間 ---- */
function fmtDur(sec, unit = 'hm') {
  sec = Math.max(0, Math.round(sec || 0));
  if (unit === 'hours') return (sec / 3600).toFixed(2) + 'h';
  if (unit === 'minutes') return Math.round(sec / 60) + '分';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return `${h}:${pad(m)}`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
}
function fmtMin(min) {
  min = Math.round(min || 0);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}
function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }

/* ---- 文字列から見積を解釈: 30m / 1.5h / 1h30m / 90 ---- */
function parseEstimate(text) {
  const t = nfkc(text).toLowerCase();
  if (!t) return 0;
  let m;
  if ((m = /^(\d+(?:\.\d+)?)h(?:(\d+)m?)?$/.exec(t))) return Math.round(parseFloat(m[1]) * 60 + (m[2] ? +m[2] : 0));
  if ((m = /^(\d+)(?:m|分)?$/.exec(t))) return +m[1];
  if ((m = /^(\d+(?:\.\d+)?)(?:時間)$/.exec(t))) return Math.round(parseFloat(m[1]) * 60);
  return 0;
}

function fmtSec(sec) { return sec < 60 ? `${sec}秒` : fmtMin(sec / 60); }
function estText(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? m + 'm' : ''}` : `${m}m`;
}

/* ---- ファイル ---- */
function downloadText(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  const src = String(text).replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  row.push(field.replace(/\r$/, ''));
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}
function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file, 'utf-8');
  });
}
