'use strict';
/* 通知：画面内メッセージ＋OS通知（許可時）。アプリ（またはタブ）が開いている間だけ動作 */

/* その業務日の勤務状況：開始時刻・最後の記録・終業済みか */
function workSession(recs = null) {
  const s = store.settings, key = todayKey();
  const d0 = bizDayStartOfKey(key);
  const list = (recs || recordsInRange(d0, d0 + DAY_MS - 1)).filter(r => r.kind === 'actual').sort((a, b) => a.startedAt - b.startedAt);
  // 勤務日の始業予定（通知用）。「勤務日は始業時刻から」の場合は未記録の検出にも使う
  let planned = null;
  if (isWorkday(key)) {
    planned = parseDateKey(key) + minutesFromHHMM(s.workStart, 540) * MIN_MS;
    if (planned < d0) planned += DAY_MS;
  }
  const fixed = s.workStartMode === 'fixed' ? planned : null;
  const first = list.length ? list[0].startedAt : null;
  const start = fixed != null ? Math.min(fixed, first ?? Infinity) : first;
  const lastEnd = list.length ? Math.max(...list.map(r => r.endedAt)) : null;
  const closed = s.closedDay === key;
  const lastActivity = lastEnd ?? start;
  // 終業していなくても、最後の記録から一定時間空いたら勤務終了とみなす（夜勤・休日対応後に通知し続けないため）
  const idleLimit = Math.max(1, num(s.sessionIdleHours, 3)) * HOUR_MS;
  const open = start != null && !closed && now() >= start && now() - lastActivity <= idleLimit;
  return { key, start, fixed, planned, lastEnd, closed, open, idleLimit, list };
}
/* 未記録のすき間（勤務開始～現在） */
function sessionGaps(ws) {
  const minGap = num(store.settings.gapMinMinutes, 10) * MIN_MS;
  const gaps = [];
  if (ws.start == null) return gaps;
  let cur = ws.start;
  for (const r of ws.list) {
    if (r.startedAt - cur >= minGap) gaps.push([cur, r.startedAt]);
    cur = Math.max(cur, r.endedAt);
  }
  if (!store.timer.running && ws.open && now() - cur >= minGap) gaps.push([cur, now()]);
  return gaps;
}

async function osNotify(title, body, tag) {
  const s = store.settings;
  if (!s.osNotify || !('Notification' in window) || Notification.permission !== 'granted') return false;
  if (!(document.hidden || !document.hasFocus() || s.osNotifyAlways)) return false;
  const opt = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', renotify: true };
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg) await reg.showNotification(title, opt);
    else new Notification(title, opt);
    return true;
  } catch { return false; }
}
function notifyUser(title, body, { tag = 'task-clock', action = null } = {}) {
  toast(`${title}${body ? ' — ' + body : ''}`, action, 9000);
  osNotify('Task Clock：' + title, body, tag);
}
function marks() {
  if (!store.settings.notifyMarks || typeof store.settings.notifyMarks !== 'object') store.settings.notifyMarks = {};
  return store.settings.notifyMarks;
}

function checkNotifications() {
  const s = store.settings, mk = marks();
  let changed = false;
  const t = now();

  // 1) 計測中の経過通知
  const runMin = num(s.runNotifyMin, 0);
  if (store.timer.running && runMin > 0) {
    const k = Math.floor(timerElapsedSec() / (runMin * 60));
    const key = store.timer.startedAt + ':' + k;
    if (k >= 1 && mk.run !== key) {
      mk.run = key; changed = true;
      const task = getTask(store.timer.taskId);
      const name = task ? task.title : store.timer.levels.filter(Boolean).join(' › ');
      notifyUser(`「${name}」が ${fmtMin(k * runMin)} 経過`, task?.estimateMin ? `見積 ${fmtMin(task.estimateMin)} / 累計 ${fmtDur(taskActualSec(task.id))}` : '', { tag: 'run', action: { label: '■ 停止', fn: () => doStop() } });
    }
  }

  // 2) 勤務中なのに計測していない（設定した間隔ごとに繰り返し通知）
  const idleMin = num(s.idleNotifyMin, 0);
  if (!store.timer.running && idleMin > 0) {
    const ws = workSession();
    // まだ記録がない勤務日は、始業予定の時刻から数える
    const beforeFirst = ws.start == null && ws.planned != null && !ws.closed && t >= ws.planned && t - ws.planned <= ws.idleLimit;
    if (ws.open || beforeFirst) {
      const since = ws.lastEnd ?? ws.start ?? ws.planned;
      const n = Math.floor((t - since) / (idleMin * MIN_MS));
      const key = since + ':' + n;
      if (n >= 1 && mk.idle !== key) {
        mk.idle = key; changed = true;
        notifyUser(ws.lastEnd ? `計測なしで ${fmtMin(n * idleMin)} 経過` : `${ws.start == null ? '始業予定' : '始業'} ${fmtTime(since)} から計測なしで ${fmtMin(n * idleMin)} 経過`,
          ws.lastEnd ? `${fmtTime(since)} 以降の作業が未記録です` : '今の作業を計測しますか？',
          { tag: 'idle', action: { label: 'タスクを選んで開始', fn: () => pickTask({ title: '計測を開始', sub: '今している作業を選んでください', onPick: id => startForTask(id) }) } });
      }
    }
  }

  // 3) 日時つきの予定・タスクの事前通知
  const lead = num(s.remindBeforeMin, 0);
  if (lead > 0) {
    mk.reminded = Array.isArray(mk.reminded) ? mk.reminded : [];
    const items = [];
    for (const task of store.data.tasks) {
      if (task.done || task.due.length <= 10) continue;
      items.push({ key: 't:' + task.id + ':' + task.due, at: parseLocalDateTime(task.due), title: task.title, taskId: task.id });
    }
    for (const r of store.data.records) {
      if (r.kind !== 'plan' || r.startedAt < t - HOUR_MS || r.startedAt > t + DAY_MS) continue;
      items.push({ key: 'r:' + r.id + ':' + r.startedAt, at: r.startedAt, title: (getTask(r.taskId)?.title) || r.levels.filter(Boolean).join(' › ') || '予定', taskId: r.taskId });
    }
    // 事前（設定の分前）と開始時刻の2回知らせる
    for (const it of items) {
      if (Number.isNaN(it.at) || t > it.at + 10 * MIN_MS) continue;
      const stage = t >= it.at ? 'start' : t >= it.at - lead * MIN_MS ? 'pre' : '';
      if (!stage || mk.reminded.includes(it.key + ':' + stage)) continue;
      mk.reminded.push(it.key + ':' + stage); changed = true;
      const before = Math.round((it.at - t) / MIN_MS);
      notifyUser(stage === 'pre' ? `${it.title} の ${before}分前です` : `${it.title} の時刻です`, `${fmtTime(it.at)} 開始`,
        { tag: 'remind:' + it.key, action: it.taskId && getTask(it.taskId) ? { label: '▶ 計測開始', fn: () => startForTask(it.taskId) } : null });
    }
    if (mk.reminded.length > 300) mk.reminded = mk.reminded.slice(-200);
  }

  // 4) 詰まりアラーム
  if (s.alertEnabled && t - num(s.lastAlertAt) >= num(s.alertIntervalMinutes, 120) * MIN_MS) {
    s.lastAlertAt = t; changed = true;
    const alerts = getAlerts();
    if (alerts.length) notifyUser(`要対応 ${alerts.length}件`, alerts.slice(0, 3).map(a => `${a.label}: ${a.title}`).join(' / '), { tag: 'alarm', action: { label: 'ホームで見る', fn: () => setView('home') } });
  }
  if (changed) saveSettings();
}
