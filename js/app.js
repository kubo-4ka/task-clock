'use strict';
/* 画面制御 */

const ui = {
  view: 'home',
  taskState: 'inbox',
  editingTaskId: null,
  editingProjectId: null,
  editingRecordId: null,
  recordKind: 'actual',
  projectColor: 0,
  lastStopped: null,   // Space キーで「直前の作業を再開」するため
  installPrompt: null,
  openGroups: null     // 記録画面で開いている月・日の見出し
};

const STATE_HELP = {
  today: '今日やると決めたもの。朝にNextなどから選んで ☆ を付けます。',
  inbox: 'まず捕まえた依頼・思いつき。1日1回、Next / Waiting / Calendar / Later へ振り分けます。',
  next: '自分が次に実行できる具体的な行動。▶ で計測を始められます。',
  waiting: '他人・外部の回答待ち。確認日を入れると当日に知らせます。',
  calendar: '日時が決まっている予定。見積を入れると集計の「予定」に自動で計上され、開始前に通知します。',
  later: '今は着手しない候補。',
  done: '完了したタスク（新しい順）。'
};

/* ================= 共通 ================= */
let toastTimer = null;
function toast(msg, action = null, ms = 4000) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}<button class="toast-x" aria-label="閉じる">×</button>`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.fn(); };
  el.querySelector('.toast-x').onclick = () => { el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 7000) : ms);
}
function projColor(projectId) { const p = getProject(projectId); return p ? `var(--p${p.color})` : 'var(--line)'; }
function applyTheme() {
  const s = store.settings;
  const th = ['light', 'middle', 'dark'].includes(s.theme) ? s.theme : 'middle';
  document.documentElement.dataset.theme = th;
  $('meta[name="theme-color"]').content = { light: '#e9f0f6', middle: '#1f252d', dark: '#111418' }[th];
  document.body.classList.toggle('compact', s.density === 'compact');
  applyNav();
}
function applyNav() {
  const pos = store.settings.navPosition;
  const bottom = pos === 'bottom' || (pos !== 'top' && matchMedia('(max-width: 760px)').matches);
  document.body.classList.toggle('nav-bottom', bottom);
}
function openDlg(id) { const d = $('#' + id); if (!d.open) d.showModal(); }
function closeDlg(id) { const d = $('#' + id); if (d.open) d.close(); }
function stat(label, value, sub = '', cls = '') {
  return `<div class="stat ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;
}

/* ================= 入力の解釈 ================= */
/* 「見積書作成 @A案件 #資料 ~30m !today ^10/10 *毎週」→ タスク属性 */
const REPEAT_WORDS = { daily: 'daily', 毎日: 'daily', weekday: 'weekday', 平日: 'weekday', 勤務日: 'weekday', weekly: 'weekly', 毎週: 'weekly', monthly: 'monthly', 毎月: 'monthly' };
function parseCapture(text) {
  const out = { title: '', projectId: '', tags: [], estimateMin: 0, state: 'inbox', today: false, due: '', repeat: '' };
  const words = [];
  for (const w of nfkc(text).split(/\s+/)) {
    if (!w) continue;
    const low = w.toLowerCase();
    if (w.startsWith('@') && w.length > 1) out.projectId = findOrCreateProject(w.slice(1));
    else if (w.startsWith('#') && w.length > 1) out.tags.push(w.slice(1));
    else if (w.startsWith('~') && parseEstimate(w.slice(1))) out.estimateMin = parseEstimate(w.slice(1));
    else if (w.startsWith('^') && parseDue(w.slice(1))) out.due = parseDue(w.slice(1));
    else if (w.startsWith('*') && REPEAT_WORDS[low.slice(1)]) out.repeat = REPEAT_WORDS[low.slice(1)];
    else if (/^!(today|今日)$/i.test(w)) out.today = true;
    else if (/^!next$/i.test(w)) out.state = 'next';
    else if (/^!(wait|waiting)$/i.test(w)) out.state = 'waiting';
    else if (/^!later$/i.test(w)) out.state = 'later';
    else if (/^!(cal|calendar)$/i.test(w)) out.state = 'calendar';
    else words.push(w);
  }
  out.title = words.join(' ');
  if (out.repeat && !out.due) out.due = todayKey();
  out.tags = uniqTags(out.tags);
  return out;
}
function parseDue(s) {
  const t = now();
  if (/^(today|今日)$/i.test(s)) return todayKey();
  if (/^(tomorrow|明日)$/i.test(s)) return dateKey(addDays(parseDateKey(todayKey()), 1));
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(s))) {
    const y = new Date().getFullYear();
    let d = `${y}-${pad(m[1])}-${pad(m[2])}`;
    if (parseDateKey(d) < dayStart(t) - 60 * DAY_MS) d = `${y + 1}-${pad(m[1])}-${pad(m[2])}`;
    return d;
  }
  return '';
}

/* ================= タイマー ================= */
function startForTask(taskId) {
  if (store.timer.running && store.timer.taskId === taskId) { doStop(); return; }
  if (store.timer.running) stopTimer();
  const t = getTask(taskId);
  startTimer({ taskId });
  reopenDay();
  commit();
  toast(`計測開始: ${t ? t.title : ''}`);
}
function quickStart() {
  if (store.timer.running) stopTimer();
  startTimer({});
  reopenDay();
  commit();
  toast('分類なしで計測を開始しました。あとでタスクを割り当てできます', { label: '今すぐ割当', fn: () => timerMenuAct('assign') });
}
/* 終業後に再び計測を始めたら（夜間の障害対応など）その日の勤務を再開扱いにする */
function reopenDay() { if (store.settings.closedDay === todayKey()) { store.settings.closedDay = ''; saveSettings(); } }
function interrupt() {
  const tm = store.timer;
  const resume = tm.running ? { taskId: tm.taskId, levels: tm.levels, tags: tm.tags.filter(t => t !== INTERRUPT_TAG) } : null;
  if (tm.running) stopTimer();
  startTimer({ levels: normLevels([INTERRUPT_TAG, '割り込み対応']), tags: [INTERRUPT_TAG], resume });
  commit();
  toast('割り込みを計測中。「終了して戻る」で元の作業を再開します', { label: '内容を割当', fn: () => timerMenuAct('assign') });
}
async function doStop({ complete = false } = {}) {
  if (!store.timer.running) return;
  const tm = { ...store.timer };
  let endAt = now();
  if (timerElapsedSec() > num(store.settings.longTimerHours, 4) * 3600) {
    const r = await promptDialog({
      title: '終了時刻の確認',
      text: `${fmtDur(timerElapsedSec())} 計測しています。止め忘れていた場合は実際の終了時刻に直してください。`,
      fields: [{ name: 'date', type: 'date', value: dateKey(endAt) }, { name: 'time', type: 'time', value: toTimeInput(endAt) }],
      ok: 'この時刻で記録'
    });
    if (!r) return;
    const e = new Date(`${r.date}T${r.time}`).getTime();
    if (Number.isFinite(e) && e > tm.startedAt) endAt = Math.min(e, now());
  }
  const res = stopTimer({ endAt });
  let spawned = '';
  if (complete && tm.taskId) spawned = updateTask(tm.taskId, { done: true })?.spawnedId || '';
  ui.lastStopped = { taskId: tm.taskId, levels: tm.levels, tags: tm.tags };
  if (res?.resume) {
    startTimer(res.resume);
    commit();
    toast('割り込みを記録し、元の作業の計測を再開しました', res.rec && !res.rec.taskId ? { label: '割り込みに割当', fn: () => assignRecord(res.rec.id) } : null);
    return;
  }
  commit();
  if (res?.rec && !res.rec.taskId) toast(`${fmtDur(res.rec.durationSec)} を記録（未割当）`, { label: 'タスクを割当', fn: () => assignRecord(res.rec.id) });
  else if (res?.rec) toast(`${fmtDur(res.rec.durationSec)} を記録しました${complete ? '・タスク完了' : ''}${spawned ? `（次回 ${fmtDue(getTask(spawned)?.due)} を作成）` : ''}`);
  else if (res?.tooShort) toast(`${fmtSec(res.minSec)}未満のため記録しませんでした（設定で変更可）`);
}
async function timerMenuAct(act) {
  $('#timerMenu').hidden = true;
  if (!store.timer.running) return;
  if (act === 'assign') {
    pickTask({
      title: '計測中の作業にタスクを割り当て',
      sub: '選んだタスクの Project・分類・タグが記録に入ります',
      onPick: id => {
        const t = getTask(id);
        store.timer.taskId = id;
        store.timer.levels = levelsForTask(t);
        store.timer.tags = uniqTags([...tagsForTask(t), ...store.timer.tags.filter(x => x === INTERRUPT_TAG)]);
        saveTimer(); commit();
      }
    });
  } else if (act === 'note') {
    const r = await promptDialog({ title: 'メモ', fields: [{ name: 'note', value: store.timer.note, placeholder: '例: 〇〇さんから電話' }] });
    if (r) { store.timer.note = r.note; saveTimer(); renderTimerBar(); }
  } else if (act === 'adjust') {
    const r = await promptDialog({ title: '開始時刻を修正', text: 'ボタンを押し忘れた場合に、実際の開始時刻へ戻せます。', fields: [{ name: 'date', type: 'date', value: dateKey(store.timer.startedAt) }, { name: 'time', type: 'time', value: toTimeInput(store.timer.startedAt) }] });
    if (r) {
      const s = new Date(`${r.date}T${r.time}`).getTime();
      if (Number.isFinite(s) && s < now()) { store.timer.startedAt = s; saveTimer(); commit(); }
    }
  } else if (act === 'cancel') {
    if (confirm('この計測を記録せずに破棄しますか？')) { stopTimer({ discard: true }); commit(); toast('計測を取り消しました'); }
  }
}

function renderTimerBar() {
  const tm = store.timer, bar = $('#timerBar');
  const running = tm.running;
  const isInt = running && (tm.resume || (tm.tags.includes(INTERRUPT_TAG) && !tm.taskId));
  bar.classList.toggle('idle', !running);
  bar.classList.toggle('running', running && !isInt);
  bar.classList.toggle('interrupt', !!isInt);
  $('#quickStartBtn').hidden = running;
  $('#interruptBtn').hidden = !running || !!tm.resume;
  $('#stopBtn').hidden = !running;
  $('#stopLbl').textContent = tm.resume ? ' 終了して戻る' : ' 停止';
  $('#stopBtn').title = tm.resume ? '割り込みを記録して元の作業へ戻る' : '停止して記録';
  $('#doneStopBtn').hidden = !running || !tm.taskId;
  $('#timerMenuBtn').hidden = !running;
  if (!running) {
    $('#timerPath').textContent = '計測していません';
    $('#timerSub').textContent = ui.lastStopped ? 'Space で直前の作業を再開 / タスクの ▶ で計測開始' : 'タスクの ▶ で計測開始。分類は自動で入ります';
    $('#timerElapsed').textContent = '';
    document.title = 'Task Clock';
    return;
  }
  const t = tm.taskId ? getTask(tm.taskId) : null;
  const lv = t ? levelsForTask(t) : tm.levels;
  $('#timerPath').textContent = t ? t.title : lv.filter(Boolean).join(' › ');
  const sub = [];
  if (t) sub.push(lv.slice(0, 2).filter(Boolean).join(' › '));
  else sub.push('未割当 — 「…」から後でタスクを割り当てできます');
  sub.push(`${fmtTime(tm.startedAt)}～`);
  if (t?.estimateMin) sub.push(`見積 ${fmtMin(t.estimateMin)} / 累計 ${fmtDur(taskActualSec(t.id))}`);
  if (tm.note) sub.push('📝 ' + tm.note);
  if (tm.resume) sub.push('割り込み中');
  $('#timerSub').textContent = sub.join('　');
  updateElapsed();
}
function updateElapsed() {
  if (!store.timer.running) return;
  const s = timerElapsedSec();
  $('#timerElapsed').textContent = fmtClock(s);
  document.title = `${fmtClock(s)} ${$('#timerPath').textContent} - Task Clock`;
}

/* ================= タスクカード ================= */
function estBar(t) {
  const act = taskActualSec(t.id);
  if (!t.estimateMin) return act > 0 ? `<span class="est-bar">⏱ ${fmtDur(act)}</span>` : '';
  const est = t.estimateMin * 60, over = act > est;
  return `<span class="est-bar ${over ? 'over' : ''}" title="実績 / 見積"><i><b style="width:${Math.min(100, pct(act, est))}%"></b></i>${fmtDur(act)}/${fmtDur(est)}</span>`;
}
function taskCard(t, { stateSelect = false } = {}) {
  const running = store.timer.running && store.timer.taskId === t.id;
  const alert = taskAlert(t);
  const meta = [];
  if (t.projectId) meta.push(`<span class="chip proj" style="--pc:${projColor(t.projectId)}">${esc(projectTitle(t.projectId))}</span>`);
  if (t.category) meta.push(`<span class="chip">${esc(t.category)}</span>`);
  if (!stateSelect) meta.push(`<span class="chip">${STATE_LABELS[t.state]}</span>`);
  t.tags.forEach(x => meta.push(`<span class="chip">#${esc(x)}</span>`));
  if (t.due) meta.push(`<span class="chip ${alert?.kind === 'overdue' ? 'danger' : ''}">${t.state === 'calendar' ? '📅' : '期限'} ${esc(fmtDue(t.due))}${t.repeat ? ' ↻' + REPEAT_LABELS[t.repeat] : ''}</span>`);
  if (t.state === 'waiting' && t.review) meta.push(`<span class="chip ${alert?.kind === 'waiting_review' ? 'danger' : ''}">確認 ${esc(fmtDue(t.review))}</span>`);
  if (alert && !['overdue', 'waiting_review'].includes(alert.kind)) meta.push(`<span class="chip warn">${esc(alert.label)}</span>`);
  meta.push(estBar(t));
  const sel = stateSelect && !t.done ? `<select class="state-select" data-act="state" data-id="${t.id}" title="状態を移動">${STATES.map(s => `<option value="${s}" ${s === t.state ? 'selected' : ''}>${STATE_LABELS[s]}</option>`).join('')}</select>` : '';
  return `<article class="task ${t.done ? 'done' : ''} ${running ? 'running' : ''}" style="--pc:${projColor(t.projectId)}">
    <button class="task-check" data-act="done" data-id="${t.id}" title="${t.done ? '未完了に戻す' : '完了'}">${t.done ? '✓' : ''}</button>
    <div class="task-body" data-act="edit-task" data-id="${t.id}">
      <div class="task-title">${esc(t.title)}</div>
      <div class="task-meta">${meta.join('')}</div>
    </div>
    <div class="task-actions">
      ${sel}
      ${t.done ? '' : `<button class="mini-btn ${isToday(t) ? 'on' : ''}" data-act="today" data-id="${t.id}" title="今日やる">${isToday(t) ? '★' : '☆'}</button>`}
      ${t.done ? '' : `<button class="play ${running ? 'on' : ''}" data-act="play" data-id="${t.id}" title="${running ? '停止' : '計測開始'}">${running ? '■' : '▶'}</button>`}
    </div>
  </article>`;
}
function taskSort(a, b) {
  const da = a.due ? parseLocalDateTime(a.due) : Infinity, db = b.due ? parseLocalDateTime(b.due) : Infinity;
  return (da - db) || (a.createdAt - b.createdAt);
}
/* 完了⇔未完了。Today の印は残すので、元に戻すと Today にも戻る */
function toggleDone(id) {
  const t = getTask(id); if (!t) return;
  if (!t.done && store.timer.running && store.timer.taskId === id) { doStop({ complete: true }); return; }
  if (t.done) { updateTask(id, { done: false }); commit(); return; }
  const spawned = updateTask(id, { done: true })?.spawnedId || '';
  commit();
  toast(`完了: ${t.title}${spawned ? `（次回 ${fmtDue(getTask(spawned)?.due)} を作成）` : ''}`, {
    label: '元に戻す',
    fn: () => {
      updateTask(id, { done: false });
      if (spawned && getTask(spawned)) deleteTask(spawned);
      commit();
    }
  });
}

/* ================= ホーム ================= */
function renderHome() {
  const key = todayKey(), t0 = bizDayStartOfKey(key), t1 = t0 + DAY_MS - 1;
  const recs = recordsInRange(t0, t1, { includePlan: true });
  const actual = recs.filter(r => r.kind === 'actual');
  const actSec = actual.reduce((a, r) => a + r.durationSec, 0);
  const ws = workSession(actual);
  const gaps = sessionGaps(ws);
  const gapSec = gaps.reduce((a, [s, e]) => a + (e - s) / 1000, 0);
  const active = store.data.tasks.filter(t => !t.done);
  const today = active.filter(isToday);
  const doneToday = store.data.tasks.filter(t => t.done && t.doneAt >= t0);
  const alerts = getAlerts();
  const weekFrom = periodRange('week')[0];
  const weekSec = recordsInRange(weekFrom, t1).reduce((a, r) => a + r.durationSec, 0);
  const base = baseSecOf(key), hol = holidayName(key);

  $('#homeStats').innerHTML = [
    stat('今日の実績', fmtDur(actSec), hol ? `休日（${hol}）・すべて休日作業` : `基準 ${fmtDur(base)} ${actSec > base ? `・超過 ${fmtDur(actSec - base)}` : `・残り ${fmtDur(base - actSec)}`}`, (hol && actSec) || actSec > base ? 'warn' : ''),
    stat('未記録のすき間', fmtDur(gapSec), gaps.length ? `${gaps.length}か所 — タイムラインで割当` : ws.start == null ? '本日はまだ記録がありません' : '記録の抜けはありません', gapSec > 1800 ? 'warn' : ''),
    stat('Today', `${today.length}件`, `今日完了 ${doneToday.length}件`),
    stat('要対応', `${alerts.length}件`, alerts.length ? alerts.slice(0, 2).map(a => a.label).join('・') : '詰まりはありません', alerts.some(a => a.severity === 'critical') ? 'danger' : alerts.length ? 'warn' : ''),
    stat('今週の実績', fmtDur(weekSec), `${fmtDay(weekFrom)}～`),
    overtimeStat()
  ].join('');

  // 今日やること：Today＋本日の日時つき予定
  const cal = active.filter(t => !isToday(t) && t.due && t.due.slice(0, 10) === key);
  const carry = active.filter(t => t.today && t.todayDate && t.todayDate < key);
  const list = [...today, ...cal].sort(taskSort);
  $('#todayHint').textContent = list.length ? `見積残り ${fmtMin(list.reduce((a, t) => a + Math.max(0, t.estimateMin - taskActualSec(t.id) / 60), 0))}` : '';
  $('#todayList').innerHTML = (carry.length ? `<div class="empty">前日までの Today に未完了が ${carry.length}件あります <button class="btn small primary" data-act="carry">今日に引き継ぐ</button> <button class="btn small ghost" data-act="carry-clear">外す</button></div>` : '')
    + (list.length ? list.map(t => taskCard(t)).join('') : '<div class="empty">Next などの ☆ で今日やることを選びます</div>')
    + (doneToday.length ? `<details><summary>今日完了 ${doneToday.length}件</summary><div class="task-list">${doneToday.map(t => taskCard(t)).join('')}</div></details>` : '');

  $('#alertList').innerHTML = alerts.length ? alerts.slice(0, 12).map(a => `
    <div class="alert-row ${a.severity}">
      <span class="alert-mark">${a.severity === 'critical' ? '!' : '•'}</span>
      <div><div class="small muted">${esc(a.label)}${a.projectId && a.taskId ? ` ・ ${esc(projectTitle(a.projectId))}` : ''}</div><div class="alert-title">${esc(a.title)}</div><div class="small muted">${esc(a.detail)}</div></div>
      ${a.taskId ? `<button class="btn ghost small" data-act="edit-task" data-id="${a.taskId}">開く</button>` : a.projectId ? `<button class="btn ghost small" data-act="edit-project" data-id="${a.projectId}">開く</button>` : `<button class="btn ghost small" data-act="stop">停止</button>`}
    </div>`).join('') + (alerts.length > 12 ? `<p class="muted small">ほか ${alerts.length - 12}件</p>` : '') : '<div class="empty">詰まりはありません 👍</div>';

  renderTimeline(recs, gaps, ws);
  const next = active.filter(t => t.state === 'next' && !isToday(t)).sort(taskSort);
  $('#nextList').innerHTML = next.length ? next.slice(0, 10).map(t => taskCard(t)).join('') + (next.length > 10 ? `<p class="muted small">ほか ${next.length - 10}件</p>` : '') : '<div class="empty">Next はありません。Inbox を振り分けましょう</div>';
}
/* 今月の基準超過と、このペースで進んだ場合の月末見込み */
function overtimeStat() {
  const [from, to] = periodRange('month');
  const limit = num(store.settings.monthOverLimitHours, 45) * 3600;
  const m = monthOvertime(from, to);
  const sub = limit ? `上限目安 ${fmtDur(limit)}・月末見込み ${fmtDur(m.forecast)}` : `月末見込み ${fmtDur(m.forecast)}`;
  const cls = limit && (m.over >= limit || m.forecast >= limit) ? 'danger' : limit && m.forecast >= limit * 0.8 ? 'warn' : '';
  return stat('今月の基準超過', fmtDur(m.over), sub, cls);
}
function renderTimeline(recs, gaps, ws) {
  const key = todayKey(), d0 = bizDayStartOfKey(key);
  const items = recs.filter(r => r.kind === 'actual' || r.source !== 'estimate');
  const anchor = ws.start ?? (ws.fixed ?? Math.max(d0, now() - 2 * HOUR_MS));
  let from = Math.min(anchor, ...items.map(r => r.startedAt));
  let to = Math.max(now(), from + 9 * HOUR_MS, ...items.map(r => r.endedAt));
  from = Math.max(d0, Math.floor(from / HOUR_MS) * HOUR_MS);
  to = Math.min(d0 + DAY_MS, Math.ceil(to / HOUR_MS) * HOUR_MS);
  const span = to - from, x = t => ((Math.max(from, Math.min(to, t)) - from) / span) * 100;
  const html = [];
  const step = span > 14 * HOUR_MS ? 2 : 1;
  for (let h = from; h < to; h += step * HOUR_MS) html.push(`<span class="tl-tick" style="left:${x(h)}%">${new Date(h).getHours()}</span>`);
  for (const [s, e] of gaps) html.push(`<span class="tl-gap" data-act="gap" data-s="${s}" data-e="${e}" style="left:${x(s)}%;width:${x(e) - x(s)}%" title="未記録 ${fmtTime(s)}–${fmtTime(e)}"></span>`);
  for (const r of items) {
    const title = `${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)} ${r.levels.filter(Boolean).join(' › ')} (${fmtDur(r.durationSec)})`;
    html.push(`<span class="tl-seg ${r.kind}" data-act="${r.id === '__running' ? 'noop' : 'edit-record'}" data-id="${r.id}" style="--pc:${projectColorOf(r)};left:${x(r.startedAt)}%;width:${x(r.endedAt) - x(r.startedAt)}%" title="${esc(title)}"></span>`);
  }
  html.push(`<span class="tl-now" style="left:${x(now())}%"></span>`);
  $('#timeline').innerHTML = html.join('');
  const s = store.settings;
  const startText = ws.start == null ? (s.workStartMode === 'fixed' && isWorkday(key) ? `始業 ${s.workStart} 予定` : '最初の計測で始業') : `始業 ${fmtTime(ws.start)}${ws.fixed != null && ws.start === ws.fixed ? '（設定）' : '（最初の記録）'}`;
  $('#timelineHint').textContent = `${startText}${ws.closed ? '・終業済み' : ''}　${s.gapMinMinutes}分以上の空きを未記録として表示`;
  $('#gapList').innerHTML = gaps.map(([gs, ge]) => `<button class="gap-btn" data-act="gap" data-s="${gs}" data-e="${ge}">未記録 ${fmtTime(gs)}–${fmtTime(ge)}（${fmtDur((ge - gs) / 1000)}）を割当</button>`).join('');
}

/* ================= タスク一覧 ================= */
function renderTasks() {
  const st = ui.taskState, pf = $('#taskProjectFilter').value, q = cmpKey($('#taskSearch').value);
  const all = store.data.tasks;
  const counts = { today: 0, done: 0 };
  STATES.forEach(s => counts[s] = 0);
  for (const t of all) {
    if (t.done) { counts.done++; continue; }
    counts[t.state]++;
    if (isToday(t)) counts.today++;
  }
  $$('#stateFilter button').forEach(b => {
    b.classList.toggle('active', b.dataset.state === st);
    b.querySelector('span').textContent = counts[b.dataset.state] || '';
  });
  $('#stateHelp').textContent = STATE_HELP[st];
  revealActive($('#stateFilter'));
  let list = all.filter(t => st === 'done' ? t.done : st === 'today' ? !t.done && isToday(t) : !t.done && t.state === st);
  if (pf) list = list.filter(t => (pf === '__none' ? !t.projectId : t.projectId === pf));
  if (q) list = list.filter(t => cmpKey([t.title, t.note, t.category, projectTitle(t.projectId), ...t.tags].join(' ')).includes(q));
  list = st === 'done' ? list.sort((a, b) => b.doneAt - a.doneAt).slice(0, 200) : list.sort(taskSort);
  $('#taskList').innerHTML = list.length ? list.map(t => taskCard(t, { stateSelect: true })).join('') : '<div class="empty">該当するタスクはありません</div>';
}
function renderProjectOptions() {
  const cur = $('#taskProjectFilter').value;
  const ps = store.data.projects.filter(p => !p.archived).sort((a, b) => a.title.localeCompare(b.title, 'ja'));
  $('#taskProjectFilter').innerHTML = '<option value="">全Project</option><option value="__none">Projectなし</option>' + ps.map(p => `<option value="${p.id}">${esc(p.title)}</option>`).join('');
  $('#taskProjectFilter').value = cur;
  $('#projectNames').innerHTML = ps.map(p => `<option value="${esc(p.title)}">`).join('');
  const cats = new Set(store.data.tasks.map(t => t.category).filter(Boolean));
  $('#categoryNames').innerHTML = [...cats].map(c => `<option value="${esc(c)}">`).join('');
  const tags = new Map();
  for (const x of [...store.data.tasks, ...store.data.projects]) x.tags.forEach(t => tags.set(cmpKey(t), t));
  for (const r of store.data.records.slice(-2000)) r.tags.forEach(t => tags.set(cmpKey(t), t));
  $('#tagNames').innerHTML = [...tags.values()].map(t => `<option value="${esc(t)}">`).join('');
  const rt = $('#rTag').value;
  $('#rTag').innerHTML = '<option value="">すべて</option>' + [...tags.values()].sort((a, b) => a.localeCompare(b, 'ja')).map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  $('#rTag').value = rt;
}

/* ================= Project ================= */
function renderProjects() {
  const showArc = $('#showArchived').checked;
  const m0 = periodRange('month')[0];
  const monthByTitle = new Map();
  for (const r of store.data.records) if (r.kind === 'actual' && r.startedAt >= m0) monthByTitle.set(r.levels[0], (monthByTitle.get(r.levels[0]) || 0) + r.durationSec);
  const alerts = getAlerts();
  const ps = store.data.projects.filter(p => showArc || !p.archived).sort((a, b) => a.archived - b.archived || a.title.localeCompare(b.title, 'ja'));
  $('#projectList').innerHTML = ps.length ? ps.map(p => {
    const ts = store.data.tasks.filter(t => t.projectId === p.id);
    const active = ts.filter(t => !t.done);
    const total = ts.reduce((a, t) => a + taskActualSec(t.id), 0);
    const est = active.reduce((a, t) => a + t.estimateMin, 0);
    const alert = alerts.find(a => a.projectId === p.id && !a.taskId);
    return `<article class="panel project-card ${p.archived ? 'archived' : ''}" style="--pc:var(--p${p.color})" data-act="edit-project" data-id="${p.id}">
      <h3>${esc(p.title)}</h3>
      <div class="task-meta">${alert ? `<span class="chip warn">${esc(alert.label)}</span>` : ''}${p.tags.map(t => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
      <dl class="kv">
        <dt>未完了</dt><dd>${active.length}件（Next ${active.filter(t => t.state === 'next').length} / Waiting ${active.filter(t => t.state === 'waiting').length}）</dd>
        <dt>今月の実績</dt><dd>${fmtDur(monthByTitle.get(p.title) || 0)}</dd>
        <dt>累計実績</dt><dd>${fmtDur(total)}</dd>
        <dt>残り見積</dt><dd>${est ? fmtMin(est) : '—'}</dd>
      </dl>
    </article>`;
  }).join('') : '<div class="empty">Projectはまだありません。複数の工程がある仕事はProjectにまとめると、時間がProject別に集計されます</div>';
}

/* ================= 記録（年→月→日の折り畳み） ================= */
function renderRecords() {
  const range = $('#recRange').value, kind = $('#recKind').value, onlyUn = $('#recUnassigned').checked, q = cmpKey($('#recSearch').value);
  let from = 0, to = Infinity;
  const d0 = bizDayStartOfKey(todayKey());
  if (range === 'future') from = d0;
  else if (range !== 'all') { from = addDays(d0, -(+range - 1)); to = d0 + DAY_MS - 1; }
  let recs = store.data.records.filter(r => r.startedAt >= from && r.startedAt <= to);
  if (range === 'future') recs = recs.filter(r => r.kind === 'plan');
  if (kind) recs = recs.filter(r => r.kind === kind);
  if (onlyUn) recs = recs.filter(r => !r.taskId);
  if (q) recs = recs.filter(r => cmpKey([...r.levels, ...r.tags, r.note].join(' ')).includes(q));
  recs.sort((a, b) => b.startedAt - a.startedAt);
  if (!recs.length) { $('#recordList').innerHTML = '<div class="empty">記録はありません</div>'; return; }

  // 初期状態：最新の年と月だけ開き、日はすべて閉じる
  const latest = bizDayKey(recs[0].startedAt);
  if (!ui.openGroups) ui.openGroups = new Set(['y:' + latest.slice(0, 4), 'm:' + latest.slice(0, 7)]);
  const tree = new Map(); // 年 → 月 → 日 → 記録
  for (const r of recs) {
    const dk = bizDayKey(r.startedAt), yk = dk.slice(0, 4), mk = dk.slice(0, 7);
    if (!tree.has(yk)) tree.set(yk, new Map());
    const months = tree.get(yk);
    if (!months.has(mk)) months.set(mk, new Map());
    const days = months.get(mk);
    if (!days.has(dk)) days.set(dk, []);
    days.get(dk).push(r);
  }
  const sum = (list, k) => list.filter(r => r.kind === k).reduce((acc, r) => acc + r.durationSec, 0);
  const totals = list => { const x = sum(list, 'actual'), p = sum(list, 'plan'); return `実績 ${fmtDur(x)}${p ? ` / 予定 ${fmtDur(p)}` : ''}`; };
  const isOpen = k => ui.openGroups.has(k);
  const dayHtml = (dk, list) => {
    const hol = holidayName(dk), un = list.filter(r => !r.taskId).length;
    return `<details class="rec-day" data-group="d:${dk}" ${isOpen('d:' + dk) ? 'open' : ''}>
      <summary><strong class="${hol ? 'holiday' : ''}">${fmtDayFull(dk)}${hol && !/曜$/.test(hol) ? ' ' + esc(hol) : ''}</strong><span class="muted small">${list.length}件・${totals(list)}${un ? `・<span class="warn-text">未割当${un}</span>` : ''}</span></summary>
      ${isOpen('d:' + dk) ? list.map(recordRow).join('') : ''}
    </details>`;
  };
  const monthHtml = (mk, days) => `<details class="rec-month" data-group="m:${mk}" ${isOpen('m:' + mk) ? 'open' : ''}>
      <summary><strong>${+mk.slice(5)}月</strong><span class="muted small">${days.size}日・${totals([...days.values()].flat())}</span></summary>
      ${isOpen('m:' + mk) ? [...days.entries()].map(([dk, list]) => dayHtml(dk, list)).join('') : ''}
    </details>`;
  $('#recordList').innerHTML = [...tree.entries()].map(([yk, months]) => {
    const all = [...months.values()].flatMap(m => [...m.values()].flat());
    return `<details class="rec-year" data-group="y:${yk}" ${isOpen('y:' + yk) ? 'open' : ''}>
      <summary><strong>${yk}年</strong><span class="muted small">${months.size}か月・${totals(all)}</span></summary>
      ${isOpen('y:' + yk) ? [...months.entries()].map(([mk, days]) => monthHtml(mk, days)).join('') : ''}
    </details>`;
  }).join('');
}
function recordRow(r) {
  const t = r.taskId ? getTask(r.taskId) : null;
  const lv = r.levels.filter(Boolean);
  const path = t ? `<strong>${esc(t.title)}</strong> <small>${esc(lv.slice(0, 2).join(' › '))}</small>` : `${esc(lv.join(' › ')) || '（未設定）'} <span class="chip warn">未割当</span>`;
  return `<div class="rec ${r.kind}" style="--pc:${projectColorOf(r)}">
    <span class="rec-time">${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}${r.kind === 'plan' ? ' 予定' : ''}</span>
    <span class="rec-dur">${fmtDur(r.durationSec)}</span>
    <span class="rec-path">${path} ${r.tags.map(x => `<span class="chip">#${esc(x)}</span>`).join(' ')} ${r.note ? `<small>📝 ${esc(r.note)}</small>` : ''}</span>
    <span class="rec-actions">
      ${!r.taskId ? `<button class="mini-btn" data-act="assign-record" data-id="${r.id}">割当</button>` : ''}
      <button class="mini-btn" data-act="resume-record" data-id="${r.id}" title="同じ内容で計測開始">▶</button>
      <button class="mini-btn" data-act="edit-record" data-id="${r.id}">編集</button>
      <button class="mini-btn" data-act="dup-record" data-id="${r.id}" title="複製">複製</button>
      <button class="mini-btn" data-act="del-record" data-id="${r.id}" title="削除">削除</button>
    </span>
  </div>`;
}

/* ================= ダイアログ：タスク ================= */
function openTaskDialog(id = null, defaults = {}) {
  ui.editingTaskId = id;
  const t = id ? getTask(id) : normTask({ state: ['done', 'today'].includes(ui.taskState) ? 'inbox' : ui.taskState, ...defaults });
  const f = $('#taskForm');
  f.title.value = id ? t.title : (defaults.title || '');
  f.state.value = t.state;
  f.project.value = projectTitle(t.projectId);
  f.category.value = t.category;
  f.tags.value = t.tags.join(' ');
  f.dueDate.value = t.due.slice(0, 10);
  f.dueTime.value = t.due.length > 10 ? t.due.slice(11, 16) : '';
  f.repeat.value = t.repeat;
  f.estimate.value = estText(t.estimateMin);
  f.review.value = t.review;
  f.today.checked = isToday(t);
  f.note.value = t.note;
  $('#taskDlgTitle').textContent = id ? 'タスクを編集' : 'タスクを追加';
  $('#taskDeleteBtn').hidden = !id;
  toggleTaskFields();
  if (id) {
    const recs = store.data.records.filter(r => r.taskId === id).sort((a, b) => b.startedAt - a.startedAt);
    const total = recs.filter(r => r.kind === 'actual').reduce((a, r) => a + r.durationSec, 0);
    $('#taskDlgRecords').innerHTML = `<h4>このタスクの記録：実績 ${fmtDur(total)}（${recs.length}件）</h4>` +
      recs.slice(0, 8).map(r => `<div class="muted">${fmtDay(r.startedAt)} ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}　${fmtDur(r.durationSec)}${r.kind === 'plan' ? '（予定）' : ''}${r.note ? '　📝' + esc(r.note) : ''}</div>`).join('') +
      `<div class="row-gap" style="margin-top:6px"><button type="button" class="btn ghost small" data-act="add-record-for" data-id="${id}">＋ 記録を手入力</button></div>`;
  } else $('#taskDlgRecords').innerHTML = '';
  openDlg('taskDialog');
  setTimeout(() => f.title.focus(), 30);
}
function toggleTaskFields() {
  const f = $('#taskForm');
  $('[data-review]').hidden = f.state.value !== 'waiting';
  const rep = f.repeat.value;
  $('#repeatHint').textContent = !rep ? '' : !f.dueDate.value ? '繰り返しには期限（開始日）が必要です。'
    : `完了すると次回（${fmtDue(nextOccurrence(f.dueDate.value + (f.dueTime.value ? 'T' + f.dueTime.value : ''), rep))}）を自動作成します。${f.state.value === 'calendar' ? 'Calendarの場合、完了しなくても日付が過ぎれば次回へ送ります。' : ''}`;
}
function saveTaskDialog() {
  const f = $('#taskForm');
  const title = f.title.value.trim();
  if (!title) return false;
  const due = f.dueDate.value ? f.dueDate.value + (f.dueTime.value ? 'T' + f.dueTime.value : '') : '';
  const fields = {
    title, state: f.state.value, projectId: f.project.value.trim() ? findOrCreateProject(f.project.value) : '',
    category: f.category.value.trim(), tags: parseTagText(f.tags.value), due, repeat: due ? f.repeat.value : '', review: f.review.value,
    estimateMin: parseEstimate(f.estimate.value), note: f.note.value, today: f.today.checked
  };
  if (ui.editingTaskId) updateTask(ui.editingTaskId, fields);
  else addTask({ ...fields, todayDate: fields.today ? todayKey() : '' });
  if (store.timer.running && store.timer.taskId === ui.editingTaskId) { store.timer.levels = levelsForTask(getTask(ui.editingTaskId)); saveTimer(); }
  commit();
  return true;
}

/* ================= ダイアログ：Project ================= */
function openProjectDialog(id = null) {
  ui.editingProjectId = id;
  const p = id ? getProject(id) : normProject({ title: '' });
  const f = $('#projectForm');
  f.title.value = id ? p.title : '';
  f.tags.value = p.tags.join(' ');
  f.note.value = p.note;
  f.archived.checked = p.archived;
  ui.projectColor = p.color;
  $('#colorPick').innerHTML = Array.from({ length: 8 }, (_, i) => `<button type="button" data-color="${i}" class="${i === p.color ? 'active' : ''}" style="background:var(--p${i})"></button>`).join('');
  $('#projectDeleteBtn').hidden = !id;
  $('#projectAddTaskBtn').hidden = !id;
  if (id) {
    const ts = store.data.tasks.filter(t => t.projectId === id && !t.done).sort(taskSort);
    $('#projectDlgTasks').innerHTML = `<h4 class="small muted">未完了タスク ${ts.length}件</h4><div class="task-list">${ts.map(t => taskCard(t)).join('') || '<div class="empty">タスクがありません。「＋タスク」で次の行動を追加しましょう</div>'}</div>`;
  } else $('#projectDlgTasks').innerHTML = '';
  openDlg('projectDialog');
}
function saveProjectDialog() {
  const f = $('#projectForm');
  const title = f.title.value.trim();
  if (!title) return false;
  const fields = { title, tags: parseTagText(f.tags.value), note: f.note.value, archived: f.archived.checked, color: ui.projectColor };
  if (ui.editingProjectId) updateProject(ui.editingProjectId, fields);
  else addProject(fields);
  commit();
  return true;
}

/* ================= ダイアログ：記録 ================= */
function openRecordDialog(id = null, defaults = {}) {
  ui.editingRecordId = id;
  const r = id ? store.data.records.find(x => x.id === id) : { kind: 'actual', taskId: '', levels: normLevels([]), tags: [], startedAt: now() - HOUR_MS, endedAt: now(), note: '', ...defaults };
  if (!r) return;
  const f = $('#recordForm');
  ui.recordKind = r.kind;
  $$('#recKindSeg button').forEach(b => b.classList.toggle('active', b.dataset.kind === r.kind));
  const groups = new Map();
  for (const t of store.data.tasks.filter(t => !t.done || t.id === r.taskId).sort((a, b) => projectTitle(a.projectId).localeCompare(projectTitle(b.projectId), 'ja') || a.title.localeCompare(b.title, 'ja'))) {
    const g = projectTitle(t.projectId) || NO_PROJECT;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  $('#recTaskSelect').innerHTML = '<option value="">（未割当：分類を直接入力）</option>' + [...groups.entries()].map(([g, ts]) => `<optgroup label="${esc(g)}">${ts.map(t => `<option value="${t.id}">${esc(t.title)}${t.category ? `（${esc(t.category)}）` : ''}</option>`).join('')}</optgroup>`).join('');
  f.taskId.value = r.taskId;
  $('#recLevels').innerHTML = r.levels.map((v, i) => `<input data-level="${i}" value="${esc(v)}" placeholder="分類${i + 1}" list="${i === 0 ? 'projectNames' : i === 1 ? 'categoryNames' : ''}">`).join('');
  $('#recLevelsBox').open = !r.taskId;
  f.tags.value = r.tags.join(' ');
  f.date.value = dateKey(r.startedAt);
  f.start.value = toTimeInput(r.startedAt);
  f.end.value = toTimeInput(r.endedAt);
  f.note.value = r.note;
  $('#recordDlgTitle').textContent = id ? '記録を編集' : '記録を手入力';
  $('#recordDeleteBtn').hidden = !id;
  updateRecDur();
  openDlg('recordDialog');
}
function recFormTimes() {
  const f = $('#recordForm');
  const s = new Date(`${f.date.value}T${f.start.value}`).getTime();
  let e = new Date(`${f.date.value}T${f.end.value}`).getTime();
  if (e <= s) e += DAY_MS; // 日付をまたぐ
  return [s, e];
}
function updateRecDur() {
  const [s, e] = recFormTimes();
  $('#recDurOut').textContent = Number.isFinite(s) && Number.isFinite(e) ? `= ${fmtMin((e - s) / MIN_MS)}` : '';
}
function saveRecordDialog() {
  const f = $('#recordForm');
  const [s, e] = recFormTimes();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  const taskId = f.taskId.value;
  const t = taskId ? getTask(taskId) : null;
  const levels = t ? levelsForTask(t) : normLevels($$('#recLevels input').map(i => i.value));
  const fields = { taskId, levels, tags: parseTagText(f.tags.value), startedAt: s, endedAt: e, durationSec: Math.round((e - s) / 1000), kind: ui.recordKind, note: f.note.value };
  if (ui.editingRecordId) updateRecord(ui.editingRecordId, fields);
  else addRecord({ ...fields, source: 'manual' });
  commit();
  return true;
}
function assignRecord(recId) {
  const r = store.data.records.find(x => x.id === recId); if (!r) return;
  pickTask({
    title: '記録にタスクを割り当て',
    sub: `${fmtDay(r.startedAt)} ${fmtTime(r.startedAt)}–${fmtTime(r.endedAt)}（${fmtDur(r.durationSec)}）${r.note ? ' 📝' + r.note : ''}`,
    onPick: id => {
      const t = getTask(id);
      updateRecord(recId, { taskId: id, levels: levelsForTask(t), tags: uniqTags([...tagsForTask(t), ...r.tags.filter(x => x === INTERRUPT_TAG)]) });
      commit(); toast(`「${t.title}」に割り当てました`);
    }
  });
}
function fillGap(s, e) {
  pickTask({
    title: '未記録の時間を割り当て',
    sub: `${fmtTime(s)}–${fmtTime(e)}（${fmtDur((e - s) / 1000)}）に何をしていましたか？`,
    extra: { label: '時間を調整して手入力', fn: () => openRecordDialog(null, { startedAt: s, endedAt: e }) },
    onPick: id => {
      const t = getTask(id);
      addRecord({ taskId: id, levels: levelsForTask(t), tags: tagsForTask(t), startedAt: s, endedAt: e, kind: 'actual', source: 'gap' });
      commit(); toast(`${fmtTime(s)}–${fmtTime(e)} を「${t.title}」として記録しました`);
    }
  });
}

/* ================= ダイアログ：タスク選択 ================= */
let pickCtx = null;
function pickTask(ctx) {
  pickCtx = ctx;
  $('#pickTitle').textContent = ctx.title;
  $('#pickSub').innerHTML = esc(ctx.sub || '') + (ctx.extra ? ` <button type="button" class="btn ghost small" id="pickExtra">${esc(ctx.extra.label)}</button>` : '');
  if (ctx.extra) $('#pickExtra').onclick = () => { closeDlg('pickDialog'); ctx.extra.fn(); };
  $('#pickSearch').value = '';
  renderPickList();
  openDlg('pickDialog');
  setTimeout(() => $('#pickSearch').focus(), 30);
}
function renderPickList() {
  const q = $('#pickSearch').value.trim();
  const k = cmpKey(q);
  const active = store.data.tasks.filter(t => !t.done);
  const match = t => !k || cmpKey([t.title, t.category, projectTitle(t.projectId), ...t.tags].join(' ')).includes(k);
  const recentIds = [...new Set(store.data.records.slice().sort((a, b) => b.startedAt - a.startedAt).map(r => r.taskId).filter(Boolean))].slice(0, 8);
  const sections = [
    ['最近の記録', recentIds.map(getTask).filter(t => t && !t.done && match(t))],
    ['Today', active.filter(t => isToday(t) && match(t))],
    ['Next', active.filter(t => t.state === 'next' && !isToday(t) && match(t))],
    ['その他', active.filter(t => t.state !== 'next' && !isToday(t) && match(t))]
  ];
  const seen = new Set();
  const btn = t => `<button type="button" data-pick="${t.id}" style="--pc:${projColor(t.projectId)}">${esc(t.title)}<small>${esc([projectTitle(t.projectId), t.category, STATE_LABELS[t.state]].filter(Boolean).join(' › '))}</small></button>`;
  const newBtn = q ? `<button type="button" class="pick-new" data-pick-new>＋ 新しいタスク「${esc(parseCapture(q).title || q)}」をInboxに作って割り当て<small>@Project #タグ !next も使えます</small></button>` : '';
  let html = '';
  for (const [label, list] of sections) {
    const items = list.filter(t => !seen.has(t.id)).slice(0, label === 'その他' ? 30 : 15);
    items.forEach(t => seen.add(t.id));
    if (items.length) html += `<h4>${label}</h4>` + items.map(btn).join('');
  }
  $('#pickList').innerHTML = (html + newBtn) || '<div class="empty">タスクがありません。上に名前を入力すると新規作成できます</div>';
}
function choosePick(id) {
  closeDlg('pickDialog');
  if (pickCtx?.onPick) pickCtx.onPick(id);
  pickCtx = null;
}

/* ================= 汎用プロンプト ================= */
let promptResolve = null;
function promptDialog({ title, text = '', fields = [], ok = 'OK', alt = null }) {
  $('#promptTitle').textContent = title;
  $('#promptText').innerHTML = esc(text).replace(/\n/g, '<br>');
  $('#promptText').hidden = !text;
  $('#promptFields').innerHTML = fields.map(f => `<label class="field">${esc(f.label || '')}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="off"></label>`).join('');
  $('#promptOk').textContent = ok;
  $('#promptAlt').hidden = !alt;
  if (alt) { $('#promptAlt').textContent = alt.label; $('#promptAlt').onclick = () => { closeDlg('promptDialog'); alt.fn(); }; }
  openDlg('promptDialog');
  const first = $('#promptFields input'); if (first) setTimeout(() => first.focus(), 30);
  return new Promise(res => { promptResolve = res; });
}

/* ================= 描画 ================= */
function renderView() {
  const v = ui.view;
  if (v === 'home') renderHome();
  else if (v === 'tasks') renderTasks();
  else if (v === 'projects') renderProjects();
  else if (v === 'records') renderRecords();
  else if (v === 'report') renderReport();
  else if (v === 'settings') renderSettings();
}
function renderAll() {
  renderTimerBar();
  renderProjectOptions();
  const n = store.data.tasks.filter(t => !t.done && t.state === 'inbox').length;
  $('#tabCountTasks').textContent = n || '';
  $('#syncBadge').hidden = !store.dirty;
  renderView();
}
function setView(v) {
  ui.view = v;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  renderView();
  window.scrollTo({ top: 0 });
}

/* ================= 設定 ================= */
function renderSettings() {
  const s = store.settings;
  const set = (id, v) => { const el = $(id); if (el.type === 'checkbox') el.checked = !!v; else el.value = v; };
  set('#setTheme', s.theme); set('#setDensity', s.density); set('#setNav', s.navPosition); set('#setClock', s.clockEnabled !== false);
  set('#setBase', hhmmFromMinutes(num(s.baseMinutes, 480))); set('#setBoundary', s.dayBoundary); set('#setStartMode', s.workStartMode);
  set('#setWorkStart', s.workStart); set('#setGap', s.gapMinMinutes); set('#setMinSec', s.minRecordSec); set('#setLong', s.longTimerHours);
  set('#setOverLimit', s.monthOverLimitHours); set('#setSessionIdle', s.sessionIdleHours);
  $('#setOffWeekdays').innerHTML = '<span class="muted small">休みの曜日</span>' + WEEKDAYS.map((w, i) => `<label class="check"><input type="checkbox" data-wd="${i}" ${(s.offWeekdays || []).includes(i) ? 'checked' : ''}>${w}</label>`).join('');
  renderHolidays();
  set('#setOsNotify', s.osNotify); set('#setOsAlways', s.osNotifyAlways);
  set('#setIdleMin', s.idleNotifyMin); set('#setRunMin', s.runNotifyMin); set('#setRemind', s.remindBeforeMin);
  set('#setAlert', s.alertEnabled); set('#setAlertInterval', String(s.alertIntervalMinutes)); set('#setInbox', s.inboxStaleDays); set('#setWaiting', s.waitingStaleDays);
  set('#setSyncPath', s.syncPathNote); set('#setAutoExport', s.autoExport); set('#setCloseWarn', s.closeWarn);
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  $('#notifyPerm').textContent = { granted: '許可済み', denied: 'ブロック中（ブラウザ設定で許可）', default: '未許可', unsupported: '非対応' }[perm];
  $('#notifyPerm').className = 'chip ' + (perm === 'granted' ? 'ok' : perm === 'denied' ? 'danger' : '');
  $('#syncStatus').innerHTML = syncStatusChips() + `<span class="chip">タスク ${store.data.tasks.length} / Project ${store.data.projects.length} / 記録 ${store.data.records.length}</span>`;
  const standalone = matchMedia('(display-mode: standalone)').matches;
  $('#installInfo').textContent = standalone ? 'アプリとして起動中です。' : location.protocol === 'file:' ? 'ファイルを直接開いています。インストール・OS通知・フォルダ連携を使うには tools/start_app.bat か https の公開先から開いてください。' : 'ブラウザのメニュー（またはヘッダーの「インストール」）からアプリとしてインストールできます。';
}
/* ================= 休日カレンダー ================= */
const holUi = { month: 0, year: 0, editing: '', work: false };
function renderHolidays() {
  if (!holUi.month) holUi.month = monthStart(parseDateKey(todayKey()));
  const m0 = holUi.month, d0 = new Date(m0);
  const y = d0.getFullYear(), mo = d0.getMonth();
  $('#holMonth').textContent = `${y}年${mo + 1}月`;
  const map = customHolidayMap(), off = store.settings.offWeekdays || [], today = todayKey();
  const cells = WEEKDAYS.map((w, i) => `<div class="hol-dow ${i === 0 || i === 6 ? 'we' : ''}">${w}</div>`);
  for (let i = 0; i < d0.getDay(); i++) cells.push('<div></div>');
  const last = new Date(y, mo + 1, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const k = `${y}-${pad(mo + 1)}-${pad(d)}`, h = map.get(k), wd = new Date(y, mo, d).getDay();
    const cls = ['hol-day', h ? (h.work ? 'work' : 'hol') : off.includes(wd) ? 'off' : '', k === today ? 'today' : ''].join(' ');
    cells.push(`<button type="button" class="${cls}" data-hol="${k}" title="${esc(h ? h.name : off.includes(wd) ? '休みの曜日' : 'クリックで休日を登録')}"><b>${d}</b>${h ? `<small>${esc(h.name)}</small>` : ''}</button>`);
  }
  $('#holGrid').innerHTML = cells.join('');
  $('#holNationalBtn').textContent = `＋ ${y}年の祝日をまとめて追加`;

  // 一覧（年ごと）
  const years = [...new Set([y, new Date().getFullYear(), ...store.settings.holidays.map(h => +h.date.slice(0, 4))])].sort();
  if (!holUi.year || !years.includes(holUi.year)) holUi.year = y;
  $('#holYear').innerHTML = years.map(v => `<option value="${v}" ${v === holUi.year ? 'selected' : ''}>${v}年（${store.settings.holidays.filter(h => h.date.startsWith(v + '-')).length}件）</option>`).join('');
  const list = store.settings.holidays.filter(h => h.date.startsWith(holUi.year + '-'));
  $('#holListSummary').textContent = `登録一覧（全${store.settings.holidays.length}件）`;
  $('#holList').innerHTML = list.length ? list.map(h => `<div class="hol-row ${h.work ? 'work' : ''}">
      <span class="d">${fmtDayFull(h.date)}</span><span class="n">${esc(h.name)}${h.work ? ' <span class="chip">出勤日</span>' : ''}</span>
      <span class="row-gap"><button type="button" class="mini-btn" data-hol-edit="${h.date}">編集</button><button type="button" class="mini-btn" data-hol-del="${h.date}">削除</button></span>
    </div>`).join('') : '<div class="empty">この年の登録はありません</div>';
  renderHolidayPreview();
}
function openHolidayDialog(date) {
  const h = customHolidayMap().get(date);
  holUi.editing = h ? date : '';
  holUi.work = h ? h.work : false;
  const f = $('#holForm');
  f.date.value = date || '';
  f.name.value = h ? h.name : (date ? jpHolidays(+date.slice(0, 4)).get(date) || '' : '');
  $$('#holKind button').forEach(b => b.classList.toggle('active', (b.dataset.work === '1') === holUi.work));
  $('#holDlgTitle').textContent = h ? '休日を編集' : '休日を登録';
  $('#holDeleteBtn').hidden = !h;
  const wd = date ? new Date(parseDateKey(date)).getDay() : -1;
  $('#holDlgNote').textContent = date && (store.settings.offWeekdays || []).includes(wd) && !h ? 'この曜日は休みの曜日です。出勤する場合は「出勤日」を選んでください。' : '';
  openDlg('holDialog');
  setTimeout(() => (date ? f.name : f.date).focus(), 30);
}
function renderHolidayPreview() {
  const list = [];
  let d = parseDateKey(todayKey());
  for (let i = 0; i < 120 && list.length < 8; i++, d = addDays(d, 1)) {
    const k = dateKey(d), n = holidayName(k);
    if (n && !/曜$/.test(n)) list.push(`${fmtDay(k)} ${n}`);
  }
  const nextYear = new Date().getFullYear() + 1;
  const missingNext = new Date().getMonth() >= 9 && !Object.keys(Object.fromEntries(customHolidayMap())).some(k => k.startsWith(nextYear + '-'));
  $('#holidayPreview').textContent = (list.length ? '今後の休日: ' + list.join(' / ') : '今後120日に祝日・休日の登録はありません')
    + (missingNext ? `　※${nextYear}年の祝日がまだ登録されていません` : '');
}
function bindSettings() {
  const s = store.settings;
  const on = (id, ev, fn) => $(id).addEventListener(ev, e => { fn(e.target); saveSettings(); renderAll(); });
  on('#setTheme', 'change', el => { s.theme = el.value; applyTheme(); });
  on('#setDensity', 'change', el => { s.density = el.value; applyTheme(); });
  on('#setNav', 'change', el => { s.navPosition = el.value; applyNav(); });
  on('#setClock', 'change', el => { s.clockEnabled = el.checked; tickClock(); });
  on('#setBase', 'change', el => { s.baseMinutes = minutesFromHHMM(el.value, 480); });
  on('#setBoundary', 'change', el => { s.dayBoundary = el.value || '00:00'; });
  on('#setStartMode', 'change', el => { s.workStartMode = el.value; });
  on('#setWorkStart', 'change', el => { s.workStart = el.value || '09:00'; });
  on('#setGap', 'change', el => { s.gapMinMinutes = Math.max(1, num(el.value, 10)); });
  on('#setMinSec', 'change', el => { s.minRecordSec = Math.max(0, Math.round(num(el.value, 30))); });
  on('#setLong', 'change', el => { s.longTimerHours = Math.max(1, num(el.value, 4)); });
  $('#setOffWeekdays').addEventListener('change', () => {
    s.offWeekdays = $$('#setOffWeekdays input:checked').map(i => +i.dataset.wd); s.holidaysUpdatedAt = now(); saveSettings(); renderHolidays();
  });
  // 休日カレンダー
  const moveMonth = n => { const d = new Date(holUi.month); holUi.month = new Date(d.getFullYear(), d.getMonth() + n, 1).getTime(); holUi.year = new Date(holUi.month).getFullYear(); renderHolidays(); };
  $('#holPrev').onclick = () => moveMonth(-1);
  $('#holNext').onclick = () => moveMonth(1);
  $('#holToday').onclick = () => { holUi.month = 0; holUi.year = 0; renderHolidays(); };
  $('#holGrid').addEventListener('click', e => { const b = e.target.closest('[data-hol]'); if (b) openHolidayDialog(b.dataset.hol); });
  $('#holAddBtn').onclick = () => openHolidayDialog('');
  $('#holNationalBtn').onclick = () => {
    const y = new Date(holUi.month).getFullYear();
    const n = addNationalHolidays(y); renderAll();
    toast(n ? `${y}年の祝日を ${n}件 追加しました（登録済みの日はそのまま）` : `${y}年の祝日はすべて登録済みです`);
  };
  $('#holYear').onchange = e => { holUi.year = +e.target.value; renderHolidays(); };
  $('#holList').addEventListener('click', e => {
    const ed = e.target.closest('[data-hol-edit]'), del = e.target.closest('[data-hol-del]');
    if (ed) openHolidayDialog(ed.dataset.holEdit);
    if (del) {
      const h = customHolidayMap().get(del.dataset.holDel);
      removeHoliday(h.date); renderAll();
      toast(`${fmtDay(h.date)} ${h.name} を削除しました`, { label: '元に戻す', fn: () => { upsertHoliday(h); renderAll(); } });
    }
  });
  $('#holClearYear').onclick = () => {
    const y = holUi.year, n = store.settings.holidays.filter(h => h.date.startsWith(y + '-')).length;
    if (!n || !confirm(`${y}年の登録 ${n}件 をすべて削除しますか？`)) return;
    const before = store.settings.holidays.slice();
    setHolidays(before.filter(h => !h.date.startsWith(y + '-'))); renderAll();
    toast(`${y}年の登録を削除しました`, { label: '元に戻す', fn: () => { setHolidays(before); renderAll(); } });
  };
  $('#holKind').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; holUi.work = b.dataset.work === '1'; $$('#holKind button').forEach(x => x.classList.toggle('active', x === b)); });
  $('#holForm').addEventListener('submit', e => {
    const f = $('#holForm');
    if (!f.date.value) { e.preventDefault(); return; }
    upsertHoliday({ date: f.date.value, name: f.name.value, work: holUi.work }, holUi.editing);
    holUi.month = monthStart(parseDateKey(f.date.value));
    renderAll(); toast(`${fmtDay(f.date.value)} を登録しました`);
  });
  $('#holDeleteBtn').onclick = () => { if (holUi.editing) { removeHoliday(holUi.editing); closeDlg('holDialog'); renderAll(); toast('削除しました'); } };
  on('#setSessionIdle', 'change', el => { s.sessionIdleHours = Math.min(12, Math.max(1, num(el.value, 3))); });
  on('#setOverLimit', 'change', el => { s.monthOverLimitHours = Math.max(0, num(el.value, 45)); });
  on('#setOsAlways', 'change', el => { s.osNotifyAlways = el.checked; });
  on('#setIdleMin', 'change', el => { s.idleNotifyMin = Math.max(0, num(el.value, 30)); });
  on('#setRunMin', 'change', el => { s.runNotifyMin = Math.max(0, num(el.value, 30)); });
  on('#setRemind', 'change', el => { s.remindBeforeMin = Math.max(0, num(el.value, 15)); });
  on('#setAlert', 'change', el => { s.alertEnabled = el.checked; });
  on('#setAlertInterval', 'change', el => { s.alertIntervalMinutes = num(el.value, 120); });
  on('#setInbox', 'change', el => { s.inboxStaleDays = Math.max(1, num(el.value, 3)); });
  on('#setWaiting', 'change', el => { s.waitingStaleDays = Math.max(1, num(el.value, 7)); });
  on('#setSyncPath', 'change', el => { s.syncPathNote = el.value.trim(); });
  on('#setAutoExport', 'change', el => { s.autoExport = el.checked; });
  on('#setCloseWarn', 'change', el => { s.closeWarn = el.checked; });
  $('#setOsNotify').addEventListener('change', async e => {
    if (e.target.checked) {
      if (!('Notification' in window)) { e.target.checked = false; toast('このブラウザはOS通知に対応していません'); }
      else if (Notification.permission !== 'granted') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { e.target.checked = false; toast('通知が許可されませんでした。ブラウザのサイト設定で許可してください'); }
      }
    }
    s.osNotify = e.target.checked; saveSettings(); renderSettings();
  });
  $('#testAlarmBtn').onclick = async () => {
    toast('テスト通知（画面内）');
    if (!store.settings.osNotify) { toast('画面内のテスト通知です。OS通知を試すには「OSの通知を使う」をオンにしてください'); return; }
    const always = store.settings.osNotifyAlways;
    store.settings.osNotifyAlways = true; // テストは画面を見ていてもOS通知を出す
    await osNotify('Task Clock：テスト通知', 'OSの通知が届いています', 'test');
    store.settings.osNotifyAlways = always;
  };
  const msg = (t, type = '') => { const el = $('#syncMessage'); el.textContent = t; el.className = 'sync-message ' + type; };
  $('#exportBtn').onclick = async () => { try { msg(await exportNow(), 'success'); renderAll(); } catch (e) { msg('エクスポート失敗: ' + e.message, 'error'); } };
  $('#chooseDirBtn').onclick = async () => { try { msg(`共有フォルダ「${await chooseSyncDir()}」を設定しました。フルパスを上の欄にメモしておくと確認しやすくなります`, 'success'); renderSettings(); } catch (e) { if (e.name !== 'AbortError') msg(e.message, 'error'); } };
  $('#mergeLatestBtn').onclick = async () => { try { msg(await mergeLatestFromDir(), 'success'); } catch (e) { msg(e.message, 'error'); } };
  $('#importFile').onchange = async e => {
    const out = [];
    for (const file of e.target.files) {
      try { out.push(mergeText(await readFileText(file), file.name)); } catch (err) { out.push(`${file.name}: 失敗 ${err.message}`); }
    }
    e.target.value = '';
    msg(out.join('\n'), out.some(x => x.includes('失敗')) ? 'error' : 'success');
  };
  $('#pasteImportBtn').onclick = () => { $('#pasteText').value = ''; $('#pasteInfo').textContent = ''; openDlg('pasteDialog'); setTimeout(() => $('#pasteText').focus(), 30); };
  $('#pasteFromClipboard').onclick = async () => {
    try { $('#pasteText').value = await navigator.clipboard.readText(); updatePasteInfo(); }
    catch { $('#pasteInfo').textContent = '読み込めませんでした。欄を長押しして「貼り付け」してください'; }
  };
  $('#pasteText').addEventListener('input', updatePasteInfo);
  $('#pasteForm').addEventListener('submit', e => {
    const text = $('#pasteText').value.trim();
    if (!text) { e.preventDefault(); $('#pasteInfo').textContent = 'テキストが空です'; return; }
    try { msg(mergeText(text, '貼り付けたテキスト'), 'success'); toast('マージしました'); }
    catch (err) { e.preventDefault(); $('#pasteInfo').textContent = '読み込めませんでした: ' + err.message; }
  });
  $('#clearAllBtn').onclick = async () => {
    if (!confirm('タスク・Project・記録をすべて消去します。元に戻せません。続けますか？')) return;
    const r = await promptDialog({ title: '最終確認', text: '確認のため「消去」と入力してください。', fields: [{ name: 'word', placeholder: '消去' }], ok: '消去する' });
    if (!r || r.word !== '消去') { toast('消去を中止しました'); return; }
    clearAllData(); commit(); toast('全データを消去しました');
  };
}

function updatePasteInfo() {
  const t = $('#pasteText').value.trim();
  if (!t) { $('#pasteInfo').textContent = ''; return; }
  try { const p = parseImport(t); $('#pasteInfo').textContent = `${p.kind}：タスク ${p.data.tasks.length} / Project ${p.data.projects.length} / 記録 ${p.data.records.length}`; }
  catch (e) { $('#pasteInfo').textContent = '形式を判別できません（' + e.message + '）'; }
}

/* ================= 始業・終業 ================= */
async function startOfDay() {
  const s = store.settings;
  if (s.lastStartPromptDate === todayKey()) return;
  s.lastStartPromptDate = todayKey(); saveSettings();
  if (!syncDir) return;
  const r = await promptDialog({ title: '作業開始', text: `共有フォルダ「${syncDir.name}」の最新データをマージしてから始めますか？\n（他のPCで作業した内容を取り込みます）`, ok: 'マージする' });
  if (r) { try { toast(await mergeLatestFromDir()); } catch (e) { toast('マージ失敗: ' + e.message); } }
}
async function endOfDay() {
  const ws = workSession();
  const sec = ws.list.reduce((a, r) => a + r.durationSec, 0);
  const gaps = sessionGaps(ws);
  const un = ws.list.filter(r => !r.taskId && r.id !== '__running').length;
  const lines = [`今日の実績: ${fmtDur(sec)}`];
  if (store.timer.running) lines.push('⚠ まだ計測中です（停止してから終業します）');
  if (gaps.length) lines.push(`未記録のすき間: ${gaps.length}か所（${fmtDur(gaps.reduce((a, [s, e]) => a + (e - s) / 1000, 0))}）`);
  if (un) lines.push(`タスク未割当の記録: ${un}件`);
  lines.push(store.dirty ? '未エクスポートの変更があります。' : 'エクスポート済みです。');
  lines.push('終業すると、今日はこれ以降「計測なし」の通知や未記録の検出をしません（再び計測すると再開）。');
  const r = await promptDialog({ title: '作業終了', text: lines.join('\n'), ok: store.dirty ? '終業してエクスポート' : '終業する', alt: gaps.length || un ? { label: '先に記録を整える', fn: () => setView(gaps.length ? 'home' : 'records') } : null });
  if (!r) return;
  if (store.timer.running) await doStop();
  store.settings.closedDay = todayKey(); saveSettings();
  if (store.dirty) { try { toast(await exportNow()); } catch (e) { toast('エクスポート失敗: ' + e.message); } }
  else toast('お疲れさまでした');
  renderAll();
}

/* ================= 時計 ================= */
function tickClock() {
  const el = $('#headerClock');
  el.hidden = store.settings.clockEnabled === false;
  const d = new Date();
  el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ================= イベント ================= */
function bindEvents() {
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
  $('#quickStartBtn').onclick = quickStart;
  $('#interruptBtn').onclick = interrupt;
  $('#stopBtn').onclick = () => doStop();
  $('#doneStopBtn').onclick = () => doStop({ complete: true });
  $('#timerMenuBtn').onclick = e => { e.stopPropagation(); $('#timerMenu').hidden = !$('#timerMenu').hidden; };
  $('#timerMenu').addEventListener('click', e => { const b = e.target.closest('[data-timer-act]'); if (b) timerMenuAct(b.dataset.timerAct); });
  document.addEventListener('click', e => { if (!e.target.closest('#timerMenu')) $('#timerMenu').hidden = true; });
  $('#endDayBtn').onclick = endOfDay;

  $$('[data-capture]').forEach(form => form.addEventListener('submit', e => {
    e.preventDefault();
    const text = form.q.value.trim(); if (!text) return;
    const c = parseCapture(text);
    if (!c.title) { toast('タスク名を入力してください'); return; }
    const t = addTask({ ...c, todayDate: c.today ? todayKey() : '' });
    commit();
    form.q.value = '';
    toast(`${STATE_LABELS[t.state]}${t.today ? '・Today' : ''} に追加: ${t.title}`, { label: '▶ すぐ計測', fn: () => startForTask(t.id) });
  }));

  // 委譲：data-act
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'SELECT') return;
    const id = el.dataset.id, act = el.dataset.act;
    switch (act) {
      case 'play': startForTask(id); break;
      case 'stop': doStop(); break;
      case 'done': toggleDone(id); break;
      case 'today': { const t = getTask(id); updateTask(id, { today: !isToday(t) }); commit(); break; }
      case 'edit-task': closeDlg('projectDialog'); openTaskDialog(id); break;
      case 'edit-project': openProjectDialog(id); break;
      case 'edit-record': if (id && id !== '__running') openRecordDialog(id); break;
      case 'assign-record': assignRecord(id); break;
      case 'resume-record': {
        const r = store.data.records.find(x => x.id === id); if (!r) break;
        if (r.taskId && getTask(r.taskId)) startForTask(r.taskId);
        else { if (store.timer.running) stopTimer(); startTimer({ levels: r.levels, tags: r.tags }); commit(); toast('同じ分類で計測開始'); }
        break;
      }
      case 'dup-record': {
        const r = store.data.records.find(x => x.id === id); if (!r) break;
        openRecordDialog(null, { ...r });
        break;
      }
      case 'del-record': {
        const r = store.data.records.find(x => x.id === id); if (!r) break;
        deleteRecord(id); commit();
        toast('記録を削除しました', { label: '元に戻す', fn: () => { store.data.deleted.records = store.data.deleted.records.filter(x => x.id !== id); store.data.records.push(touch(r)); commit(); } });
        break;
      }
      case 'gap': fillGap(+el.dataset.s, +el.dataset.e); break;
      case 'end-day': endOfDay(); break;
      case 'carry': store.data.tasks.filter(t => !t.done && t.today && t.todayDate < todayKey()).forEach(t => updateTask(t.id, { today: true })); commit(); break;
      case 'carry-clear': store.data.tasks.filter(t => !t.done && t.today && t.todayDate < todayKey()).forEach(t => updateTask(t.id, { today: false })); commit(); break;
      case 'add-record-for': closeDlg('taskDialog'); openRecordDialog(null, { taskId: id, levels: levelsForTask(getTask(id)), tags: tagsForTask(getTask(id)) }); break;
    }
  });
  document.addEventListener('change', e => {
    const el = e.target.closest('select[data-act="state"]'); if (!el) return;
    updateTask(el.dataset.id, { state: el.value }); commit();
    toast(`${STATE_LABELS[el.value]} へ移動しました`);
  });
  $$('[data-goto]').forEach(b => b.onclick = () => { if (b.dataset.state) ui.taskState = b.dataset.state; setView(b.dataset.goto); });

  // タスク
  $('#stateFilter').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { ui.taskState = b.dataset.state; renderTasks(); } });
  $('#taskProjectFilter').onchange = renderTasks;
  $('#taskSearch').oninput = renderTasks;
  ['state', 'repeat', 'dueDate', 'dueTime'].forEach(n => $('#taskForm')[n].addEventListener('change', toggleTaskFields));
  $('[data-est]').addEventListener('click', e => { const b = e.target.closest('button'); if (b) $('#taskForm').estimate.value = estText(+b.dataset.v); });
  $('#taskForm').addEventListener('submit', e => { if (!saveTaskDialog()) e.preventDefault(); });
  $('#taskDeleteBtn').onclick = () => {
    const t = getTask(ui.editingTaskId); if (!t) return;
    if (!confirm(`「${t.title}」を削除しますか？（記録の時間は残ります）`)) return;
    deleteTask(t.id); commit(); closeDlg('taskDialog');
  };

  // Project
  $('#addProjectBtn').onclick = () => openProjectDialog();
  $('#showArchived').onchange = renderProjects;
  $('#colorPick').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ui.projectColor = +b.dataset.color; $$('#colorPick button').forEach(x => x.classList.toggle('active', x === b)); });
  $('#projectForm').addEventListener('submit', e => { if (!saveProjectDialog()) e.preventDefault(); });
  $('#projectDeleteBtn').onclick = () => {
    const p = getProject(ui.editingProjectId); if (!p) return;
    if (!confirm(`Project「${p.title}」を削除しますか？（タスクと記録は残り、Projectなしになります）`)) return;
    deleteProject(p.id); commit(); closeDlg('projectDialog');
  };
  $('#projectAddTaskBtn').onclick = () => { const pid = ui.editingProjectId; closeDlg('projectDialog'); openTaskDialog(null, { projectId: pid, state: 'next' }); };

  // 記録
  $('#addRecordBtn').onclick = () => openRecordDialog();
  ['#recRange', '#recKind', '#recUnassigned'].forEach(s => $(s).onchange = () => { ui.openGroups = null; renderRecords(); });
  $('#recSearch').oninput = renderRecords;
  $('#recordList').addEventListener('toggle', e => {
    const d = e.target.closest('details[data-group]'); if (!d) return;
    const key = d.dataset.group, was = ui.openGroups.has(key);
    if (d.open === was) return;
    d.open ? ui.openGroups.add(key) : ui.openGroups.delete(key);
    renderRecords();
  }, true);
  $('#recOpenAll').onclick = () => {
    const keys = new Set();
    $$('#recordList details[data-group]').forEach(d => keys.add(d.dataset.group));
    store.data.records.forEach(r => { const dk = bizDayKey(r.startedAt); keys.add('y:' + dk.slice(0, 4)); keys.add('m:' + dk.slice(0, 7)); keys.add('d:' + dk); });
    ui.openGroups = keys; renderRecords();
  };
  $('#recCloseAll').onclick = () => { ui.openGroups = new Set(); renderRecords(); };
  $('#recKindSeg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; ui.recordKind = b.dataset.kind; $$('#recKindSeg button').forEach(x => x.classList.toggle('active', x === b)); });
  $('#recTaskSelect').onchange = e => {
    const t = getTask(e.target.value);
    $('#recLevelsBox').open = !t;
    if (t) { $('#recordForm').tags.value = tagsForTask(t).join(' '); levelsForTask(t).forEach((v, i) => { $$('#recLevels input')[i].value = v; }); }
  };
  ['date', 'start', 'end'].forEach(n => $('#recordForm')[n].addEventListener('input', updateRecDur));
  $('#recDurChips').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const [s] = recFormTimes(); if (!Number.isFinite(s)) return;
    $('#recordForm').end.value = toTimeInput(s + (+b.dataset.v) * MIN_MS); updateRecDur();
  });
  $('#recordForm').addEventListener('submit', e => { if (!saveRecordDialog()) e.preventDefault(); });
  $('#recordDeleteBtn').onclick = () => { if (confirm('この記録を削除しますか？')) { deleteRecord(ui.editingRecordId); commit(); closeDlg('recordDialog'); } };
  $('#bulkEditBtn').onclick = openBulk;
  $('#bulkField').onchange = renderBulkFrom;
  $('#bulkForm').addEventListener('submit', applyBulk);

  // 選択
  $('#pickSearch').oninput = renderPickList;
  $('#pickSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    ($('#pickList [data-pick]') || $('#pickList [data-pick-new]'))?.click();
  });
  $('#pickList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-pick-new')) {
      const c = parseCapture($('#pickSearch').value);
      const t = addTask({ ...c, title: c.title || $('#pickSearch').value.trim(), todayDate: c.today ? todayKey() : '' });
      choosePick(t.id);
    } else choosePick(b.dataset.pick);
  });

  // プロンプト
  $('#promptForm').addEventListener('submit', () => {
    const data = {}; $$('#promptFields input').forEach(i => { data[i.name] = i.value; });
    const r = promptResolve; promptResolve = null; r?.(data);
  });
  $('#promptDialog').addEventListener('close', () => { if (promptResolve) { const r = promptResolve; promptResolve = null; r(null); } });

  // 閉じるボタン共通
  document.addEventListener('click', e => { if (e.target.closest('[data-close]')) e.target.closest('dialog').close(); });
  $$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

  // 集計
  $('#rPeriod').onchange = () => {
    report.period = $('#rPeriod').value;
    $('#customRange').hidden = report.period !== 'custom';
    if (report.period === 'next30') $('#rScope').value = 'all';
    if (report.period === 'custom' && !$('#rFrom').value) { $('#rFrom').value = dateKey(monthStart()); $('#rTo').value = todayKey(); }
    report.from = $('#rFrom').value; report.to = $('#rTo').value;
    renderReport();
  };
  ['#rFrom', '#rTo'].forEach(s => $(s).onchange = () => { report.from = $('#rFrom').value; report.to = $('#rTo').value; renderReport(); });
  ['#rScope', '#rAxis', '#rTag', '#rUnit'].forEach(s => $(s).onchange = () => { renderReport(); saveSettings(); });
  $('#copyReportBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('#reportText').textContent); toast('コピーしました'); }
    catch { const r = document.createRange(); r.selectNodeContents($('#reportText')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('選択しました。Ctrl+C でコピーしてください'); }
  };
  $('#csvReportBtn').onclick = exportRecordsCsv;

  bindSettings();
  const OPEN_KEY = 'taskClock.ui.openSettings';
  const opened = new Set(readJSON(localStorage.getItem(OPEN_KEY)) || []);
  $$('.set-panel').forEach(d => {
    d.open = opened.has(d.dataset.key);
    d.addEventListener('toggle', () => {
      d.open ? opened.add(d.dataset.key) : opened.delete(d.dataset.key);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...opened])); } catch { /* 保存できなくても動作に支障なし */ }
    });
  });

  // キーボード
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'N') {
      if (ui.view !== 'home' && ui.view !== 'tasks') setView('home');
      e.preventDefault(); $(`#view-${ui.view} [data-capture] input`).focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (store.timer.running) doStop();
      else if (ui.lastStopped) {
        const l = ui.lastStopped;
        if (l.taskId && getTask(l.taskId)) startForTask(l.taskId);
        else { startTimer({ levels: l.levels, tags: l.tags }); commit(); }
      }
    } else if (/^[1-6]$/.test(e.key)) setView(['home', 'tasks', 'projects', 'records', 'report', 'settings'][+e.key - 1]);
  });

  // ヘッダー高さ（張り付くフィルタ類の位置合わせ）
  const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', $('.app-header').offsetHeight + 'px'));
  ro.observe($('.app-header'));
  matchMedia('(max-width: 760px)').addEventListener('change', applyNav);

  window.addEventListener('beforeunload', e => {
    if (store.settings.closeWarn && store.dirty && syncDir) { e.preventDefault(); e.returnValue = ''; }
  });
  // 他タブでの変更を反映
  window.addEventListener('storage', e => {
    if ([DATA_KEY, TIMER_KEY, SETTINGS_KEY].includes(e.key)) { loadStore(); applyTheme(); renderAll(); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderAll(); checkNotifications(); } });
}

/* ================= 横スクロールの矢印 ================= */
function setupScrollHints() {
  $$('.scroll-x').forEach(el => {
    const wrap = document.createElement('div');
    wrap.className = 'scroll-wrap';
    el.parentNode.insertBefore(wrap, el);
    wrap.appendChild(el);
    for (const dir of ['left', 'right']) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'scroll-hint ' + dir; b.tabIndex = -1;
      b.setAttribute('aria-label', dir === 'left' ? '左へスクロール' : '右へスクロール');
      b.textContent = dir === 'left' ? '‹' : '›';
      b.onclick = () => el.scrollBy({ left: (dir === 'left' ? -1 : 1) * el.clientWidth * 0.6, behavior: 'smooth' });
      wrap.appendChild(b);
    }
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      wrap.classList.toggle('can-left', el.scrollLeft > 4);
      wrap.classList.toggle('can-right', max - el.scrollLeft > 4);
    };
    el.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(el);
    el._updateHint = update;
  });
}
/* 選択中のボタンを横スクロール内で見える位置へ */
function revealActive(container) {
  const a = container.querySelector('.active');
  if (!a || container.scrollWidth <= container.clientWidth) return;
  const l = a.offsetLeft - container.offsetLeft, r = l + a.offsetWidth;
  if (l < container.scrollLeft || r > container.scrollLeft + container.clientWidth) container.scrollLeft = l - 24;
  container._updateHint?.();
}

/* ================= 一括置換 ================= */
function openBulk() { renderBulkFrom(); openDlg('bulkDialog'); }
function renderBulkFrom() {
  const f = $('#bulkField').value;
  const counts = new Map();
  for (const r of store.data.records) {
    const vals = f === 'tag' ? r.tags : [r.levels[+f]];
    vals.filter(Boolean).forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  }
  $('#bulkFrom').innerHTML = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ja')).map(([v, c]) => `<option value="${esc(v)}">${esc(v)}（${c}件）</option>`).join('');
}
function applyBulk(e) {
  const f = $('#bulkField').value, from = $('#bulkFrom').value, to = $('#bulkForm').to.value.trim();
  if (!from) { e.preventDefault(); return; }
  let n = 0;
  for (const r of store.data.records) {
    if (f === 'tag') {
      if (!r.tags.includes(from)) continue;
      r.tags = uniqTags(r.tags.map(t => t === from ? to : t)); touch(r); n++;
    } else if (r.levels[+f] === from && !(r.taskId && +f < 3)) {
      r.levels[+f] = to; touch(r); n++;
    }
  }
  if (f === 'tag') for (const t of store.data.tasks) if (t.tags.includes(from)) { t.tags = uniqTags(t.tags.map(x => x === from ? to : x)); touch(t); }
  commit();
  toast(`${n}件の記録を置換しました`);
}

/* ================= PWA ================= */
function setupPwa() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW登録失敗', err));
  }
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); ui.installPrompt = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => {
    if (!ui.installPrompt) return;
    ui.installPrompt.prompt();
    await ui.installPrompt.userChoice;
    ui.installPrompt = null; $('#installBtn').hidden = true;
  };
  window.addEventListener('appinstalled', () => { $('#installBtn').hidden = true; toast('インストールしました'); });
}

/* ================= 起動 ================= */
(async function init() {
  loadStore();
  if (!store.settings.lastAlertAt) { store.settings.lastAlertAt = now(); saveSettings(); }
  applyTheme();
  $('#rUnit').value = store.settings.durUnit || 'hm';
  store.listeners.push(renderAll);
  if (rollRecurring()) commit();
  bindEvents();
  setupScrollHints();
  setupPwa();
  renderAll();
  tickClock();
  setInterval(() => { tickClock(); updateElapsed(); }, 1000);
  let lastDay = todayKey();
  setInterval(() => {
    if (todayKey() !== lastDay) { lastDay = todayKey(); if (rollRecurring()) commit(); else renderAll(); }
    else if (ui.view === 'home') renderHome();
    if (store.timer.running) renderTimerBar();
    checkNotifications();
  }, 20 * 1000);
  await restoreSyncDir();
  startAutoExportLoop();
  if (ui.view === 'settings') renderSettings();
  startOfDay();
})();
