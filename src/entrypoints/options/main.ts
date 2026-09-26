/** Options page — M2: microphone permission, device choice and test. */
import { listMics, micConstraints, micErrorMessage, micPermission, type MicPermission } from '@/lib/mic';
import { loadSettings, saveSettings } from '@/lib/settings';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  permState: $('permState'),
  deniedHelp: $('deniedHelp'),
  test: $<HTMLButtonElement>('test'),
  stopTest: $<HTMLButtonElement>('stopTest'),
  testArea: $('testArea'),
  level: $('level'),
  device: $<HTMLSelectElement>('device'),
  micOnAtStart: $<HTMLInputElement>('micOnAtStart'),
  saved: $('saved'),
};

const PERM_LABEL: Record<MicPermission, [string, string]> = {
  granted: ['已授權', 'ok'],
  denied: ['已封鎖', 'bad'],
  prompt: ['尚未授權', ''],
  unknown: ['無法判斷', ''],
};

let testStream: MediaStream | undefined;
let testCtx: AudioContext | undefined;
let meterTimer: number | undefined;
let savedTimer: number | undefined;

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
  // Keep a saved device selectable even if it is unplugged right now.
  if (selected && !mics.some((m) => m.deviceId === selected)) ui.device.add(new Option('（先前選擇的裝置，目前未連接）', selected));
  ui.device.value = selected;
}

function flashSaved(): void {
  ui.saved.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = window.setTimeout(() => (ui.saved.hidden = true), 1500);
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
    alertInline(micErrorMessage(e));
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

function alertInline(text: string): void {
  ui.deniedHelp.hidden = false;
  ui.deniedHelp.textContent = text;
}

ui.test.onclick = () => void startTest();
ui.stopTest.onclick = stopTest;
ui.device.onchange = async () => {
  await saveSettings({ micDeviceId: ui.device.value });
  flashSaved();
  if (testStream) await startTest();
};
ui.micOnAtStart.onchange = async () => {
  await saveSettings({ micOnAtStart: ui.micOnAtStart.checked });
  flashSaved();
};
navigator.mediaDevices.addEventListener('devicechange', async () => renderDevices(ui.device.value));

async function init(): Promise<void> {
  const settings = await loadSettings();
  ui.micOnAtStart.checked = settings.micOnAtStart;
  await renderPermission();
  await renderDevices(settings.micDeviceId);
  // Reflect changes made from the popup while this page is open.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.settings) ui.micOnAtStart.checked = (await loadSettings()).micOnAtStart;
  });
}

void init();
