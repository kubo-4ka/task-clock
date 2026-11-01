// 試用データ生成: node test-data/make_sample.js [基準日 YYYY-MM-DD]
// 平日6週間分の実績・タスク・Projectと、今後2週間の予定を作る（架空データ）
const fs = require('fs');
const path = require('path');

const baseArg = process.argv[2];
const today = baseArg ? new Date(baseArg + 'T00:00:00') : new Date(new Date().toDateString());
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const DAY = 86400000, MIN = 60000;
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const created = today.getTime() - 50 * DAY;
const meta = t => ({ createdAt: t, updatedAt: t, updatedBy: 'device_sample' });
let n = 0; const id = p => `${p}_sample${(n++).toString(36)}`;

const projects = [
  { title: '受発注システム改修', color: 0, tags: [] },
  { title: '顧客ポータル保守', color: 1, tags: ['保守'] },
  { title: '社内共通業務', color: 2, tags: [] },
  { title: '新人育成', color: 3, tags: ['育成'] }
].map(p => ({ id: id('p'), note: '', archived: false, ...p, ...meta(created) }));
const P = Object.fromEntries(projects.map(p => [p.title, p.id]));

const T = (title, proj, category, state, extra = {}) => ({
  id: id('t'), title, projectId: P[proj] || '', category, state, tags: [], due: '', review: '', estimateMin: 0,
  note: '', today: false, todayDate: '', done: false, doneAt: 0, ...meta(created + Math.floor(rnd() * 20) * DAY), ...extra
});
const tasks = [
  T('要件ヒアリング', '受発注システム改修', '要件定義', 'next', { done: true, estimateMin: 240 }),
  T('基本設計書 作成', '受発注システム改修', '設計', 'next', { done: true, estimateMin: 960 }),
  T('API仕様書 作成', '受発注システム改修', '設計', 'next', { estimateMin: 600 }),
  T('DBテーブル設計レビュー反映', '受発注システム改修', '設計', 'next', { estimateMin: 180, tags: ['レビュー'] }),
  T('受注画面 実装', '受発注システム改修', '実装', 'next', { estimateMin: 1200 }),
  T('結合テスト仕様', '受発注システム改修', 'テスト', 'later', { estimateMin: 480 }),
  T('顧客から仕様回答待ち（出荷区分）', '受発注システム改修', '要件定義', 'waiting', { review: iso(new Date(today.getTime() - DAY)) }),
  T('問い合わせ対応', '顧客ポータル保守', '運用', 'next', { tags: ['問い合わせ'] }),
  T('ログイン障害 調査', '顧客ポータル保守', '障害', 'next', { tags: ['障害対応'], estimateMin: 120 }),
  T('月次リリース作業', '顧客ポータル保守', 'リリース', 'calendar', { estimateMin: 120 }),
  T('ライブラリ更新の影響調査', '顧客ポータル保守', '調査', 'inbox', { estimateMin: 240 }),
  T('朝会', '社内共通業務', '会議', 'next', { tags: ['会議'] }),
  T('週次定例', '社内共通業務', '会議', 'next', { tags: ['会議'] }),
  T('メール・チャット確認', '社内共通業務', '日次', 'next'),
  T('経費精算', '社内共通業務', '事務', 'inbox', { createdAt: today.getTime() - 6 * DAY }),
  T('勤怠締め', '社内共通業務', '事務', 'calendar', { due: iso(new Date(today.getTime() + 3 * DAY)), estimateMin: 30 }),
  T('新人課題レビュー', '新人育成', 'レビュー', 'next', { tags: ['レビュー'], estimateMin: 60 }),
  T('研修資料 更新', '新人育成', '資料', 'later'),
  T('来期の目標設定メモ', '', '', 'inbox')
];
const byTitle = Object.fromEntries(tasks.map(t => [t.title, t]));
byTitle['受注画面 実装'].today = true; byTitle['受注画面 実装'].todayDate = iso(today);
byTitle['ログイン障害 調査'].today = true; byTitle['ログイン障害 調査'].todayDate = iso(today);
byTitle['新人課題レビュー'].today = true; byTitle['新人課題レビュー'].todayDate = iso(today);
// 繰り返しの予定（定例・朝会・月次の締め）
const nextDow = dow => { const d = new Date(today); d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7 || 7)); return iso(d); };
Object.assign(byTitle['週次定例'], { state: 'calendar', due: nextDow(2) + 'T09:30', repeat: 'weekly', estimateMin: 60 });
Object.assign(byTitle['朝会'], { state: 'calendar', due: nextDow(1) + 'T09:15', repeat: 'weekday', estimateMin: 15 });
Object.assign(byTitle['勤怠締め'], { repeat: 'monthly' });
byTitle['月次リリース作業'].due = iso(new Date(today.getTime() + 5 * DAY)) + 'T18:00';
byTitle['受注画面 実装'].due = iso(new Date(today.getTime() + 14 * DAY));

const projTitle = Object.fromEntries(projects.map(p => [p.id, p.title]));
const projTags = Object.fromEntries(projects.map(p => [p.id, p.tags]));
const records = [];
const addRec = (t, start, mins, extraTags = [], kind = 'actual', note = '') => {
  const s = start, e = s + mins * MIN;
  records.push({
    id: id('r'), taskId: t ? t.id : '', levels: t ? [projTitle[t.projectId] || '(Projectなし)', t.category, t.title, '', ''] : ['仮タスク', '', '', '', ''],
    tags: [...new Set([...(t ? [...(projTags[t.projectId] || []), ...t.tags] : []), ...extraTags])],
    startedAt: s, endedAt: e, durationSec: mins * 60, kind, source: kind === 'plan' ? 'manual' : 'timer', note, ...meta(e)
  });
  return e;
};

// 実績：過去6週間の平日（今日は午前中まで）
const designTasks = ['要件ヒアリング', '基本設計書 作成', 'API仕様書 作成', 'DBテーブル設計レビュー反映', '受注画面 実装'];
for (let d = 42; d >= 0; d--) {
  const day = new Date(today.getTime() - d * DAY);
  if (day.getDay() === 0 || day.getDay() === 6) continue;
  const phase = Math.min(designTasks.length - 1, Math.floor((42 - d) / 9));
  let cur = day.getTime() + (9 * 60 + Math.floor(rnd() * 3) * 5) * MIN;
  const endOfDay = day.getTime() + (d === 0 ? 11 * 60 + 40 : 17 * 60 + 30 + Math.floor(rnd() * 180)) * MIN;
  cur = addRec(byTitle['メール・チャット確認'], cur, 15 + Math.floor(rnd() * 3) * 5);
  cur = addRec(byTitle['朝会'], cur, 15);
  if (day.getDay() === 2) cur = addRec(byTitle['週次定例'], cur + 5 * MIN, 60);
  while (cur < endOfDay - 20 * MIN) {
    const r = rnd();
    let t, mins, tags = [];
    if (r < 0.55) { t = byTitle[designTasks[phase]] || byTitle['API仕様書 作成']; mins = 45 + Math.floor(rnd() * 8) * 15; }
    else if (r < 0.70) { t = byTitle['問い合わせ対応']; mins = 10 + Math.floor(rnd() * 4) * 5; tags = ['割り込み']; }
    else if (r < 0.78) { t = byTitle['ログイン障害 調査']; mins = 20 + Math.floor(rnd() * 6) * 10; tags = rnd() < .5 ? ['割り込み'] : []; }
    else if (r < 0.86) { t = byTitle['新人課題レビュー']; mins = 30; }
    else if (r < 0.93) { t = byTitle[designTasks[phase]]; mins = 20 + Math.floor(rnd() * 3) * 10; tags = ['資料探索']; }
    else { t = null; mins = 10 + Math.floor(rnd() * 3) * 5; tags = ['割り込み']; }
    mins = Math.min(mins, Math.round((endOfDay - cur) / MIN));
    if (mins < 5) break;
    cur = addRec(t, cur, mins, tags);
    cur += (rnd() < 0.15 ? 15 + Math.floor(rnd() * 3) * 10 : rnd() < .4 ? 5 : 0) * MIN; // ときどき未記録のすき間
    if (cur > day.getTime() + 12 * 60 * MIN && cur < day.getTime() + 13 * 60 * MIN) cur = day.getTime() + 13 * 60 * MIN;
  }
}
// 見積は実績から逆算（完了分は ±30%、未完了は残作業ありの想定）
const actualMin = {};
records.forEach(r => { actualMin[r.taskId] = (actualMin[r.taskId] || 0) + r.durationSec / 60; });
const estFactor = { '要件ヒアリング': 0.8, '基本設計書 作成': 1.15, 'API仕様書 作成': 1.5, 'DBテーブル設計レビュー反映': 0.7, '受注画面 実装': 3 };
for (const [title, f] of Object.entries(estFactor)) {
  const t = byTitle[title];
  if (actualMin[t.id]) t.estimateMin = Math.round(actualMin[t.id] * f / 30) * 30;
}
byTitle['ログイン障害 調査'].estimateMin = 0;
byTitle['新人課題レビュー'].estimateMin = 0;
byTitle['DBテーブル設計レビュー反映'].done = true;
[['要件ヒアリング', 34], ['基本設計書 作成', 25], ['API仕様書 作成', 16], ['DBテーブル設計レビュー反映', 7]].forEach(([k, d]) => { byTitle[k].done = true; byTitle[k].doneAt = today.getTime() - d * DAY; });

// 予定：今後2週間の定例
for (let d = 1; d <= 14; d++) {
  const day = new Date(today.getTime() + d * DAY);
  if (day.getDay() === 4 && d < 8) addRec(byTitle['受注画面 実装'], day.getTime() + 13 * 60 * MIN, 240, [], 'plan', '集中枠');
}

const out = { app: 'TaskClock', version: '1.0.0', schema: 1, exportedAt: new Date().toISOString(), deviceId: 'device_sample', data: { projects, tasks, records, deleted: { projects: [], tasks: [], records: [] } } };
const file = path.join(__dirname, `sample_task_clock_${iso(today).replaceAll('-', '')}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${file}\nprojects ${projects.length} / tasks ${tasks.length} / records ${records.length}`);
