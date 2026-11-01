'use strict';
/* 端末間の引き継ぎ：共有フォルダへの日時付きJSON出力と最新ファイルのマージ */

const EXPORT_PREFIX = 'task_clock_';
const EXPORT_RE = /^task_clock_(\d{8})_(\d{6})\.json$/;
const HANDLE_DB = 'taskClock.handles';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'syncDir';
let syncDir = null;

function canUseDir() { return !!window.showDirectoryPicker && window.isSecureContext; }
function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idb(mode, fn) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, mode);
    const r = fn(tx.objectStore(HANDLE_STORE));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function restoreSyncDir() {
  if (!canUseDir()) return;
  try { syncDir = (await idb('readonly', s => s.get(HANDLE_KEY))) || null; } catch { syncDir = null; }
}
async function dirPermission(write, request) {
  if (!syncDir) return false;
  const opt = { mode: write ? 'readwrite' : 'read' };
  try {
    if ((await syncDir.queryPermission(opt)) === 'granted') return true;
    return request ? (await syncDir.requestPermission(opt)) === 'granted' : false;
  } catch { return false; }
}
async function chooseSyncDir() {
  if (!canUseDir()) throw new Error('このブラウザ（またはfile://での起動）ではフォルダ指定が使えません。https または http://localhost で開いてください。');
  syncDir = await window.showDirectoryPicker({ id: 'task-clock-sync', mode: 'readwrite' });
  await idb('readwrite', s => s.put(syncDir, HANDLE_KEY));
  return syncDir.name;
}
function markExported() {
  store.settings.lastExportAt = now();
  store.dirty = false;
  saveSettings();
}
/* フォルダが使えればフォルダへ、使えなければダウンロード */
async function exportNow({ interactive = true } = {}) {
  const name = `${EXPORT_PREFIX}${stamp()}.json`;
  const text = JSON.stringify(exportPayload(), null, 1);
  if (syncDir && await dirPermission(true, interactive)) {
    const fh = await syncDir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text); await w.close();
    markExported();
    return `共有フォルダ「${syncDir.name}」へ ${name} を保存しました`;
  }
  if (!interactive) return '';
  downloadText(name, text);
  markExported();
  return `${name} をダウンロードしました`;
}
async function mergeLatestFromDir() {
  if (!syncDir) throw new Error('先に共有フォルダを選んでください');
  if (!await dirPermission(false, true)) throw new Error('フォルダへのアクセスが許可されませんでした');
  let latest = null;
  for await (const [name, h] of syncDir.entries()) {
    if (h.kind !== 'file') continue;
    const m = EXPORT_RE.exec(name);
    if (m && (!latest || name > latest.name)) latest = { name, h };
  }
  if (!latest) throw new Error('task_clock_YYYYMMDD_HHMMSS.json が見つかりません');
  const file = await latest.h.getFile();
  return mergeText(await file.text(), latest.name);
}
function mergeText(text, name) {
  const parsed = parseImport(text, name);
  const r = mergeData(parsed.data);
  // 休日一覧は、より新しく編集された方を採用
  let holidayMsg = '';
  const h = parsed.holidays;
  if (h && Array.isArray(h.list) && num(h.updatedAt) > num(store.settings.holidaysUpdatedAt)) {
    setHolidays(h.list, num(h.updatedAt));
    if (Array.isArray(h.offWeekdays)) store.settings.offWeekdays = h.offWeekdays.map(Number).filter(n => n >= 0 && n <= 6);
    holidayMsg = ` / 休日一覧を更新（${store.settings.holidays.length}件）`;
  }
  store.settings.lastImportAt = now();
  commit();
  const part = (label, x) => (x.added || x.updated || x.removed) ? `${label} 追加${x.added}・更新${x.updated}${x.removed ? `・削除${x.removed}` : ''}` : '';
  const summary = [part('タスク', r.tasks), part('Project', r.projects), part('記録', r.records)].filter(Boolean).join(' / ') || '変更なし';
  return `${name}（${parsed.kind}）をマージ：${summary}${holidayMsg}`;
}
function syncStatusChips() {
  const s = store.settings, out = [];
  out.push(syncDir ? `<span class="chip ok">共有フォルダ: ${esc(syncDir.name)}</span>` : `<span class="chip">共有フォルダ未設定</span>`);
  if (s.syncPathNote) out.push(`<span class="chip">場所: ${esc(s.syncPathNote)}</span>`);
  out.push(store.dirty ? `<span class="chip warn">未エクスポートの変更あり</span>` : `<span class="chip ok">エクスポート済み</span>`);
  out.push(`<span class="chip">最終エクスポート: ${s.lastExportAt ? new Date(s.lastExportAt).toLocaleString('ja-JP') : 'なし'}</span>`);
  out.push(`<span class="chip">最終マージ: ${s.lastImportAt ? new Date(s.lastImportAt).toLocaleString('ja-JP') : 'なし'}</span>`);
  if (!canUseDir()) out.push(`<span class="chip warn">フォルダ連携は非対応環境（ダウンロード/ファイル指定で代用）</span>`);
  return out.join('');
}
let autoExportTimer = null;
function startAutoExportLoop() {
  clearInterval(autoExportTimer);
  autoExportTimer = setInterval(async () => {
    if (!store.settings.autoExport || !store.dirty || !syncDir) return;
    if (now() - num(store.settings.lastExportAt) < HOUR_MS) return;
    try { const msg = await exportNow({ interactive: false }); if (msg) toast('自動エクスポート: ' + msg); } catch { /* 権限切れ等は次回 */ }
  }, 5 * MIN_MS);
}
