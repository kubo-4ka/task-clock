'use strict';
/* データ層：保存・正規化・マージ・集計の元になる問い合わせ */

const APP_VERSION = '1.0.0';
const DATA_KEY = 'taskClock.data.v1';
const SETTINGS_KEY = 'taskClock.settings.v1';
const TIMER_KEY = 'taskClock.timer.v1';
const DEVICE_KEY = 'taskClock.deviceId';
const STATES = ['inbox', 'next', 'waiting', 'calendar', 'later'];
const STATE_LABELS = { inbox: 'Inbox', next: 'Next', waiting: 'Waiting', calendar: 'Calendar', later: 'Later' };
const NO_PROJECT = '(Projectなし)';
const QUICK_LEVEL = '仮タスク';
const INTERRUPT_TAG = '割り込み';

const deviceId = (() => {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = uid('device'); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return uid('device'); }
})();

const DEFAULT_SETTINGS = {
  theme: 'middle',
  density: 'normal',         // normal / compact
  navPosition: 'auto',       // auto（狭い画面は下）/ top / bottom
  clockEnabled: true,
  durUnit: 'hm',
  // 勤務と時間
  baseMinutes: 480,          // 勤務日の基準時間（休日は0＝全て休日作業）
  workStartMode: 'first',    // first: その日の最初の記録から / fixed: 勤務日は始業時刻から
  workStart: '09:00',        // 勤務日の始業予定
  dayBoundary: '00:00',      // 日付の区切り（夜勤で日をまたぐ作業を前日扱いにする）
  gapMinMinutes: 10,         // この分数以上の空きを「未記録」とする
  minRecordSec: 30,          // これ未満の計測は記録しない
  longTimerHours: 4,         // これを超える計測は停止時に終了時刻を確認
  // 休日
  offWeekdays: [0, 6],
  holidays: [],              // 祝日・会社の休日・出勤日 [{ date: '2026-10-12', name: 'スポーツの日', work: false }]
  holidaysUpdatedAt: 0,      // 休日一覧の最終更新（端末間マージで新しい方を採用）
  holidaysSeeded: false,     // 初回起動時に今年の祝日を一覧へ入れたか
  sessionIdleHours: 3,       // 最後の記録からこの時間空いたら、その日の勤務は終わったものとみなす
  monthOverLimitHours: 45,   // 月の基準超過（時間外）の上限目安
  // 詰まり・通知
  inboxStaleDays: 3,
  waitingStaleDays: 7,
  alertEnabled: true,
  alertIntervalMinutes: 120,
  osNotify: false,
  osNotifyAlways: false,     // 画面を見ている時もOS通知を出す
  idleNotifyMin: 30,         // 勤務中に計測なしでこの分数経過したら通知（0で無効）
  runNotifyMin: 30,          // 計測中この分数ごとに通知（0で無効）
  remindBeforeMin: 15,       // 日時つき予定のこの分前に通知（0で無効）
  // 引き継ぎ
  syncPathNote: '',
  autoExport: false,
  closeWarn: true,
  lastExportAt: 0,
  lastImportAt: 0,
  lastChangeAt: 0,
  lastAlertAt: 0,
  lastStartPromptDate: '',
  closedDay: '',             // 「終業」した業務日
  notifyMarks: {}
};

/* ---------- 業務日・休日 ---------- */
function dayOffsetMs() { return minutesFromHHMM(store.settings.dayBoundary, 0) * MIN_MS; }
function bizDayKey(t = now()) { return dateKey(t - dayOffsetMs()); }
function bizDayStart(t = now()) { const o = dayOffsetMs(); return dayStart(t - o) + o; }
function bizDayStartOfKey(key) { return parseDateKey(key) + dayOffsetMs(); }
function todayKey() { return bizDayKey(); }
/* ---------- 休日一覧（利用者が管理） ---------- */
function normHoliday(h) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(h?.date || '').trim());
  if (!m) return null;
  const work = !!h.work;
  return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, name: String(h.name || '').trim() || (work ? '出勤日' : '休日'), work };
}
function normHolidayList(list) {
  const map = new Map();
  for (const h of Array.isArray(list) ? list : []) { const n = normHoliday(h); if (n) map.set(n.date, n); }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}
let _holidayCache = { ref: null, map: new Map() };
function customHolidayMap() {
  const list = store.settings.holidays;
  if (_holidayCache.ref === list) return _holidayCache.map;
  _holidayCache = { ref: list, map: new Map((list || []).map(h => [h.date, h])) };
  return _holidayCache.map;
}
function setHolidays(list, updatedAt = now()) {
  store.settings.holidays = normHolidayList(list);
  store.settings.holidaysUpdatedAt = updatedAt;
  saveSettings();
}
function upsertHoliday(h, oldDate = '') {
  const n = normHoliday(h); if (!n) return false;
  setHolidays([...store.settings.holidays.filter(x => x.date !== n.date && x.date !== oldDate), n]);
  return true;
}
function removeHoliday(date) { setHolidays(store.settings.holidays.filter(x => x.date !== date)); }
/* 暦どおりの祝日をまとめて追加（登録済みの日付はそのまま） */
function addNationalHolidays(year) {
  const have = customHolidayMap();
  const add = [...jpHolidays(year)].filter(([k]) => !have.has(k)).map(([date, name]) => ({ date, name, work: false }));
  if (add.length) setHolidays([...store.settings.holidays, ...add]);
  return add.length;
}
/* 旧形式（1行1件のテキスト）からの読み込み */
function holidaysFromText(text) {
  const list = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\+)?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s*(.*)$/.exec(line);
    if (m) list.push({ date: m[2].replaceAll('/', '-'), name: m[3], work: !!m[1] });
  }
  return list;
}
/* 休日なら名前（土日は「土曜」「日曜」）、勤務日なら '' */
function holidayName(key) {
  const c = customHolidayMap().get(key);
  if (c) return c.work ? '' : c.name;
  const wd = new Date(parseDateKey(key)).getDay();
  return (store.settings.offWeekdays || []).includes(wd) ? WEEKDAYS[wd] + '曜' : '';
}
function isWorkday(key) { return !holidayName(key); }
function baseSecOf(key) { return isWorkday(key) ? num(store.settings.baseMinutes, 480) * 60 : 0; }

/* ---------- 繰り返し ---------- */
const REPEAT_LABELS = { '': 'なし', daily: '毎日', weekday: '勤務日ごと', weekly: '毎週', monthly: '毎月' };
function nextOccurrence(due, repeat) {
  const base = parseLocalDateTime(due);
  if (Number.isNaN(base)) return '';
  const time = due.length > 10 ? due.slice(10) : '';
  let d = new Date(base);
  const step = () => {
    if (repeat === 'monthly') { const day = new Date(base).getDate(); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
    else d = new Date(addDays(d.getTime(), repeat === 'weekly' ? 7 : 1));
  };
  step();
  if (repeat === 'weekday') for (let i = 0; i < 30 && !isWorkday(dateKey(d.getTime())); i++) step();
  return dateKey(d.getTime()) + time;
}

const store = {
  data: emptyData(),
  settings: { ...DEFAULT_SETTINGS },
  timer: emptyTimer(),
  dirty: false,
  listeners: []
};

function emptyData() {
  return { projects: [], tasks: [], records: [], deleted: { projects: [], tasks: [], records: [] } };
}
function emptyTimer() {
  return { running: false, startedAt: 0, taskId: '', levels: [], tags: [], note: '', resume: null };
}

/* ---------- 正規化 ---------- */
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function ts(v) {
  if (v === '' || v == null) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}
function meta(x) {
  const createdAt = ts(x.createdAt) || now();
  return { createdAt, updatedAt: ts(x.updatedAt) || createdAt, updatedBy: String(x.updatedBy || '') };
}
function normProject(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    id: String(p.id || uid('p')),
    title: String(p.title || '').trim() || '無題のProject',
    note: String(p.note || ''),
    tags: uniqTags(p.tags),
    color: num(p.color, Math.floor(Math.random() * 8)) % 8,
    archived: !!p.archived,
    ...meta(p)
  };
}
function normTask(t) {
  if (!t || typeof t !== 'object') return null;
  return {
    id: String(t.id || uid('t')),
    title: String(t.title || '').trim() || '無題のタスク',
    state: STATES.includes(t.state) ? t.state : 'inbox',
    projectId: String(t.projectId || ''),
    category: String(t.category || ''),
    tags: uniqTags(t.tags),
    due: String(t.due || ''),
    review: String(t.review || ''),
    estimateMin: Math.max(0, Math.round(num(t.estimateMin))),
    repeat: REPEAT_LABELS[t.repeat] && t.repeat ? t.repeat : '',
    note: String(t.note || ''),
    today: !!t.today,
    todayDate: String(t.todayDate || ''),
    done: !!t.done,
    doneAt: ts(t.doneAt),
    ...meta(t)
  };
}
function normLevels(levels) {
  const a = Array.isArray(levels) ? levels : [];
  return Array.from({ length: 5 }, (_, i) => String(a[i] || '').trim());
}
function normRecord(r) {
  if (!r || typeof r !== 'object') return null;
  const startedAt = ts(r.startedAt);
  if (!startedAt) return null;
  let endedAt = ts(r.endedAt);
  let durationSec = Math.max(0, Math.round(num(r.durationSec)));
  if (!endedAt) endedAt = startedAt + durationSec * 1000;
  if (!durationSec) durationSec = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  return {
    id: String(r.id || uid('r')),
    taskId: String(r.taskId || ''),
    levels: normLevels(r.levels),
    tags: uniqTags(r.tags),
    startedAt, endedAt, durationSec,
    kind: (r.kind || r.recordKind) === 'plan' ? 'plan' : 'actual',
    source: String(r.source || 'manual'),
    note: String(r.note || ''),
    ...meta(r)
  };
}
function normTomb(x) {
  return x && x.id ? { id: String(x.id), deletedAt: ts(x.deletedAt), deletedBy: String(x.deletedBy || '') } : null;
}
function normData(src) {
  const s = src && typeof src === 'object' ? src : {};
  const d = s.deleted || {};
  return {
    projects: (s.projects || []).map(normProject).filter(Boolean),
    tasks: (s.tasks || []).map(normTask).filter(Boolean),
    records: (s.records || []).map(normRecord).filter(Boolean),
    deleted: {
      projects: (d.projects || []).map(normTomb).filter(Boolean),
      tasks: (d.tasks || []).map(normTomb).filter(Boolean),
      records: (d.records || []).map(normTomb).filter(Boolean)
    }
  };
}

/* ---------- 保存 ---------- */
function loadStore() {
  store.data = normData(readJSON(localStorage.getItem(DATA_KEY)));
  store.settings = { ...DEFAULT_SETTINGS, ...(readJSON(localStorage.getItem(SETTINGS_KEY)) || {}) };
  const t = readJSON(localStorage.getItem(TIMER_KEY));
  store.timer = t && t.running ? { ...emptyTimer(), ...t } : emptyTimer();
  store.dirty = num(store.settings.lastChangeAt) > num(store.settings.lastExportAt);
  // 初回は今年の祝日を休日一覧に入れておく（以降は利用者が一覧を管理）
  store.settings.holidays = normHolidayList(store.settings.holidays);
  if (store.settings.customHolidays) { // テキスト形式の一覧を取り込む
    store.settings.holidays = normHolidayList([...store.settings.holidays, ...holidaysFromText(store.settings.customHolidays)]);
    delete store.settings.customHolidays;
    saveSettings();
  }
  if (!store.settings.holidaysSeeded) {
    store.settings.holidaysSeeded = true;
    addNationalHolidays(new Date().getFullYear());
    store.settings.holidaysUpdatedAt = 0; // 初期値なので、他の端末で管理している一覧があればそちらを優先
    saveSettings();
  }
  rebuildIndex();
}
function persist() {
  try { localStorage.setItem(DATA_KEY, JSON.stringify(store.data)); }
  catch (e) { alert('保存に失敗しました（ブラウザの保存容量不足の可能性）: ' + e.message); }
}
function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings)); }
function saveTimer() { localStorage.setItem(TIMER_KEY, JSON.stringify(store.timer)); }
function commit() {
  store.settings.lastChangeAt = now();
  store.dirty = true;
  persist(); saveSettings(); rebuildIndex();
  store.listeners.forEach(fn => fn());
}
function touch(o) { o.updatedAt = now(); o.updatedBy = deviceId; return o; }
function tomb(list, id) {
  store.data.deleted[list] = store.data.deleted[list].filter(x => x.id !== id);
  store.data.deleted[list].push({ id, deletedAt: now(), deletedBy: deviceId });
}

/* ---------- 索引 ---------- */
const idx = { project: new Map(), task: new Map(), taskActual: new Map(), projectActual: new Map() };
function rebuildIndex() {
  idx.project = new Map(store.data.projects.map(p => [p.id, p]));
  idx.task = new Map(store.data.tasks.map(t => [t.id, t]));
  idx.taskActual = new Map();
  for (const r of store.data.records) {
    if (r.kind !== 'actual' || !r.taskId) continue;
    idx.taskActual.set(r.taskId, (idx.taskActual.get(r.taskId) || 0) + r.durationSec);
  }
}
const getProject = id => idx.project.get(id) || null;
const getTask = id => idx.task.get(id) || null;
function projectTitle(id) { return getProject(id)?.title || ''; }
function taskActualSec(id) {
  let s = idx.taskActual.get(id) || 0;
  if (store.timer.running && store.timer.taskId === id) s += (now() - store.timer.startedAt) / 1000;
  return s;
}

/* タスクから記録の分類を作る：Project > 分類 > タスク名 */
function levelsForTask(t) {
  if (!t) return normLevels([QUICK_LEVEL, `${todayKey().replaceAll('-', '')}に開始`]);
  return normLevels([projectTitle(t.projectId) || NO_PROJECT, t.category, t.title]);
}
function tagsForTask(t) {
  if (!t) return [];
  return uniqTags([...(getProject(t.projectId)?.tags || []), ...t.tags]);
}
/* タスク/Project名変更時、紐付く記録の分類を追従させる */
function syncRecordsOfTask(taskId) {
  const t = getTask(taskId); if (!t) return 0;
  const lv = levelsForTask(t); let n = 0;
  for (const r of store.data.records) {
    if (r.taskId !== taskId) continue;
    if (r.levels.slice(0, 3).join('\u0000') !== lv.slice(0, 3).join('\u0000')) {
      r.levels = normLevels([...lv.slice(0, 3), r.levels[3], r.levels[4]]); touch(r); n++;
    }
  }
  return n;
}
function isToday(t) { return t.today && (!t.todayDate || t.todayDate === todayKey()); }

/* ---------- タスク操作 ---------- */
function addTask(fields) {
  const t = normTask({ ...fields, id: uid('t'), createdAt: now() });
  touch(t);
  store.data.tasks.push(t);
  idx.task.set(t.id, t);
  return t;
}
function updateTask(id, fields) {
  const t = getTask(id); if (!t) return null;
  const rename = ('title' in fields && fields.title !== t.title) || ('projectId' in fields && fields.projectId !== t.projectId) || ('category' in fields && fields.category !== t.category);
  Object.assign(t, normTask({ ...t, ...fields }));
  if (fields.today === true) t.todayDate = todayKey();
  if ('done' in fields) {
    const wasDone = !!t.doneAt;
    t.doneAt = fields.done ? (t.doneAt || now()) : 0;
    if (fields.done && !wasDone) t.spawnedId = spawnNextOccurrence(t);
  }
  touch(t);
  if (rename) { rebuildIndex(); syncRecordsOfTask(id); }
  return t;
}
/* 繰り返しタスクを完了したら次回分を作る */
function spawnNextOccurrence(t) {
  if (!t.repeat || !t.due) return '';
  const due = nextOccurrence(t.due, t.repeat);
  if (!due) return '';
  const { id, createdAt, updatedAt, updatedBy, done, doneAt, today, todayDate, spawnedId, ...rest } = t;
  return addTask({ ...rest, due }).id;
}
/* 日時固定（Calendar）の繰り返しは、過ぎた回を自動で次回へ送る（定例会議など） */
function rollRecurring() {
  const today0 = parseDateKey(todayKey()); let n = 0;
  for (const t of store.data.tasks) {
    if (t.done || !t.repeat || !t.due || t.state !== 'calendar') continue;
    let due = t.due, guard = 0;
    while (parseDateKey(due.slice(0, 10)) < today0 && guard++ < 400) due = nextOccurrence(due, t.repeat);
    if (due !== t.due) { t.due = due; touch(t); n++; }
  }
  return n;
}
function deleteTask(id) {
  store.data.tasks = store.data.tasks.filter(t => t.id !== id);
  tomb('tasks', id);
  // 記録は残す（集計の実績は消さない）。タスクIDのみ外す
  for (const r of store.data.records) if (r.taskId === id) { r.taskId = ''; touch(r); }
  if (store.timer.taskId === id) { store.timer.taskId = ''; saveTimer(); }
}
function addProject(fields) {
  const p = normProject({ ...fields, id: uid('p'), createdAt: now() });
  touch(p);
  store.data.projects.push(p);
  idx.project.set(p.id, p);
  return p;
}
function updateProject(id, fields) {
  const p = getProject(id); if (!p) return null;
  const rename = 'title' in fields && fields.title !== p.title;
  Object.assign(p, normProject({ ...p, ...fields }));
  touch(p);
  if (rename) {
    rebuildIndex();
    store.data.tasks.filter(t => t.projectId === id).forEach(t => syncRecordsOfTask(t.id));
  }
  return p;
}
function deleteProject(id) {
  store.data.projects = store.data.projects.filter(p => p.id !== id);
  tomb('projects', id);
  for (const t of store.data.tasks) if (t.projectId === id) { t.projectId = ''; touch(t); }
}
function findOrCreateProject(title) {
  const k = cmpKey(title); if (!k) return '';
  const hit = store.data.projects.find(p => cmpKey(p.title) === k);
  return hit ? hit.id : addProject({ title: nfkc(title) }).id;
}

/* ---------- 記録操作 ---------- */
function addRecord(fields) {
  const r = normRecord({ ...fields, id: uid('r'), createdAt: now() });
  if (!r) return null;
  touch(r);
  store.data.records.push(r);
  return r;
}
function updateRecord(id, fields) {
  const r = store.data.records.find(x => x.id === id); if (!r) return null;
  Object.assign(r, normRecord({ ...r, ...fields }));
  touch(r);
  return r;
}
function deleteRecord(id) {
  store.data.records = store.data.records.filter(r => r.id !== id);
  tomb('records', id);
}

/* ---------- タイマー ---------- */
function timerElapsedSec() { return store.timer.running ? (now() - store.timer.startedAt) / 1000 : 0; }
function startTimer({ taskId = '', levels = null, tags = null, note = '', resume = null } = {}) {
  const t = taskId ? getTask(taskId) : null;
  store.timer = {
    running: true, startedAt: now(), taskId: t ? t.id : '',
    levels: levels || levelsForTask(t), tags: tags || tagsForTask(t), note, resume
  };
  saveTimer();
}
/* 停止して記録化。endAt を指定すると終了時刻を補正できる */
function stopTimer({ endAt = now(), discard = false } = {}) {
  if (!store.timer.running) return null;
  const tm = store.timer;
  let rec = null;
  const dur = Math.round((endAt - tm.startedAt) / 1000);
  const minSec = Math.max(0, num(store.settings.minRecordSec, 30));
  if (!discard && dur >= Math.max(1, minSec)) { // 短すぎる計測は押し間違いとして記録しない
    const t = tm.taskId ? getTask(tm.taskId) : null;
    rec = addRecord({
      taskId: tm.taskId, levels: t ? levelsForTask(t) : tm.levels, tags: tm.tags,
      startedAt: tm.startedAt, endedAt: endAt, durationSec: dur, kind: 'actual', source: 'timer', note: tm.note
    });
  }
  store.timer = emptyTimer();
  saveTimer();
  return { rec, resume: tm.resume, tooShort: !discard && dur < Math.max(1, minSec), minSec };
}

/* ---------- アラート（詰まり検出） ---------- */
function taskAlert(t) {
  const s = store.settings;
  if (t.done) return null;
  if (t.due) {
    const dueTs = parseLocalDateTime(t.due);
    const limit = t.due.length <= 10 ? dueTs + DAY_MS : dueTs;
    if (!Number.isNaN(dueTs) && limit < now()) return { kind: 'overdue', severity: 'critical', label: '期限超過', detail: `期限 ${fmtDue(t.due)}` };
  }
  if (t.state === 'waiting' && t.review && t.review <= todayKey()) return { kind: 'waiting_review', severity: 'critical', label: '確認日到来', detail: `確認日 ${fmtDue(t.review)}` };
  if (t.state === 'inbox') {
    const age = daysBetween(t.createdAt);
    if (age >= num(s.inboxStaleDays, 3)) return { kind: 'inbox_stale', severity: 'warning', label: 'Inbox放置', detail: `${age}日間 Inbox のまま` };
  }
  if (t.state === 'waiting' && !t.review) {
    const age = daysBetween(t.updatedAt);
    if (age >= num(s.waitingStaleDays, 7)) return { kind: 'waiting_stale', severity: 'warning', label: 'Waiting長期化', detail: `${age}日間 更新なし・確認日なし` };
  }
  if (t.estimateMin > 0) {
    const act = taskActualSec(t.id) / 60;
    if (act > t.estimateMin * 1.5 && act - t.estimateMin >= 30) return { kind: 'over_estimate', severity: 'warning', label: '見積超過', detail: `見積 ${fmtMin(t.estimateMin)} に対し実績 ${fmtMin(act)}` };
  }
  return null;
}
function getAlerts() {
  const out = [];
  for (const t of store.data.tasks) {
    const a = taskAlert(t);
    if (a) out.push({ ...a, id: 'task:' + t.id, taskId: t.id, title: t.title, projectId: t.projectId });
  }
  for (const p of store.data.projects) {
    if (p.archived) continue;
    const all = store.data.tasks.filter(t => t.projectId === p.id);
    const active = all.filter(t => !t.done);
    if (!all.length) { out.push({ id: 'project:' + p.id, kind: 'project_empty', severity: 'warning', projectId: p.id, title: p.title, label: '次の行動なし', detail: 'Projectにタスクが未登録です' }); continue; }
    if (active.length && !active.some(t => t.state === 'next' || isToday(t)) && !active.every(t => t.state === 'waiting' || t.state === 'later'))
      out.push({ id: 'project:' + p.id, kind: 'project_no_next', severity: 'warning', projectId: p.id, title: p.title, label: 'Nextなし', detail: '未完了はあるが次に着手できるNextがありません' });
  }
  if (store.timer.running && timerElapsedSec() > num(store.settings.longTimerHours, 4) * 3600)
    out.push({ id: 'timer', kind: 'timer_long', severity: 'critical', title: store.timer.levels.filter(Boolean).join(' › '), label: '計測しっぱなし？', detail: `${fmtDur(timerElapsedSec())} 計測中です。止め忘れていませんか` });
  const rank = { critical: 0, warning: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.title.localeCompare(b.title, 'ja'));
}

/* ---------- 記録の取得（予定の見込みを含む） ---------- */
/* 未完了・日付あり・見積ありのタスクは「見込み予定」として、残り見積時間を期日に計上する */
function projectedPlanRecords(from, to) {
  const out = [];
  const today0 = bizDayStart();
  for (const t of store.data.tasks) {
    if (t.done || !t.estimateMin || !t.due) continue;
    const at = parseLocalDateTime(t.due);
    if (Number.isNaN(at) || at < today0 || at < from || at > to) continue;
    const remain = Math.max(0, t.estimateMin * 60 - taskActualSec(t.id));
    if (remain < 60) continue;
    const start = t.due.length > 10 ? at : at + 9 * HOUR_MS;
    out.push({
      id: 'proj_' + t.id, taskId: t.id, levels: levelsForTask(t), tags: tagsForTask(t),
      startedAt: start, endedAt: start + remain * 1000, durationSec: Math.round(remain),
      kind: 'plan', source: 'estimate', note: '見積の残り（自動）'
    });
  }
  return out;
}
function recordsInRange(from, to, { includePlan = false, includeRunning = true } = {}) {
  const list = store.data.records.filter(r => r.startedAt >= from && r.startedAt <= to && (includePlan || r.kind === 'actual'));
  if (includeRunning && store.timer.running && store.timer.startedAt >= from && store.timer.startedAt <= to) {
    list.push({
      id: '__running', taskId: store.timer.taskId, levels: store.timer.taskId ? levelsForTask(getTask(store.timer.taskId)) : store.timer.levels,
      tags: store.timer.tags, startedAt: store.timer.startedAt, endedAt: now(), durationSec: Math.round(timerElapsedSec()),
      kind: 'actual', source: 'running', note: store.timer.note
    });
  }
  if (includePlan) list.push(...projectedPlanRecords(from, to));
  return list;
}

/* ---------- 書き出し・マージ ---------- */
function exportPayload() {
  return {
    app: 'TaskClock', version: APP_VERSION, schema: 1, exportedAt: new Date().toISOString(), deviceId, data: store.data,
    holidays: { list: store.settings.holidays, offWeekdays: store.settings.offWeekdays, updatedAt: num(store.settings.holidaysUpdatedAt) }
  };
}
function cmpVer(a, b, key) {
  const at = num(a?.[key + 'At']), bt = num(b?.[key + 'At']);
  if (at !== bt) return at - bt;
  return String(a?.[key + 'By'] || '').localeCompare(String(b?.[key + 'By'] || ''));
}
function mergeList(local, incoming) {
  const map = new Map(local.map(x => [x.id, x])); let added = 0, updated = 0;
  for (const inc of incoming) {
    const cur = map.get(inc.id);
    if (!cur) { map.set(inc.id, inc); added++; }
    else if (cmpVer(inc, cur, 'updated') > 0) { map.set(inc.id, inc); updated++; }
  }
  return { items: [...map.values()], added, updated };
}
function mergeTombs(local, incoming) {
  const map = new Map(local.map(x => [x.id, x]));
  for (const inc of incoming) { const cur = map.get(inc.id); if (!cur || cmpVer(inc, cur, 'deleted') > 0) map.set(inc.id, inc); }
  return [...map.values()];
}
function applyTombs(items, tombs) {
  const m = new Map(tombs.map(x => [x.id, x]));
  return items.filter(x => { const d = m.get(x.id); return !d || x.updatedAt > d.deletedAt; });
}
/* 取り込みデータを判定し、TaskClock形式へ寄せる */
function parseImport(text, fileName = '') {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const x = JSON.parse(trimmed);
    if (x?.app === 'TaskClock' && x.data) return { kind: 'Task Clock', data: normData(x.data), holidays: x.holidays || null };
    if (Array.isArray(x?.records) && (x.projects || x.tasks)) return { kind: 'Task Clock', data: normData(x) };
    const tf = x?.data && Array.isArray(x.data.tasks) ? x.data : x;
    if (Array.isArray(tf?.tasks) || Array.isArray(tf?.projects)) return { kind: 'Task Flow', data: fromTaskFlow(tf) };
    throw new Error('対応していないJSON形式です');
  }
  const rows = parseCsv(text);
  if (rows[0]?.includes('durationSec')) return { kind: 'Task Time Log CSV', data: fromTimeLogCsv(rows) };
  throw new Error(`Task Clock・Task Flow の JSON、Task Time Log の CSV のいずれでもありません${fileName ? '（' + fileName + '）' : ''}`);
}
function fromTaskFlow(tf) {
  return normData({
    projects: (tf.projects || []).map(p => ({ ...p, tags: [] })),
    tasks: (tf.tasks || []).map(t => ({ ...t, todayDate: '' })),
    deleted: { projects: tf.deletedProjects || [], tasks: tf.deletedTasks || [], records: [] }
  });
}
/* 旧 Task Time Log の CSV（rowType=record）を記録として取り込む */
function fromTimeLogCsv(rows) {
  const h = rows[0], col = name => h.indexOf(name);
  const get = (row, name) => (col(name) >= 0 ? row[col(name)] ?? '' : '');
  const records = [];
  for (const row of rows.slice(1)) {
    const rt = get(row, 'rowType');
    if (rt && rt !== 'record') continue;
    records.push({
      id: get(row, 'id') || undefined,
      taskId: get(row, 'taskId'),
      levels: [1, 2, 3, 4, 5].map(i => get(row, 'level' + i)),
      tags: [1, 2, 3, 4, 5].map(i => get(row, 'tag' + i)),
      durationSec: get(row, 'durationSec'), startedAt: get(row, 'startedAt'), endedAt: get(row, 'endedAt'),
      kind: get(row, 'recordKind'), source: get(row, 'source') || 'import', note: get(row, 'note'),
      createdAt: get(row, 'createdAt'), updatedAt: get(row, 'updatedAt')
    });
  }
  return normData({ records });
}
function mergeData(inc) {
  const d = store.data, res = {};
  const dels = {};
  for (const k of ['projects', 'tasks', 'records']) {
    const before = new Map(d[k].map(x => [x.id, x]));
    dels[k] = mergeTombs(d.deleted[k], inc.deleted[k]);
    d[k] = applyTombs(mergeList(d[k], inc[k]).items, dels[k]);
    d.deleted[k] = dels[k];
    const after = new Set(d[k].map(x => x.id));
    res[k] = {
      added: d[k].filter(x => !before.has(x.id)).length,
      updated: d[k].filter(x => before.has(x.id) && before.get(x.id) !== x).length,
      removed: [...before.keys()].filter(id => !after.has(id)).length
    };
  }
  // 古い削除履歴は180日で整理
  const limit = now() - 180 * DAY_MS;
  for (const k of ['projects', 'tasks', 'records']) d.deleted[k] = d.deleted[k].filter(x => x.deletedAt > limit);
  return res;
}
function clearAllData() {
  store.data = emptyData();
  store.timer = emptyTimer();
  saveTimer();
}
