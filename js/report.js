'use strict';
/* 集計：期間・軸別の内訳、日別、予実、気づき、報告テキスト */

const report = { period: 'week', from: '', to: '' };

function periodRange(p) {
  const [a, b, label] = calendarRange(p);
  const o = dayOffsetMs(); // 日付の区切り時刻だけずらす
  return [a + o, b + o, label];
}
function calendarRange(p) {
  const t = now() - dayOffsetMs();
  switch (p) {
    case 'today': return [dayStart(t), dayEnd(t), '今日'];
    case 'week': return [weekStart(t), addDays(weekStart(t), 7) - 1, '今週'];
    case 'lastweek': return [addDays(weekStart(t), -7), weekStart(t) - 1, '先週'];
    case 'month': return [monthStart(t), monthEnd(t), '今月'];
    case 'lastmonth': { const s = monthStart(monthStart(t) - 1); return [s, monthEnd(s), '先月']; }
    case 'next30': return [dayStart(t), dayEnd(addDays(t, 30)), '今後30日'];
    case 'custom': {
      const f = parseDateKey(report.from), e = parseDateKey(report.to);
      const a = Number.isNaN(f) ? monthStart(t) : f, b = Number.isNaN(e) ? dayEnd(t) : dayEnd(e);
      return [Math.min(a, b), Math.max(a, b), '任意期間'];
    }
  }
  return [weekStart(t), dayEnd(t), '今週'];
}

function projectColorOf(rec) {
  const t = rec.taskId ? getTask(rec.taskId) : null;
  const p = t ? getProject(t.projectId) : store.data.projects.find(x => x.title === rec.levels[0]);
  return p ? `var(--p${p.color})` : 'var(--muted)';
}
function axisKeys(rec, axis) {
  const lv = rec.levels;
  switch (axis) {
    case 'project': return [[lv[0] || NO_PROJECT]];
    case 'project2': return [[lv[0] || NO_PROJECT, lv[1] || '（分類なし）']];
    case 'task': return [[lv.filter(Boolean).slice(0, 3).join(' › ') || '（未設定）']];
    case 'tag': return rec.tags.length ? rec.tags.map(t => [t]) : [['（タグなし）']];
    case 'level1': return [[lv[0] || '（未設定）']];
    case 'level2': return [[lv[0] || '（未設定）', lv[1] || '（未設定）']];
    case 'level3': return [[lv[0] || '（未設定）', lv[1] || '（未設定）', lv[2] || '（未設定）']];
  }
  return [[lv[0]]];
}
/* 多段の集計木 {name, actual, plan, color, children:Map} */
function buildTree(records, axis) {
  const root = { children: new Map(), actual: 0, plan: 0 };
  for (const r of records) {
    const color = projectColorOf(r);
    for (const path of axisKeys(r, axis)) {
      let node = root;
      for (const name of path) {
        if (!node.children.has(name)) node.children.set(name, { name, actual: 0, plan: 0, color, children: new Map() });
        node = node.children.get(name);
        node[r.kind] += r.durationSec;
      }
    }
    root[r.kind] += r.durationSec;
  }
  return root;
}
const sortedChildren = node => [...node.children.values()].sort((a, b) => (b.actual + b.plan) - (a.actual + a.plan));

function dailyTotals(records) {
  const m = new Map();
  for (const r of records) {
    const k = bizDayKey(r.startedAt);
    const v = m.get(k) || { actual: 0, plan: 0, projects: new Set(), count: 0, short: 0 };
    v[r.kind] += r.durationSec;
    if (r.kind === 'actual') {
      v.projects.add(r.levels[0]); v.count++;
      if (r.durationSec < 30 * 60) v.short++;
    }
    m.set(k, v);
  }
  return m;
}

/* 期間内の基準超過（勤務日の基準時間を超えた分＋休日の作業）と、月末までの見込み */
function monthOvertime(from, to) {
  const days = dailyTotals(recordsInRange(from, to).filter(r => r.kind === 'actual'));
  let over = 0, holiday = 0;
  for (const [k, v] of days) { const o = Math.max(0, v.actual - baseSecOf(k)); over += o; if (!isWorkday(k)) holiday += v.actual; }
  // 見込み：経過した勤務日の平均ペースで、残りの勤務日も同じだけ超過すると仮定
  const today = todayKey();
  let elapsed = 0, remain = 0;
  for (let t = parseDateKey(bizDayKey(from)); t <= to - dayOffsetMs(); t = addDays(t, 1)) {
    const k = dateKey(t);
    if (!isWorkday(k)) continue;
    if (k <= today) elapsed++; else remain++;
  }
  const workOver = over - [...days].filter(([k]) => !isWorkday(k)).reduce((a, [, v]) => a + v.actual, 0);
  const forecast = over + (elapsed ? workOver / elapsed : 0) * remain;
  return { over, holiday, forecast, elapsed, remain };
}
/* 期間に含まれる各月の基準超過（月の上限目安との比較用） */
function overtimeByMonth(from, to) {
  const out = [];
  let m = monthStart(from - dayOffsetMs());
  while (m <= to - dayOffsetMs()) {
    const o = dayOffsetMs();
    out.push({ label: `${new Date(m).getFullYear()}年${new Date(m).getMonth() + 1}月`, ...monthOvertime(m + o, monthEnd(m) + o), current: m === monthStart(now() - o) });
    m = monthEnd(m) + 1;
  }
  return out;
}

function renderReport() {
  const [from, to, label] = periodRange(report.period);
  const scope = $('#rScope').value, axis = $('#rAxis').value, tag = $('#rTag').value, unit = $('#rUnit').value;
  store.settings.durUnit = unit;
  const includePlan = scope === 'all';
  let recs = recordsInRange(from, to, { includePlan });
  if (tag) recs = recs.filter(r => r.tags.some(t => cmpKey(t) === cmpKey(tag)));
  const D = s => fmtDur(s, unit);
  const actual = recs.filter(r => r.kind === 'actual');
  const plan = recs.filter(r => r.kind === 'plan');
  const actSec = actual.reduce((a, r) => a + r.durationSec, 0);
  const planSec = plan.reduce((a, r) => a + r.durationSec, 0);
  const days = dailyTotals(recs);
  const actDays = [...days.values()].filter(v => v.actual > 0);
  const base = num(store.settings.baseMinutes, 480) * 60;
  const dayEntries = [...days.entries()].filter(([, v]) => v.actual > 0);
  const overSec = dayEntries.reduce((a, [k, v]) => a + Math.max(0, v.actual - baseSecOf(k)), 0);
  const holidaySec = dayEntries.filter(([k]) => !isWorkday(k)).reduce((a, [, v]) => a + v.actual, 0);
  const avg = actDays.length ? actSec / actDays.length : 0;

  $('#reportStats').innerHTML = [
    stat('実績合計', D(actSec), `${label}・${actDays.length}日`),
    includePlan ? stat('予定（未来分）', D(planSec), '手入力の予定＋見積の残り') : stat('1日平均', D(avg), '記録のある日'),
    stat('基準超過', D(overSec), holidaySec ? `うち休日作業 ${D(holidaySec)}` : `勤務日の基準 ${hhmmFromMinutes(num(store.settings.baseMinutes, 480))}`, overSec > 0 ? 'warn' : ''),
    stat('記録件数', actual.length + '件', `タスク未割当 ${actual.filter(r => !r.taskId).length}件`)
  ].join('');

  // 内訳
  const tree = buildTree(recs, axis);
  const total = tree.actual + tree.plan;
  const tops = sortedChildren(tree);
  $('#breakdownHint').textContent = axis === 'tag' ? 'タグは重複計上（1記録に複数タグ）' : '';
  if (!tops.length) $('#breakdown').innerHTML = '<div class="empty">この条件の記録はありません</div>';
  else {
    const strip = axis === 'tag' ? '' : `<div class="share-strip">${tops.slice(0, 12).map(n => `<span title="${esc(n.name)}" style="--pc:${n.color};width:${pct(n.actual + n.plan, total)}%"></span>`).join('')}</div>`;
    const max = Math.max(...tops.map(n => n.actual + n.plan));
    const row = (n, sub, mx) => {
      const t = n.actual + n.plan;
      return `<div class="bar-row"><span class="name ${sub ? 'sub' : ''}" title="${esc(n.name)}">${esc(n.name)}</span>
        <span class="bar-track" style="--pc:${n.color}"><b style="width:${pct(n.actual, mx)}%"></b><b class="plan" style="width:${pct(n.plan, mx)}%"></b></span>
        <span class="bar-val">${D(t)} <small>${pct(t, total)}%${n.plan ? `・予${D(n.plan)}` : ''}</small></span></div>`;
    };
    $('#breakdown').innerHTML = strip + tops.map(n => {
      const kids = sortedChildren(n);
      return row(n, false, max) + (kids.length && axis !== 'project' ? kids.map(k => row(k, true, max)).join('') : '');
    }).join('');
  }

  renderDaily(from, to, days, base, D);
  renderEstimateTable(from, to, D);
  renderInsights(actual, plan, days, base, D, actSec);
  $('#reportText').textContent = reportText(label, from, to, tree, actSec, planSec, overSec, actDays.length, D, includePlan, tag);
}

function renderDaily(from, to, days, base, D) {
  const keys = [];
  for (let t = dayStart(from - dayOffsetMs()); t <= to - dayOffsetMs() && keys.length < 120; t = addDays(t, 1)) keys.push(dateKey(t));
  const max = Math.max(base * 1.25, ...[...days.values()].map(v => v.actual + v.plan));
  $('#dailyChart').innerHTML = keys.length > 1 || days.size ? keys.map(k => {
    const v = days.get(k) || { actual: 0, plan: 0 };
    const hol = holidayName(k), b = baseSecOf(k);
    const normal = Math.min(v.actual, b), over = Math.max(0, v.actual - b);
    return `<div class="daily-row ${hol ? 'weekend' : ''}" title="${esc(hol)}"><span class="d">${fmtDay(k)}</span>
      <span class="daily-track"><b style="width:${pct(normal, max)}%"></b><b class="over" style="width:${pct(over, max)}%"></b><b class="plan" style="width:${pct(v.plan, max)}%"></b>${b ? `<i class="base" style="left:${pct(b, max)}%"></i>` : ''}</span>
      <span class="v">${v.actual + v.plan ? D(v.actual + v.plan) : ''}</span></div>`;
  }).join('') : '<div class="empty">記録がありません</div>';
}

function renderEstimateTable(from, to, D) {
  const touched = new Set(store.data.records.filter(r => r.taskId && r.startedAt >= from && r.startedAt <= to).map(r => r.taskId));
  if (store.timer.running && store.timer.taskId) touched.add(store.timer.taskId);
  const rows = [...touched].map(getTask).filter(t => t && t.estimateMin > 0)
    .map(t => ({ t, est: t.estimateMin * 60, act: taskActualSec(t.id) }))
    .sort((a, b) => (b.act - b.est) - (a.act - a.est));
  if (!rows.length) { $('#estimateTable').innerHTML = '<div class="empty">見積を入れたタスクを計測すると、ここに予実差が出ます</div>'; return; }
  const sumE = rows.reduce((a, x) => a + x.est, 0), sumA = rows.reduce((a, x) => a + x.act, 0);
  const done = rows.filter(x => x.t.done);
  const ratio = done.length ? done.reduce((a, x) => a + x.act, 0) / done.reduce((a, x) => a + x.est, 0) : 0;
  $('#estimateTable').innerHTML = `<table class="est"><thead><tr><th>タスク</th><th>見積</th><th>実績</th><th>差</th></tr></thead><tbody>${rows.slice(0, 30).map(({ t, est, act }) => {
    const diff = act - est;
    const cell = diff > 0 ? `<td class="over">+${D(diff)}</td>` : t.done ? `<td class="under">-${D(-diff)}</td>` : `<td class="muted">残り ${D(-diff)}</td>`;
    return `<tr><td>${t.done ? '✓ ' : ''}${esc(t.title)} <span class="muted small">${esc(projectTitle(t.projectId))}</span></td><td>${D(est)}</td><td>${D(act)}</td>${cell}</tr>`;
  }).join('')}</tbody><tfoot><tr><th>合計</th><th>${D(sumE)}</th><th>${D(sumA)}</th><th></th></tr></tfoot></table>
  ${done.length ? `<p class="muted small">完了タスクの実績÷見積 = <strong>${ratio.toFixed(2)}倍</strong>。${ratio > 1.2 ? '見積はこの倍率を掛けると現実に近づきます。' : ratio < 0.8 ? '見積に余裕があります。' : '見積精度は良好です。'}</p>` : ''}`;
}

/* 旧 Task Time Log の「負荷・時間配分の気づき」を踏襲。診断ではなく掘り下げの入口 */
function renderInsights(actual, plan, days, base, D, actSec) {
  const actDays = [...days.entries()].filter(([, v]) => v.actual > 0);
  const n = actDays.length || 1;
  const avgProjects = actDays.reduce((a, [, v]) => a + v.projects.size, 0) / n;
  const avgCount = actDays.reduce((a, [, v]) => a + v.count, 0) / n;
  const shortRate = actual.length ? actual.filter(r => r.durationSec < 1800).length / actual.length : 0;
  const longDays = actDays.filter(([, v]) => v.actual >= 10 * 3600).length;
  const overDays = actDays.filter(([k, v]) => isWorkday(k) && v.actual > base).length;
  const holDays = actDays.filter(([k]) => !isWorkday(k));
  const unassigned = actual.filter(r => !r.taskId).reduce((a, r) => a + r.durationSec, 0);
  const tagSec = new Map();
  actual.forEach(r => r.tags.forEach(t => tagSec.set(t, (tagSec.get(t) || 0) + r.durationSec)));
  const tagRate = name => { const k = cmpKey(name); let s = 0; tagSec.forEach((v, t) => { if (cmpKey(t) === k) s += v; }); return actSec ? s / actSec : 0; };
  const topTags = [...tagSec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const items = [];
  const add = (warn, title, text) => items.push(`<div class="insight ${warn ? 'warn' : ''}"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`);
  if (longDays) add(true, `10時間以上の日が ${longDays}日`, '日別でその日の割り込み・障害・締切を確認してください。');
  if (overDays) add(true, `勤務日に基準時間を超えた日が ${overDays}日`, '曜日や会議・障害対応との重なりを日別で確認できます。');
  const limit = num(store.settings.monthOverLimitHours, 45) * 3600;
  if (limit) {
    const [pf, pt] = periodRange(report.period);
    for (const m of overtimeByMonth(pf, Math.min(pt, now()))) {
      if (m.over >= limit) add(true, `${m.label}の基準超過 ${D(m.over)} — 上限目安 ${D(limit)} を超過`, `うち休日作業 ${D(m.holiday)}。夜間・休日対応の分担や、翌月の予定の前倒しを検討してください。`);
      else if (m.current && m.forecast >= limit) add(true, `${m.label}はこのペースだと月末 ${D(m.forecast)} の見込み`, `現在 ${D(m.over)}。上限目安 ${D(limit)} まで残り ${D(limit - m.over)}（残り勤務日 ${m.remain}日）。`);
      else if (m.over >= limit * 0.8) add(true, `${m.label}の基準超過 ${D(m.over)} — 上限目安の${Math.round(m.over / limit * 100)}%`, `上限目安 ${D(limit)} まで残り ${D(limit - m.over)}。`);
    }
  }
  if (holDays.length) add(true, `休日に作業した日が ${holDays.length}日（${D(holDays.reduce((a, [, v]) => a + v.actual, 0))}）`, holDays.slice(0, 5).map(([k]) => `${fmtDay(k)} ${holidayName(k)}`).join('、'));
  if (avgProjects >= 4) add(true, `1日平均 ${avgProjects.toFixed(1)} Projectを行き来`, '案件の切り替えが多めです。同じ案件をまとめて扱う時間帯を作れないか検討を。');
  if (shortRate >= 0.3) add(true, `30分未満の細切れ記録が ${Math.round(shortRate * 100)}%`, '問い合わせや割り込みで作業が分断されていないか、タグ別で確認を。');
  const rules = [[INTERRUPT_TAG, .2, '受付時間をまとめる・一次切り分け・担当ローテーションなどを検討。'], ['会議', .1, '定例の統合・短縮・参加者や非同期化の見直し候補。'], ['資料探索', .1, '置き場所・命名規則・リンク集の整備で減らせる可能性。'], ['障害対応', .08, '原因別にタグを分けると再発傾向が見えます。']];
  for (const [name, th, tip] of rules) { const r = tagRate(name); if (r >= th) add(true, `「${name}」が実績の ${Math.round(r * 100)}%`, tip); }
  if (actSec && unassigned / actSec >= 0.15) add(false, `タスク未割当の実績が ${Math.round(unassigned / actSec * 100)}%`, '記録画面の「タスク未割当のみ」から割り当てると、Project別の精度が上がります。');
  const futureDays = [...days.entries()].filter(([k, v]) => v.plan > 0 && parseDateKey(k) >= parseDateKey(todayKey()));
  const heavy = futureDays.filter(([k, v]) => v.plan + v.actual > baseSecOf(k));
  if (heavy.length) add(true, `予定だけで基準を超える日が ${heavy.length}日`, heavy.slice(0, 5).map(([k]) => fmtDay(k)).join('、') + ' — 前後へ移せないか確認を。');
  if (!items.length) add(false, '大きな偏りは見つかりませんでした', '期間やタグ絞込を変えて比較してみてください。');

  $('#insights').innerHTML = `<div class="metric-grid">
    ${metric('実績1日平均', D(actDays.length ? actSec / n : 0))}
    ${metric('1日平均Project数', avgProjects.toFixed(1))}
    ${metric('1日平均記録数', avgCount.toFixed(1) + '件')}
    ${metric('30分未満の記録', Math.round(shortRate * 100) + '%')}
  </div>${items.join('')}
  ${topTags.length ? `<p class="muted small">タグ上位: ${topTags.map(([t, s]) => `${esc(t)} ${D(s)}（${pct(s, actSec)}%）`).join(' / ')}</p>` : ''}`;
}
function metric(l, v) { return `<div class="metric"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div></div>`; }

function reportText(label, from, to, tree, actSec, planSec, overSec, dayCount, D, includePlan, tag) {
  const lines = [];
  lines.push(`■ 作業時間報告 ${label}（${fmtDayFull(from)}～${fmtDayFull(Math.min(to, includePlan ? to : now()))}）${tag ? ` タグ:${tag}` : ''}`);
  lines.push(`実績 ${D(actSec)}（${dayCount}日）${includePlan ? ` / 予定 ${D(planSec)}` : ''}${overSec ? ` / 基準超過 ${D(overSec)}` : ''}`);
  lines.push('');
  for (const n of sortedChildren(tree)) {
    const t = n.actual + n.plan;
    lines.push(`・${n.name}  ${D(t)}（${pct(t, tree.actual + tree.plan)}%）`);
    for (const k of sortedChildren(n)) lines.push(`    - ${k.name}  ${D(k.actual + k.plan)}`);
  }
  const doneTasks = store.data.tasks.filter(t => t.done && t.doneAt >= from && t.doneAt <= to);
  if (doneTasks.length) {
    lines.push('', `■ 完了したタスク（${doneTasks.length}件）`);
    doneTasks.sort((a, b) => a.doneAt - b.doneAt).forEach(t => lines.push(`・${projectTitle(t.projectId) ? `[${projectTitle(t.projectId)}] ` : ''}${t.title}`));
  }
  return lines.join('\n');
}

function exportRecordsCsv() {
  const [from, to, label] = periodRange(report.period);
  const recs = recordsInRange(from, to, { includePlan: $('#rScope').value === 'all', includeRunning: false })
    .sort((a, b) => a.startedAt - b.startedAt);
  const headers = ['rowType', 'id', 'recordKind', 'level1', 'level2', 'level3', 'level4', 'level5', 'tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'durationSec', 'startedAt', 'endedAt', 'source', 'note', 'taskId', 'date', 'hours', 'createdAt', 'updatedAt'];
  const rows = [headers];
  for (const r of recs) {
    const tags = [...r.tags, '', '', '', '', ''].slice(0, 5);
    rows.push(['record', r.id, r.kind, ...r.levels, ...tags, r.durationSec, new Date(r.startedAt).toISOString(), new Date(r.endedAt).toISOString(), r.source, r.note, r.taskId, dateKey(r.startedAt), (r.durationSec / 3600).toFixed(2), r.createdAt ? new Date(r.createdAt).toISOString() : '', r.updatedAt ? new Date(r.updatedAt).toISOString() : '']);
  }
  downloadText(`task_clock_records_${label}_${stamp()}.csv`, '﻿' + rows.map(r => r.map(csvEscape).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}
