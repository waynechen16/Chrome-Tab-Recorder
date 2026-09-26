/**
 * Recorder window — the recording engine (plan §2, §5).
 * Opened by the service worker, unfocused, then auto-minimised.
 */
import { AudioGraph } from '@/lib/audio-graph';
import { getTabStream } from '@/lib/capture';
import { buildFileName } from '@/lib/filename';
import { FAVICON, TITLE_PREFIX } from '@/lib/indicator';
import { send, type ErrorCode, type InitResponse, type Phase, type RecorderCommand } from '@/lib/messages';
import { TabRecorder } from '@/lib/recorder';
import { formatBytes, formatDuration } from '@/lib/state';
import { OpfsSink } from '@/lib/storage/sink';

const MIN_FREE_BYTES = 500 * 1024 ** 2;
const WARN_FREE_BYTES = 2 * 1024 ** 3;
const STATUS_INTERVAL_MS = 2000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  dot: $('dot'),
  phase: $('phase'),
  timer: $('timer'),
  target: $('target'),
  size: $('size'),
  level: $('level'),
  notice: $('notice'),
  pause: $<HTMLButtonElement>('pause'),
  stop: $<HTMLButtonElement>('stop'),
  minimize: $<HTMLButtonElement>('minimize'),
  favicon: $<HTMLLinkElement>('favicon'),
};

let phase: Phase = 'starting';
let bytesWritten = 0;
let warning: string | undefined;
let recorder: TabRecorder | undefined;
let graph: AudioGraph | undefined;
let stream: MediaStream | undefined;
let sink: OpfsSink | undefined;
let stopping: Promise<void> | undefined;

function showNotice(text: string, kind: 'warn' | 'error' = 'warn', onClick?: () => void): void {
  ui.notice.hidden = false;
  ui.notice.textContent = text;
  ui.notice.className = `notice${kind === 'error' ? ' error' : ''}${onClick ? ' clickable' : ''}`;
  ui.notice.onclick = onClick ?? null;
}

function hideNotice(): void {
  ui.notice.hidden = true;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '已結束',
  starting: '準備中…',
  recording: '錄製中',
  paused: '已暫停',
  stopping: '存檔中…',
  error: '發生錯誤',
};

function render(): void {
  const elapsed = recorder?.elapsedMs() ?? 0;
  ui.phase.textContent = PHASE_LABEL[phase];
  ui.timer.textContent = formatDuration(elapsed);
  ui.size.textContent = formatBytes(bytesWritten);
  ui.dot.className = `dot ${phase === 'recording' ? 'recording' : phase === 'paused' ? 'paused' : ''}`;
  ui.pause.disabled = !(phase === 'recording' || phase === 'paused');
  ui.pause.textContent = phase === 'paused' ? '繼續' : '暫停';
  ui.stop.disabled = !(phase === 'recording' || phase === 'paused');
  if (phase === 'recording' || phase === 'paused') {
    document.title = `${TITLE_PREFIX[phase].replace(' │ ', '')} ${formatDuration(elapsed)} — Tab Recorder`;
    ui.favicon.href = FAVICON[phase];
  } else {
    document.title = `${PHASE_LABEL[phase]} — Tab Recorder`;
    ui.favicon.href = '/icon/32.png';
  }
}

async function report(): Promise<void> {
  await send({
    to: 'background',
    type: 'STATUS',
    phase,
    bytesWritten,
    elapsedMs: recorder?.elapsedMs() ?? 0,
    audioPlaybackBlocked: graph ? !graph.running : false,
    warning,
  });
}

function setPhase(p: Phase): void {
  phase = p;
  render();
  void report();
}

async function fail(code: ErrorCode, message: string): Promise<void> {
  console.error(code, message);
  showNotice(message, 'error');
  // Salvage only if we were recording and not already inside finish().
  const salvage = recorder && phase !== 'starting' && !stopping;
  phase = 'error';
  render();
  await send({ to: 'background', type: 'ERROR', code, message });
  if (salvage && code !== 'WRITE_FAILED') {
    // Try to still save what was recorded.
    await finish().catch((e) => console.error('Salvage failed', e));
  } else {
    await teardown();
    await sink?.closeOnly();
  }
  setTimeout(() => window.close(), 8000);
}

async function teardown(): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  await graph?.close().catch(() => undefined);
}

/** Stop recording, fix Duration, export the file, report DONE. */
function finish(): Promise<void> {
  stopping ??= (async () => {
    if (!recorder || !sink) return;
    if (phase !== 'error') setPhase('stopping');
    const { durationMs, durationFixed } = await recorder.stop();
    await teardown();
    let result: { fileName: string; bytes: number };
    try {
      result = await sink.finalize();
    } catch (e) {
      await fail('FINALIZE_FAILED', `存檔失敗：${(e as Error).message}。錄製內容仍保留在 extension 儲存空間。`);
      return;
    }
    await send({ to: 'background', type: 'DONE', ...result, durationMs, durationFixed });
    phase = 'idle';
    render();
    showNotice(`已存檔：${result.fileName}`);
    sink.terminate();
    setTimeout(() => window.close(), 1500);
  })();
  return stopping;
}

function onCommand(msg: RecorderCommand): void {
  if (msg.to !== 'recorder' || !recorder) return;
  switch (msg.type) {
    case 'PAUSE':
      if (phase === 'recording') {
        recorder.pause();
        setPhase('paused');
      }
      break;
    case 'RESUME':
      if (phase === 'paused') {
        recorder.resume();
        setPhase('recording');
      }
      break;
    case 'STOP':
      void finish();
      break;
  }
}

async function checkDisk(): Promise<void> {
  const { quota = 0, usage = 0 } = await navigator.storage.estimate();
  const free = quota - usage;
  if (free < MIN_FREE_BYTES) throw Object.assign(new Error(`可用空間不足（剩 ${formatBytes(free)}）`), { code: 'LOW_DISK' });
  if (free < WARN_FREE_BYTES) warning = `可用空間僅剩 ${formatBytes(free)}，長時間錄製可能不足`;
}

async function main(): Promise<void> {
  render();
  chrome.runtime.onMessage.addListener((msg: RecorderCommand) => onCommand(msg));

  const init = await send<InitResponse>({ to: 'background', type: 'RECORDER_READY' });
  if (!init || !init.ok) {
    showNotice(init?.message ?? '無法取得錄製資訊', 'error');
    phase = 'error';
    render();
    setTimeout(() => window.close(), 5000);
    return;
  }
  const { streamId, tabTitle, settings } = init;
  ui.target.textContent = tabTitle;
  ui.target.title = tabTitle;

  try {
    await checkDisk();
  } catch (e) {
    return fail('LOW_DISK', (e as Error).message);
  }

  try {
    stream = await getTabStream(streamId, settings);
  } catch (e) {
    return fail('CAPTURE_FAILED', `無法擷取分頁：${(e as Error).message}`);
  }

  graph = new AudioGraph(stream);
  const audioOk = await graph.resume();
  const audioTrack = graph.recordingTrack();
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    await teardown();
    return fail('CAPTURE_FAILED', '擷取到的串流沒有影像軌');
  }
  const recStream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);
  if (!audioOk) {
    showNotice('瀏覽器暫停了聲音回放：點這裡恢復課程聲音（錄音不受影響）', 'warn', async () => {
      if (await graph?.resume()) {
        hideNotice();
        void report();
      }
    });
  }
  graph.onStateChange(() => void report());

  const fileName = buildFileName(settings.fileNameTemplate, tabTitle, new Date());
  sink = new OpfsSink();
  try {
    await sink.open(fileName);
  } catch (e) {
    await teardown();
    return fail('SINK_OPEN_FAILED', `無法建立暫存檔：${(e as Error).message}`);
  }

  recorder = new TabRecorder(recStream, settings, sink, {
    onBytes: (total) => {
      bytesWritten = total;
    },
    onError: (err) => void fail('WRITE_FAILED', `寫入失敗：${err.message}`),
    onStall: (gap) => {
      warning = `錄製中斷約 ${Math.round(gap / 1000)} 秒（系統休眠？），影片在該處會有跳躍`;
      void report();
    },
  });

  // Target tab closed or navigated away from capture → stop and save.
  videoTrack.addEventListener('ended', () => void finish());

  await recorder.start();
  setPhase('recording');

  setInterval(() => {
    render();
    if (phase === 'recording' || phase === 'paused') void report();
  }, STATUS_INTERVAL_MS);
  setInterval(() => {
    if (document.visibilityState === 'visible') ui.level.style.width = `${Math.round((graph?.level() ?? 0) * 100)}%`;
    if (document.visibilityState === 'visible') render();
  }, 250);
}

ui.pause.onclick = () => onCommand({ to: 'recorder', type: phase === 'paused' ? 'RESUME' : 'PAUSE' });
ui.stop.onclick = () => void finish();
ui.minimize.onclick = async () => {
  const win = await chrome.windows.getCurrent();
  if (win.id !== undefined) await chrome.windows.update(win.id, { state: 'minimized' });
};

window.addEventListener('beforeunload', (e) => {
  if (phase === 'recording' || phase === 'paused' || phase === 'stopping') {
    e.preventDefault();
    e.returnValue = '';
  }
});

void main();
