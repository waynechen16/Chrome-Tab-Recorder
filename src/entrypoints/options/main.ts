/** Options page — recording quality, save location, file name, window, microphone. */
import { buildFileName } from '@/lib/filename';
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
  // Reflect changes made elsewhere (e.g. the popup's mic switch).
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = await loadSettings();
      renderControls();
    }
  });
  window.addEventListener('focus', () => void renderDirectory());
}

void init();
