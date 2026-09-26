/** Popup — only user gestures and state display; holds no media objects. */
import { send, type CommandResponse, type PopupCommand } from '@/lib/messages';
import { micPermission, type MicPermission } from '@/lib/mic';
import { loadSettings, saveSettings, type Settings } from '@/lib/settings';
import { listPending } from '@/lib/pending';
import { saveDirectoryPermission } from '@/lib/storage/handle-store';

const RES_LABEL: Record<Settings['resolution'], string> = {
  tab: '跟隨分頁',
  '2160p': '4K',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
};

/** One line under the start button: where the file goes and at what quality. */
async function describeSaveTarget(s: Settings): Promise<string> {
  const quality = `${RES_LABEL[s.resolution]} · ${s.fps} fps · ${s.videoBitsPerSecond / 1_000_000} Mbps`;
  if (s.saveLocation !== 'directory') return `存到：下載資料夾 ｜ ${quality}`;
  const perm = await saveDirectoryPermission();
  const note = perm === 'granted' ? '' : perm === 'missing' ? '（找不到資料夾，將存到下載資料夾）' : '（開始錄製時需重新授權）';
  return `存到：「${s.directoryName || '指定資料夾'}」${note} ｜ ${quality}`;
}
import { elapsedMs, formatBytes, formatDuration, getState, onStateChanged, type RecordingState } from '@/lib/state';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  dot: $('dot'),
  status: $('status'),
  timer: $('timer'),
  favicon: $<HTMLImageElement>('favicon'),
  tabTitle: $('tabTitle'),
  notice: $('notice'),
  idleView: $('idleView'),
  start: $<HTMLButtonElement>('start'),
  unrecordable: $('unrecordable'),
  recView: $('recView'),
  size: $('size'),
  recTitle: $('recTitle'),
  pause: $<HTMLButtonElement>('pause'),
  stop: $<HTMLButtonElement>('stop'),
  showRecorder: $<HTMLButtonElement>('showRecorder'),
  gotoTab: $<HTMLButtonElement>('gotoTab'),
  busyView: $('busyView'),
  errorView: $('errorView'),
  ackError: $<HTMLButtonElement>('ackError'),
  last: $('last'),
  micRow: $('micRow'),
  micToggle: $<HTMLInputElement>('micToggle'),
  micLabel: $('micLabel'),
  micHint: $('micHint'),
  openOptions: $<HTMLButtonElement>('openOptions'),
  settings: $<HTMLButtonElement>('settings'),
  saveTo: $('saveTo'),
  pending: $<HTMLButtonElement>('pending'),
};

let state: RecordingState;
let activeTab: chrome.tabs.Tab | undefined;
let micAtStart = false;
let micPerm: MicPermission = 'unknown';
let saveToText = '';
let pendingCount = 0;

/** Pages Chrome does not allow extensions to capture. */
function unrecordableReason(tab?: chrome.tabs.Tab): string | null {
  const url = tab?.url ?? tab?.pendingUrl ?? '';
  if (!tab?.id) return '找不到目前的分頁。';
  if (!/^(https?|file):/i.test(url)) return '瀏覽器內部頁面（chrome://、擴充功能頁等）無法錄製。';
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return 'Chrome 線上應用程式商店頁面無法錄製。';
  return null;
}

async function command(cmd: PopupCommand): Promise<void> {
  const res = await send<CommandResponse>(cmd);
  if (res && !res.ok) showNotice(res.message, true);
}

function showNotice(text: string | undefined, error = false): void {
  ui.notice.hidden = !text;
  ui.notice.textContent = text ?? '';
  ui.notice.className = `notice${error ? ' error' : ''}`;
}

function show(view: 'idle' | 'rec' | 'busy' | 'error'): void {
  ui.idleView.hidden = view !== 'idle';
  ui.recView.hidden = view !== 'rec';
  ui.busyView.hidden = view !== 'busy';
  ui.errorView.hidden = view !== 'error';
}

function renderTimer(): void {
  if (!state) return;
  ui.timer.textContent = formatDuration(elapsedMs(state, Date.now()));
}

function render(): void {
  const s = state;
  const active = s.phase === 'recording' || s.phase === 'paused';
  ui.dot.className = `dot ${active ? s.phase : s.phase === 'error' ? 'error' : ''}`;
  ui.status.textContent =
    { idle: 'Tab Recorder', starting: '準備中…', recording: '錄製中', paused: '已暫停', stopping: '存檔中…', error: '發生錯誤' }[
      s.phase
    ];
  ui.timer.hidden = !active && s.phase !== 'stopping';
  renderTimer();

  // Which tab to show at the top: the one being recorded, or the current one.
  const showingTarget = s.phase !== 'idle' && s.targetTabId !== undefined;
  const title = showingTarget ? s.targetTitle ?? '' : activeTab?.title ?? '';
  ui.tabTitle.textContent = title;
  ui.tabTitle.title = title;
  if (!showingTarget && activeTab?.favIconUrl) ui.favicon.src = activeTab.favIconUrl;
  ui.favicon.hidden = showingTarget || !activeTab?.favIconUrl;

  switch (s.phase) {
    case 'idle': {
      show('idle');
      const reason = unrecordableReason(activeTab);
      ui.start.disabled = !!reason;
      ui.unrecordable.hidden = !reason;
      ui.unrecordable.textContent = reason ?? '';
      ui.saveTo.textContent = saveToText;
      ui.pending.hidden = pendingCount === 0;
      ui.pending.textContent = `有 ${pendingCount} 個未完成的錄製，按此修復`;
      showNotice(undefined);
      break;
    }
    case 'recording':
    case 'paused':
      show('rec');
      ui.size.textContent = `已寫入 ${formatBytes(s.bytesWritten)}`;
      ui.recTitle.textContent = '';
      ui.pause.textContent = s.phase === 'paused' ? '繼續' : '暫停';
      ui.gotoTab.hidden = s.targetTabId === activeTab?.id;
      if (s.attention) {
        showNotice(`${s.attention}：請按「顯示錄製視窗」，在視窗裡點提示授權。`);
      } else if (s.audioPlaybackBlocked) {
        showNotice('瀏覽器暫停了課程聲音的回放（錄音不受影響）。請按「顯示錄製視窗」，在視窗裡點一下提示即可恢復。');
      } else {
        showNotice(s.warning);
      }
      break;
    case 'starting':
    case 'stopping':
      show('busy');
      ui.busyView.textContent = s.phase === 'starting' ? '正在啟動錄製…' : '正在存檔，請稍候（大檔案可能需要數秒）…';
      showNotice(undefined);
      break;
    case 'error':
      show('error');
      showNotice(s.lastError ?? '發生未知錯誤', true);
      break;
  }

  renderMic();

  const last = s.lastRecording;
  ui.last.hidden = !last || s.phase !== 'idle';
  if (last) {
    ui.last.textContent =
      `上次存檔：${last.location ? `「${last.location}」／` : ''}${last.parts && last.parts > 1 ? `共 ${last.parts} 個檔案，最後一段 ` : ''}${last.fileName}（${formatDuration(last.durationMs)}，${formatBytes(last.bytes)}）` +
      (last.fallbackReason ? ` — 無法存到指定資料夾（${last.fallbackReason}），已改存到下載資料夾` : '') +
      (last.durationFixed ? '' : ' — 注意：時長資訊未寫入');
  }
}

function renderMic(): void {
  const s = state;
  const recording = s.phase === 'recording' || s.phase === 'paused';
  ui.micRow.hidden = !(s.phase === 'idle' || recording);
  const wanted = recording ? s.micOn : micAtStart;
  ui.micToggle.checked = wanted;
  ui.micLabel.textContent = recording ? '混入我的麥克風（即時切換）' : '開始時混入我的麥克風';
  const needsGrant = micPerm !== 'granted';
  let hint = '';
  if (recording && s.micError) hint = s.micError;
  else if ((wanted || (recording && s.micError)) && needsGrant) hint = '尚未授權麥克風。';
  else if (wanted) hint = '建議戴耳機，避免課程聲音經由麥克風被重複錄進去。';
  ui.micHint.hidden = !hint;
  ui.micHint.textContent = hint;
  ui.openOptions.hidden = !(needsGrant && (wanted || !!s.micError));
}

ui.micToggle.onchange = async () => {
  const on = ui.micToggle.checked;
  if (state.phase === 'recording' || state.phase === 'paused') {
    await command({ to: 'background', type: 'SET_MIC', enabled: on });
  } else {
    micAtStart = on;
    await saveSettings({ micOnAtStart: on });
    renderMic();
  }
};
ui.openOptions.onclick = () => chrome.runtime.openOptionsPage();
ui.settings.onclick = () => chrome.runtime.openOptionsPage();
ui.pending.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#recovery') });

ui.start.onclick = async () => {
  if (!activeTab?.id) return;
  ui.start.disabled = true;
  await command({
    to: 'background',
    type: 'START',
    tabId: activeTab.id,
    tabTitle: activeTab.title ?? '',
    micOn: micAtStart,
  });
};
ui.pause.onclick = () => command({ to: 'background', type: state.phase === 'paused' ? 'RESUME' : 'PAUSE' });
ui.stop.onclick = () => command({ to: 'background', type: 'STOP' });
ui.showRecorder.onclick = () => command({ to: 'background', type: 'SHOW_RECORDER' });
ui.ackError.onclick = () => command({ to: 'background', type: 'ACK_ERROR' });
ui.gotoTab.onclick = async () => {
  if (state.targetTabId === undefined) return;
  const tab = await chrome.tabs.update(state.targetTabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
};

async function init(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await loadSettings();
  micAtStart = settings.micOnAtStart;
  saveToText = await describeSaveTarget(settings);
  pendingCount = (await listPending()).length;
  micPerm = await micPermission();
  state = await getState();
  render();
  onStateChanged((s) => {
    state = s;
    render();
  });
  setInterval(renderTimer, 500);
}

void init();
