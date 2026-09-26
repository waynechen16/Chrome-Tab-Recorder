/** Options page — recording quality, save location, file name, window, microphone. */
import { clearLog, readLog } from '@/lib/error-log';
import { buildFileName } from '@/lib/filename';
import { listPending } from '@/lib/pending';
import { discardRecording, repairAndExport } from '@/lib/recovery';
import { formatBytes, formatDuration, getState } from '@/lib/state';
import { listMics, micConstraints, micErrorMessage, micPermission, type MicPermission } from '@/lib/mic';
import { loadSettings, resetSettings, saveSettings, type Settings } from '@/lib/settings';
import {
  getSaveDirectory,
  requestSaveDirectoryPermission,
  saveDirectoryPermission,
  setSaveDirectory,
  type DirPermission,
} from '@/lib/storage/handle-store';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  saved: $('saved'),
  estimate: $('estimate'),
  dirBox: $('dirBox'),
  dirName: $('dirName'),
  dirPerm: $('dirPerm'),
  pickDir: $<HTMLButtonElement>('pickDir'),
  grantDir: $<HTMLButtonElement>('grantDir'),
  template: $<HTMLInputElement>('template'),
  preview: $('preview'),
  permState: $('permState'),
  deniedHelp: $('deniedHelp'),
  test: $<HTMLButtonElement>('test'),
  stopTest: $<HTMLButtonElement>('stopTest'),
  testArea: $('testArea'),
  level: $('level'),
  device: $<HTMLSelectElement>('device'),
  reset: $<HTMLButtonElement>('reset'),
  recovery: $('recovery'),
  pendingList: $('pendingList'),
  recoveryResult: $('recoveryResult'),
  log: $('log'),
  logEmpty: $('logEmpty'),
  clearLog: $<HTMLButtonElement>('clearLog'),
  version: $('version'),
};

let settings: Settings;
let savedTimer: number | undefined;

function flashSaved(): void {
  ui.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (ui.saved.hidden = true), 1500);
}

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  renderDerived();
  flashSaved();
}

// ---------- generic [data-key] controls ----------

function bindControls(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((el) => {
    const key = el.dataset.key as keyof Settings;
    const handler = () => {
      let value: unknown;
      if (el instanceof HTMLInputElement && el.type === 'checkbox') value = el.checked;
      else if (el.dataset.type === 'number') value = Number(el.value);
      else value = el.value;
      if (key === 'fileNameTemplate' && !String(value).trim()) return; // keep last valid
      void save({ [key]: value } as Partial<Settings>);
    };
    el.addEventListener(el instanceof HTMLInputElement && el.type === 'text' ? 'input' : 'change', handler);
  });
  document.querySelectorAll<HTMLInputElement>('input[name="saveLocation"]').forEach((r) =>
    r.addEventListener('change', async () => {
      if (r.value === 'directory' && !(await getSaveDirectory())) {
        // Choosing "folder" without a folder yet: open the picker right away.
        const ok = await pickDirectory();
        if (!ok) {
          renderControls();
          return;
        }
      }
      await save({ saveLocation: r.value as Settings['saveLocation'] });
      await renderDirectory();
    }),
  );
}

function renderControls(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-key]').forEach((el) => {
    const v = settings[el.dataset.key as keyof Settings];
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = Boolean(v);
    else if (document.activeElement !== el) el.value = String(v);
  });
  document.querySelectorAll<HTMLInputElement>('input[name="saveLocation"]').forEach((r) => {
    r.checked = r.value === settings.saveLocation;
  });
  renderDerived();
}

function renderDerived(): void {
  const gbPerHour = ((settings.videoBitsPerSecond + settings.audioBitsPerSecond) / 8) * 3600 / 1e9;
  ui.estimate.textContent = `預估檔案大小：每小時約 ${gbPerHour.toFixed(1)} GB（實際大小依畫面變化而定，投影片為主時通常更小）。`;
  ui.preview.textContent = buildFileName(settings.fileNameTemplate, 'Meet – 線上課程', new Date());
  ui.dirBox.hidden = settings.saveLocation !== 'directory';
}

// ---------- save folder ----------

const DIR_PERM_LABEL: Record<DirPermission, [string, string]> = {
  granted: ['（已授權寫入）', 'ok'],
  prompt: ['（需要重新授權）', 'warn'],
  denied: ['（已拒絕，請重新授權）', 'bad'],
  missing: ['', ''],
};

async function renderDirectory(): Promise<void> {
  const handle = await getSaveDirectory();
  const perm = await saveDirectoryPermission(handle);
  ui.dirName.textContent = handle?.name ?? '尚未選擇';
  const [label, cls] = DIR_PERM_LABEL[perm];
  ui.dirPerm.textContent = label;
  ui.dirPerm.className = `small ${cls}`;
  ui.grantDir.hidden = !handle || perm === 'granted';
  ui.pickDir.textContent = handle ? '更換資料夾…' : '選擇資料夾…';
}

async function pickDirectory(): Promise<boolean> {
  try {
    const handle = await window.showDirectoryPicker({ id: 'tab-recorder', mode: 'readwrite', startIn: 'videos' });
    // Some systems return from the picker without write access; ask explicitly.
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      await handle.requestPermission({ mode: 'readwrite' });
    }
    await setSaveDirectory(handle);
    await save({ saveLocation: 'directory', directoryName: handle.name });
    renderControls();
    await renderDirectory();
    return true;
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') alert(`無法使用這個資料夾：${(e as Error).message}`);
    return false;
  }
}

ui.pickDir.onclick = () => void pickDirectory();
ui.grantDir.onclick = async () => {
  await requestSaveDirectoryPermission();
  await renderDirectory();
};

// ---------- microphone (from M2) ----------

const PERM_LABEL: Record<MicPermission, [string, string]> = {
  granted: ['已授權', 'ok'],
  denied: ['已封鎖', 'bad'],
  prompt: ['尚未授權', ''],
  unknown: ['無法判斷', ''],
};

let testStream: MediaStream | undefined;
let testCtx: AudioContext | undefined;
let meterTimer: number | undefined;

async function renderPermission(): Promise<MicPermission> {
  const p = await micPermission();
  const [label, cls] = PERM_LABEL[p];
  ui.permState.textContent = label;
  ui.permState.className = cls;
  ui.deniedHelp.hidden = p !== 'denied';
  ui.test.textContent = p === 'granted' ? '測試麥克風' : '授權並測試麥克風';
  return p;
}

async function renderDevices(selected: string): Promise<void> {
  const mics = await listMics();
  ui.device.replaceChildren(new Option('系統預設', ''));
  for (const m of mics) ui.device.add(new Option(m.label, m.deviceId));
  if (selected && !mics.some((m) => m.deviceId === selected)) ui.device.add(new Option('（先前選擇的裝置，目前未連接）', selected));
  ui.device.value = selected;
}

function stopTest(): void {
  clearInterval(meterTimer);
  testStream?.getTracks().forEach((t) => t.stop());
  void testCtx?.close();
  testStream = undefined;
  testCtx = undefined;
  ui.testArea.hidden = true;
  ui.stopTest.hidden = true;
  ui.level.style.width = '0%';
}

async function startTest(): Promise<void> {
  stopTest();
  try {
    testStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(ui.device.value) });
  } catch (e) {
    await renderPermission();
    ui.deniedHelp.hidden = false;
    ui.deniedHelp.textContent = micErrorMessage(e);
    return;
  }
  await renderPermission();
  await renderDevices(ui.device.value); // labels become available after permission
  testCtx = new AudioContext();
  const analyser = testCtx.createAnalyser();
  analyser.fftSize = 1024;
  testCtx.createMediaStreamSource(testStream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  meterTimer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    ui.level.style.width = `${Math.min(100, Math.round(Math.sqrt(sum / buf.length) * 400))}%`;
  }, 60);
  ui.testArea.hidden = false;
  ui.stopTest.hidden = false;
}

ui.test.onclick = () => void startTest();
ui.stopTest.onclick = stopTest;
ui.device.onchange = async () => {
  await save({ micDeviceId: ui.device.value });
  if (testStream) await startTest();
};
navigator.mediaDevices.addEventListener('devicechange', () => void renderDevices(ui.device.value));

// ---------- recovery ----------

const fmtTime = (t: number) =>
  new Date(t).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Set while a repair runs, so storage-change re-renders don't wipe its status line. */
let repairing = false;

async function renderPending(force = false): Promise<void> {
  if (repairing && !force) return;
  const state = await getState();
  const active = state.phase !== 'idle' && state.phase !== 'error';
  const list = await listPending(active ? state.openFiles ?? [] : []);
  ui.recovery.hidden = list.length === 0 && !ui.recoveryResult.textContent;
  ui.pendingList.replaceChildren(
    ...list.map((p) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      info.className = 'info';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = p.title + (p.part ? `（第 ${p.part} 段）` : '');
      title.title = p.name;
      const meta = document.createElement('div');
      meta.className = 'muted small';
      meta.textContent = `開始於 ${fmtTime(p.startedAt)} ・ 最後寫入 ${fmtTime(p.lastModified)} ・ ${formatBytes(p.size)}`;
      info.append(title, meta);
      const repair = document.createElement('button');
      repair.className = 'primary small';
      repair.textContent = '修復並存檔';
      const del = document.createElement('button');
      del.className = 'small danger';
      del.textContent = '刪除';
      const status = document.createElement('div');
      status.className = 'status muted';
      repair.onclick = async () => {
        repair.disabled = del.disabled = true;
        repairing = true;
        status.textContent = '修復中…（大檔案需要數秒到數十秒）';
        try {
          const handle = settings.saveLocation === 'directory' ? await getSaveDirectory() : undefined;
          // This click is a user gesture, so we may ask for folder access here.
          if (handle && (await saveDirectoryPermission(handle)) !== 'granted') await requestSaveDirectoryPermission(handle);
          const r = await repairAndExport(p.name, handle ? { kind: 'directory', handle } : { kind: 'downloads' });
          status.textContent = ui.recoveryResult.textContent =
            `已修復「${p.title}」並存到「${r.location}」：${r.fileName}` +
            (r.durationMs !== null ? `（時長 ${formatDuration(r.durationMs)}）` : '') +
            (r.fallbackReason ? ` — 無法寫入資料夾（${r.fallbackReason}），改存到下載資料夾` : '') +
            (r.durationFixed ? '' : ' — 時長資訊無法修復，播放器可能無法拖曳進度');
        } catch (e) {
          status.textContent = `修復失敗：${(e as Error).message}`;
          repair.disabled = del.disabled = false;
          await renderLog();
        } finally {
          repairing = false;
        }
        await renderPending(true);
      };
      del.onclick = async () => {
        if (!confirm(`刪除「${p.title}」？這個動作無法復原。`)) return;
        await discardRecording(p.name).catch((e) => alert(`刪除失敗：${(e as Error).message}`));
        await renderPending();
      };
      li.append(info, repair, del, status);
      return li;
    }),
  );
}

// ---------- error log ----------

async function renderLog(): Promise<void> {
  const entries = await readLog();
  ui.logEmpty.hidden = entries.length > 0;
  ui.clearLog.hidden = entries.length === 0;
  ui.log.replaceChildren(
    ...entries.map((e) => {
      const li = document.createElement('li');
      const t = document.createElement('span');
      t.className = 'muted';
      t.textContent = fmtTime(e.at);
      const lvl = document.createElement('span');
      lvl.className = `lvl-${e.level}`;
      lvl.textContent = { error: '錯誤', warn: '警告', info: '資訊' }[e.level];
      const msg = document.createElement('span');
      msg.textContent = e.message;
      msg.title = e.code;
      li.append(t, lvl, msg);
      return li;
    }),
  );
}

ui.clearLog.onclick = async () => {
  await clearLog();
  await renderLog();
};

// ---------- reset ----------

ui.reset.onclick = async () => {
  if (!confirm('把錄影品質、檔名規則與視窗設定恢復成預設值？')) return;
  settings = await resetSettings({
    saveLocation: settings.saveLocation,
    directoryName: settings.directoryName,
    micDeviceId: settings.micDeviceId,
    micOnAtStart: settings.micOnAtStart,
  });
  renderControls();
  flashSaved();
};

// ---------- init ----------

async function init(): Promise<void> {
  settings = await loadSettings();
  ui.version.textContent = `v${chrome.runtime.getManifest().version}`;
  bindControls();
  renderControls();
  await renderDirectory();
  await renderPermission();
  await renderDevices(settings.micDeviceId);
  await renderPending();
  await renderLog();
  if (location.hash === '#recovery') ui.recovery.scrollIntoView();
  // Reflect changes made elsewhere (e.g. the popup's mic switch).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = await loadSettings();
      renderControls();
    }
    if (area === 'local' && changes.errorLog) await renderLog();
    if (area === 'session' || (area === 'local' && changes.pendingRecordings)) await renderPending();
  });
  window.addEventListener('focus', () => {
    void renderDirectory();
    void renderPending();
  });
}

void init();
