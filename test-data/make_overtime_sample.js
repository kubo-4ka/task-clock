// 時間外（基準超過）確認用の試用データ生成: node test-data/make_overtime_sample.js [基準日 YYYY-MM-DD]
// 2026年7月～基準日まで。祝日・夜勤（日またぎ）・休日夜間の障害対応・祝日出勤を含み、
// 月ごとの基準超過が上限目安45時間を「下回る月／超える月／ぎりぎりの月」になるよう調整する（架空データ）。
// アプリの推奨設定：日付の区切り時刻 05:00、基準時間 8:00、休日は土日＋祝日一覧
const fs = require('fs');
const path = require('path');

const END = process.argv[2] || '2026-10-02';
const START = '2026-07-01';
const BOUNDARY_H = 5;                 // 日付の区切り 05:00
const BASE_MIN = 480;                 // 勤務日の基準 8時間
const TARGET = { '2026-07': 36 * 60, '2026-08': 52.5 * 60, '2026-09': 44 * 60, '2026-10': 3 * 60 }; // 月の基準超過（分）

let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pad = n => String(n).padStart(2, '0');
const MIN = 60000, DAY = 86400000;
const key = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const at = (k, h, m = 0) => new Date(`${k}T00:00:00`).getTime() + (h * 60 + m) * MIN;
const bizKey = t => key(t - BOUNDARY_H * 60 * MIN);

// 2026年の祝日（アプリの一覧と同じもの）
const HOLIDAYS = {
  '2026-07-20': '海の日', '2026-08-11': '山の日', '2026-09-21': '敬老の日', '2026-09-22': '国民の休日',
  '2026-09-23': '秋分の日', '2026-10-12': 'スポーツの日'
};
const isWorkday = k => { const wd = new Date(k + 'T00:00:00').getDay(); return wd !== 0 && wd !== 6 && !HOLIDAYS[k]; };

// ---- マスタ ----
let n = 0; const id = p => `${p}_ot${(n++).toString(36)}`;
const created = new Date(START + 'T08:00:00').getTime();
const meta = t => ({ createdAt: t, updatedAt: t, updatedBy: 'device_sample' });
const projects = [
  { title: '基幹システム運用', color: 5, tags: ['運用'] },
  { title: '受発注システム改修', color: 0, tags: [] },
  { title: '社内共通業務', color: 2, tags: [] }
].map(p => ({ id: id('p'), note: '', archived: false, ...p, ...meta(created) }));
const P = Object.fromEntries(projects.map(p => [p.title, p]));
const T = (title, proj, category, extra = {}) => ({
  id: id('t'), title, projectId: P[proj].id, category, state: 'next', tags: [], due: '', review: '', estimateMin: 0, repeat: '',
  note: '', today: false, todayDate: '', done: false, doneAt: 0, ...meta(created), ...extra
});
const tasks = [
  T('受注画面 実装', '受発注システム改修', '実装'),
  T('結合テスト', '受発注システム改修', 'テスト'),
  T('設計レビュー対応', '受発注システム改修', '設計', { tags: ['レビュー'] }),
  T('夜間バッチ監視（夜勤）', '基幹システム運用', '夜勤', { tags: ['夜勤'] }),
  T('障害一次対応', '基幹システム運用', '障害', { tags: ['障害対応'] }),
  T('夜間リリース作業', '基幹システム運用', 'リリース', { tags: ['夜間作業'] }),
  T('問い合わせ対応', '基幹システム運用', '運用', { tags: ['問い合わせ'] }),
  T('朝会', '社内共通業務', '会議', { tags: ['会議'], state: 'calendar', repeat: 'weekday', due: '2026-10-05T09:15', estimateMin: 15 }),
  T('メール・チャット確認', '社内共通業務', '日次')
];
const TK = Object.fromEntries(tasks.map(t => [t.title, t]));
const projOf = t => projects.find(p => p.id === t.projectId);

const records = [];
const add = (task, s, e, extraTags = [], note = '') => {
  if (e <= s) return;
  const p = projOf(task);
  records.push({
    id: id('r'), taskId: task.id, levels: [p.title, task.category, task.title, '', ''],
    tags: [...new Set([...p.tags, ...task.tags, ...extraTags])],
    startedAt: s, endedAt: e, durationSec: Math.round((e - s) / 1000), kind: 'actual', source: 'timer', note, ...meta(e)
  });
};

// ---- 特別な勤務（夜勤・休日対応・祝日出勤） ----
const nightShifts = ['2026-08-05', '2026-08-19', '2026-09-09'];        // 平日夜勤（日中は休み）
const offAfterNight = new Set(nightShifts.map(k => key(new Date(k + 'T00:00:00').getTime() + DAY)).filter(isWorkday)); // 夜勤明けは休み
const special = [];
for (const k of nightShifts) special.push(() => {
  add(TK['夜間バッチ監視（夜勤）'], at(k, 20), at(k, 24));
  add(TK['夜間バッチ監視（夜勤）'], at(k, 24, 30), at(k, 26, 30));
  add(TK['障害一次対応'], at(k, 26, 30), at(k, 28, 50), ['夜勤'], 'バッチ異常終了の再実行'); // 翌4:50まで（区切り05:00より前なので同じ日）
});
// 休日夜間の障害対応・夜間リリース・祝日出勤
special.push(() => add(TK['障害一次対応'], at('2026-07-12', 1, 40), at('2026-07-12', 4, 10), ['休日対応'], '日曜未明 DB接続障害'));
special.push(() => add(TK['夜間リリース作業'], at('2026-07-20', 10), at('2026-07-20', 14, 30), ['休日対応'], '海の日 リリース'));
special.push(() => add(TK['障害一次対応'], at('2026-08-09', 2, 0), at('2026-08-09', 4, 40), ['休日対応'], '日曜未明 ネットワーク障害'));
special.push(() => add(TK['障害一次対応'], at('2026-08-11', 13), at('2026-08-11', 17, 30), ['休日対応'], '山の日 障害の恒久対応'));
special.push(() => add(TK['夜間リリース作業'], at('2026-08-22', 21), at('2026-08-22', 26), ['休日対応'], '土曜夜 リリース'));
special.push(() => add(TK['障害一次対応'], at('2026-09-21', 22), at('2026-09-21', 25, 30), ['休日対応'], '敬老の日 夜間障害'));
special.push(() => add(TK['夜間リリース作業'], at('2026-09-26', 9), at('2026-09-26', 12), ['休日対応'], '土曜 リリース'));
special.forEach(f => f());

// ---- 通常の勤務日：9:00-12:00 / 13:00-18:00 ＝ 8時間 ----
const workdays = [];
for (let t = new Date(START + 'T00:00:00').getTime(); key(t) <= END; t += DAY) {
  const k = key(t);
  if (isWorkday(k) && !nightShifts.includes(k) && !offAfterNight.has(k)) workdays.push(k);
}
const dayTasks = ['受注画面 実装', '受注画面 実装', '結合テスト', '設計レビュー対応', '問い合わせ対応'];
function fillDay(k, endH = 18) {
  let cur = at(k, 9);
  add(TK['メール・チャット確認'], cur, cur + 15 * MIN); cur += 15 * MIN;
  add(TK['朝会'], cur, cur + 15 * MIN); cur += 15 * MIN;
  for (const [s, e] of [[cur, at(k, 12)], [at(k, 13), at(k, endH)]]) {
    let c = s;
    while (c < e) {
      const len = Math.min(e - c, (30 + Math.floor(rnd() * 4) * 30) * MIN);
      const name = dayTasks[Math.floor(rnd() * dayTasks.length)];
      add(TK[name], c, c + len, name === '問い合わせ対応' ? ['割り込み'] : []);
      c += len;
    }
  }
}
workdays.forEach(k => fillDay(k));

// ---- 月ごとの目標に合わせて、勤務日の残業（18時以降）を配分 ----
function overtimeByMonth() {
  const day = new Map();
  for (const r of records) { const k = bizKey(r.startedAt); day.set(k, (day.get(k) || 0) + r.durationSec / 60); }
  const out = {};
  for (const [k, m] of day) { const mk = k.slice(0, 7); out[mk] = (out[mk] || 0) + Math.max(0, m - (isWorkday(k) ? BASE_MIN : 0)); }
  return out;
}
const before = overtimeByMonth();
for (const mk of Object.keys(TARGET)) {
  const days = workdays.filter(k => k.startsWith(mk));
  let remain = Math.max(0, TARGET[mk] - (before[mk] || 0));
  const extra = new Map(days.map(k => [k, 0]));
  let guard = 0;
  while (remain >= 30 && days.length && guard++ < 10000) {
    const k = days[Math.floor(rnd() * days.length)];
    if (extra.get(k) >= 210) continue; // 1日の残業は最大3.5時間
    extra.set(k, extra.get(k) + 30); remain -= 30;
  }
  for (const [k, m] of extra) {
    if (!m) continue;
    const name = rnd() < .6 ? '受注画面 実装' : '結合テスト';
    add(TK[name], at(k, 18), at(k, 18) + m * MIN, [], '残業');
  }
}

const after = overtimeByMonth();
const out = {
  app: 'TaskClock', version: '1.0.0', schema: 1, exportedAt: new Date().toISOString(), deviceId: 'device_sample',
  data: { projects, tasks, records, deleted: { projects: [], tasks: [], records: [] } }
};
const file = path.join(__dirname, `sample_overtime_${START.slice(0, 7).replace('-', '')}-${END.replaceAll('-', '').slice(0, 6)}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(file);
console.log(`projects ${projects.length} / tasks ${tasks.length} / records ${records.length}`);
const h = m => `${Math.floor(m / 60)}:${pad(Math.round(m % 60))}`;
for (const mk of Object.keys(after).sort()) console.log(`${mk}  基準超過 ${h(after[mk])}${after[mk] > 45 * 60 ? '  ← 45時間超' : ''}`);
