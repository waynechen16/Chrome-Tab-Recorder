/**
 * Recorder window — the recording engine (plan §2, §5).
 * Opened by the service worker, unfocused, then auto-minimised.
 */
import { AudioGraph } from '@/lib/audio-graph';
import { captureSize, getTabStream } from '@/lib/capture';
import { buildFileName, partFileName } from '@/lib/filename';
import { logEvent } from '@/lib/error-log';
import { addPending, removePending } from '@/lib/pending';
import { FAVICON, TITLE_PREFIX } from '@/lib/indicator';
import { micErrorMessage, micPermission } from '@/lib/mic';
import { send, type ErrorCode, type InitResponse, type Phase, type RecorderCommand } from '@/lib/messages';
import { TabRecorder } from '@/lib/recorder';
import type { Settings } from '@/lib/settings';
import { formatBytes, formatDuration } from '@/lib/state';
import { getSaveDirectory, requestSaveDirectoryPermission, saveDirectoryPermission } from '@/lib/storage/handle-store';
import { OpfsSink, type ExportResult, type ExportTarget } from '@/lib/storage/sink';

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
  mic: $<HTMLButtonElement>('mic'),
  micLevel: $('micLevel'),
  micNote: $('micNote'),
  folderNote: $('folderNote'),
  favicon: $<HTMLLinkElement>('favicon'),
};

/** One output file. Without auto-segmenting there is exactly one. */
interface Part {
  index: number;
  sink: OpfsSink;
  recorder: TabRecorder;
  bytes: number;
}

let phase: Phase = 'starting';
let warning: string | undefined;
let current: Part | undefined;
let graph: AudioGraph | undefined;
let stream: MediaStream | undefined;
let recStream: MediaStream | undefined;
let settings: Settings | undefined;
let baseFileName = '';
let tabTitle = '';
let segmentMs = 0;
/** Active time and bytes of parts already handed off for export. */
let completedMs = 0;
let completedBytes = 0;
/** Exports of earlier parts still running in the background. */
const exporting = new Set<Promise<void>>();
const savedParts: ExportResult[] = [];
let rotating = false;
let videoTrackRef: MediaStreamTrack | undefined;
/** Encoded frames of parts already handed off; null once any part could not be counted. */
let completedFrames: number | null = 0;
interface FpsSample { activeMs: number; frames: number | null; delivered: number | null }
const fpsSamples: FpsSample[] = [];
let encodedFps: number | null = null;
let capturedFps: number | null = null;
let slowStreak = 0;
let slowLogged = false;
let stopping: Promise<void> | undefined;
let micError: string | undefined;
let micDeviceId = '';
let saveDir: FileSystemDirectoryHandle | undefined;
let attention: string | undefined;

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

const elapsedTotal = () => completedMs + (current?.recorder.elapsedMs() ?? 0);
const bytesTotal = () => completedBytes + (current?.bytes ?? 0);
const framesTotal = (): number | null => {
  const f = current?.recorder.videoFrames;
  return completedFrames === null || f === null || f === undefined ? null : completedFrames + f;
};

/** Frames delivered by tab capture (Chrome's MediaStreamTrack.stats), if available. */
function deliveredFrames(): number | null {
  const stats = (videoTrackRef as unknown as { stats?: { deliveredFrames?: number } } | undefined)?.stats;
  return typeof stats?.deliveredFrames === 'number' ? stats.deliveredFrames : null;
}

/**
 * Rolling fps over ~10 s of active recording. Tab capture only sends frames
 * when the page changes, so a low number alone is normal for static slides;
 * only encoded ≪ captured means the computer cannot keep up.
 */
function sampleFps(): void {
  if (phase !== 'recording') {
    fpsSamples.length = 0;
    encodedFps = capturedFps = null;
    return;
  }
  fpsSamples.push({ activeMs: elapsedTotal(), frames: framesTotal(), delivered: deliveredFrames() });
  while (fpsSamples.length > 6) fpsSamples.shift();
  const a = fpsSamples[0]!;
  const b = fpsSamples[fpsSamples.length - 1]!;
  const secs = (b.activeMs - a.activeMs) / 1000;
  if (secs < 4) return;
  encodedFps = a.frames !== null && b.frames !== null ? Math.max(0, (b.frames - a.frames) / secs) : null;
  capturedFps = a.delivered !== null && b.delivered !== null ? Math.max(0, (b.delivered - a.delivered) / secs) : null;
  const slow = encodedFps !== null && capturedFps !== null && capturedFps > 5 && encodedFps < capturedFps * 0.85;
  slowStreak = slow ? slowStreak + 1 : 0;
  if (slowStreak >= 3) {
    warning = `電腦來不及編碼（實際 ${encodedFps!.toFixed(0)} fps／擷取 ${capturedFps!.toFixed(0)} fps），影片可能不順。建議到設定改用 VP8，或降低解析度、幀率。`;
    if (!slowLogged) {
      slowLogged = true;
      void logEvent('warn', 'ENCODER_SLOW', warning);
    }
  }
}
const openFiles = () => [...(current ? [current.sink.fileName] : []), ...exportingNames];
const exportingNames = new Set<string>();

function render(): void {
  const elapsed = elapsedTotal();
  ui.phase.textContent = PHASE_LABEL[phase];
  ui.timer.textContent = formatDuration(elapsed);
  ui.size.textContent = formatBytes(bytesTotal()) + (current && current.index > 1 ? `（第 ${current.index} 段）` : '');
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
  renderMic();
}

function renderMic(): void {
  const on = graph?.micEnabled ?? false;
  const active = phase === 'recording' || phase === 'paused';
  ui.mic.disabled = !active;
  ui.mic.textContent = on ? '麥克風：開' : '麥克風：關';
  ui.mic.classList.toggle('on', on);
  ui.micNote.hidden = !micError;
  ui.micNote.textContent = micError ?? '';
}

async function report(): Promise<void> {
  await send({
    to: 'background',
    type: 'STATUS',
    phase,
    bytesWritten: bytesTotal(),
    elapsedMs: elapsedTotal(),
    audioPlaybackBlocked: graph ? !graph.running : false,
    micOn: graph?.micEnabled ?? false,
    micError,
    warning,
    attention,
    openFiles: [...openFiles()],
    part: current?.index ?? 1,
    encodedFps,
    capturedFps,
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
  const salvage = current && phase !== 'starting' && !stopping;
  phase = 'error';
  render();
  await send({ to: 'background', type: 'ERROR', code, message });
  void logEvent('error', code, message);
  if (salvage && code !== 'WRITE_FAILED') {
    // Try to still save what was recorded.
    await finish().catch((e) => console.error('Salvage failed', e));
  } else {
    await teardown();
    await current?.sink.closeOnly();
  }
  setTimeout(() => window.close(), 8000);
}

async function teardown(): Promise<void> {
  stream?.getTracks().forEach((t) => t.stop());
  await graph?.close().catch(() => undefined);
}

const exportTarget = (): ExportTarget => (saveDir ? { kind: 'directory', handle: saveDir } : { kind: 'downloads' });

/** Stop a part's recorder, fix its Duration and export it. */
async function closePart(part: Part): Promise<{ result: ExportResult; durationMs: number; durationFixed: boolean }> {
  const { durationMs, durationFixed } = await part.recorder.stop();
  const result = await part.sink.finalize(exportTarget());
  await removePending(part.sink.fileName);
  part.sink.terminate();
  if (result.fallbackReason) void logEvent('warn', 'FOLDER_FALLBACK', `${result.fileName}：${result.fallbackReason}`);
  return { result, durationMs, durationFixed };
}

async function openPart(index: number): Promise<Part> {
  const name = segmentMs > 0 ? partFileName(baseFileName, index) : baseFileName;
  const sink = new OpfsSink();
  await sink.open(name);
  await addPending(name, { title: tabTitle, startedAt: Date.now(), part: segmentMs > 0 ? index : undefined });
  const part: Part = { index, sink, bytes: 0, recorder: undefined as unknown as TabRecorder };
  part.recorder = new TabRecorder(recStream!, settings!, sink, {
    onBytes: (total) => {
      part.bytes = total;
    },
    onError: (err) => {
      if (part === current) void fail('WRITE_FAILED', `寫入失敗：${err.message}`);
      else void logEvent('error', 'WRITE_FAILED', `第 ${part.index} 段：${err.message}`);
    },
    onStall: (gap) => {
      warning = `錄製中斷約 ${Math.round(gap / 1000)} 秒（系統休眠？），影片在該處會有跳躍`;
      void logEvent('warn', 'STALL', warning);
      void report();
    },
  });
  return part;
}

/**
 * Seamless segment switch: start the next file's recorder first, then stop
 * the old one, so there is a few-ms overlap rather than a gap. The old part
 * is exported in the background while recording continues.
 */
async function rotate(): Promise<void> {
  if (!current || rotating || phase !== 'recording') return;
  rotating = true;
  const old = current;
  try {
    const next = await openPart(old.index + 1);
    await next.recorder.start();
    completedMs += old.recorder.elapsedMs();
    completedBytes += old.bytes;
    const oldFrames = old.recorder.videoFrames;
    completedFrames = completedFrames === null || oldFrames === null ? null : completedFrames + oldFrames;
    current = next;
    exportingNames.add(old.sink.fileName);
    const job = closePart(old)
      .then(({ result }) => {
        savedParts[old.index - 1] = result;
        void send({ to: 'background', type: 'PART_SAVED', part: old.index, fileName: result.fileName, location: result.location, fallbackReason: result.fallbackReason });
      })
      .catch((e) => {
        const message = `第 ${old.index} 段存檔失敗：${(e as Error).message}（內容仍保留，可到設定頁修復）`;
        void logEvent('error', 'FINALIZE_FAILED', message);
        void send({ to: 'background', type: 'PART_FAILED', part: old.index, message });
      })
      .finally(() => {
        exportingNames.delete(old.sink.fileName);
        exporting.delete(job);
      });
    exporting.add(job);
  } catch (e) {
    void logEvent('error', 'SEGMENT_FAILED', `無法切換到下一段：${(e as Error).message}，繼續錄在同一個檔案`);
  } finally {
    rotating = false;
  }
}

/** Stop recording, fix Duration, export the file(s), report DONE. */
function finish(): Promise<void> {
  stopping ??= (async () => {
    if (!current) return;
    if (phase !== 'error') setPhase('stopping');
    const last = current;
    let closed: Awaited<ReturnType<typeof closePart>>;
    try {
      const { durationMs, durationFixed } = await last.recorder.stop();
      await teardown();
      await Promise.allSettled([...exporting]);
      const result = await last.sink.finalize(exportTarget());
      await removePending(last.sink.fileName);
      closed = { result, durationMs, durationFixed };
    } catch (e) {
      await fail('FINALIZE_FAILED', `存檔失敗：${(e as Error).message}。錄製內容仍保留，可到設定頁「未完成的錄製」修復。`);
      return;
    }
    const { result } = closed;
    savedParts[last.index - 1] = result;
    const totalMs = completedMs + closed.durationMs;
    const lastFrames = last.recorder.videoFrames;
    const allFrames = completedFrames === null || lastFrames === null ? null : completedFrames + lastFrames;
    const avgFps = allFrames !== null && totalMs > 0 ? Math.round((allFrames / (totalMs / 1000)) * 10) / 10 : null;
    const totalBytes = completedBytes + result.bytes;
    const fallbackReason = savedParts.find((p) => p?.fallbackReason)?.fallbackReason;
    if (result.fallbackReason) void logEvent('warn', 'FOLDER_FALLBACK', `${result.fileName}：${result.fallbackReason}`);
    await send({
      to: 'background',
      type: 'DONE',
      ...result,
      bytes: totalBytes,
      durationMs: totalMs,
      durationFixed: closed.durationFixed,
      fallbackReason,
      parts: last.index,
      avgFps,
      targetFps: settings?.fps ?? 30,
    });
    phase = 'idle';
    render();
    showNotice(
      fallbackReason
        ? `無法存到資料夾（${fallbackReason}），已改存到下載資料夾：${result.fileName}`
        : last.index > 1
          ? `已存到「${result.location}」：共 ${last.index} 個檔案`
          : `已存到「${result.location}」：${result.fileName}`,
    );
    last.sink.terminate();
    setTimeout(() => window.close(), 1500);
  })();
  return stopping;
}

/**
 * Switch the mic. From a background command the window may be minimised, so
 * we never trigger a permission prompt there (it would be invisible and hang);
 * a click inside this window may prompt because the user can see it.
 */
async function applyMic(on: boolean, allowPrompt = false): Promise<void> {
  if (!graph) return;
  try {
    if (on) {
      const perm = await micPermission();
      if (perm === 'denied' || (perm !== 'granted' && !allowPrompt)) throw new Error('NOT_GRANTED');
    }
    await graph.setMic(on, micDeviceId);
    micError = undefined;
  } catch (e) {
    micError = micErrorMessage(e);
    console.warn('Mic:', e);
  }
  renderMic();
  void report();
}

function onCommand(msg: RecorderCommand): void {
  if (msg.to !== 'recorder' || !current) return;
  const recorder = current.recorder;
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
    case 'SET_MIC':
      if (phase === 'recording' || phase === 'paused') void applyMic(msg.enabled);
      break;
    case 'SET_MIC_GAIN':
      graph?.setMicVolume(msg.gain);
      break;
  }
}

/**
 * If the user chose a save folder, make sure we can write to it. Permission
 * can lapse after a browser restart; re-granting needs a click in a visible
 * page, so we ask here (the window stays un-minimised until resolved).
 */
async function prepareSaveFolder(location: string): Promise<void> {
  if (location !== 'directory') return;
  saveDir = await getSaveDirectory();
  if (!saveDir) {
    warning = '找不到設定的儲存資料夾，這次會存到下載資料夾。請到設定頁重新選擇。';
    return;
  }
  if ((await saveDirectoryPermission(saveDir)) === 'granted') return;
  const dir = saveDir;
  attention = `需要重新授權寫入資料夾「${dir.name}」`;
  ui.folderNote.hidden = false;
  ui.folderNote.textContent = `點這裡授權寫入「${dir.name}」（不授權的話，錄影會改存到下載資料夾）`;
  ui.folderNote.onclick = async () => {
    if ((await requestSaveDirectoryPermission(dir)) === 'granted') {
      attention = undefined;
      ui.folderNote.hidden = true;
      void report();
    }
  };
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
  const { streamId } = init;
  settings = init.settings;
  tabTitle = init.tabTitle;
  micDeviceId = settings.micDeviceId;
  const debug = (await chrome.storage.local.get('debugSegmentSeconds')).debugSegmentSeconds as number | undefined;
  segmentMs = debug ? debug * 1000 : settings.segmentMinutes * 60_000;
  ui.target.textContent = tabTitle;
  ui.target.title = tabTitle;

  try {
    await checkDisk();
  } catch (e) {
    return fail('LOW_DISK', (e as Error).message);
  }

  await prepareSaveFolder(settings.saveLocation);

  try {
    const size = captureSize(settings, init.tabSize, window.devicePixelRatio || 1);
    stream = await getTabStream(streamId, size, settings.fps);
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
  recStream = new MediaStream([videoTrack, ...(audioTrack ? [audioTrack] : [])]);
  videoTrackRef = videoTrack;
  if (!audioOk) {
    showNotice('瀏覽器暫停了聲音回放：點這裡恢復課程聲音（錄音不受影響）', 'warn', async () => {
      if (await graph?.resume()) {
        hideNotice();
        void report();
      }
    });
  }
  graph.setMicVolume(settings.micGain);
  graph.onStateChange(() => void report());
  graph.onMicLost = () => {
    micError = '麥克風裝置已中斷連線，已自動關閉。重新接上後可再打開。';
    renderMic();
    void report();
  };

  baseFileName = buildFileName(settings.fileNameTemplate, tabTitle, new Date());
  try {
    current = await openPart(1);
  } catch (e) {
    await teardown();
    return fail('SINK_OPEN_FAILED', `無法建立暫存檔：${(e as Error).message}`);
  }

  // Target tab closed or navigated away from capture → stop and save.
  videoTrack.addEventListener('ended', () => void finish());

  await current.recorder.start();
  setPhase('recording');
  if (init.micOn) await applyMic(true);

  setInterval(() => {
    sampleFps();
    render();
    if (phase === 'recording' || phase === 'paused') void report();
  }, STATUS_INTERVAL_MS);
  if (segmentMs > 0) {
    // Checked often so segments end close to the configured length.
    setInterval(() => {
      if (current && current.recorder.elapsedMs() >= segmentMs) void rotate();
    }, 250);
  }
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    ui.level.style.width = `${Math.round((graph?.level() ?? 0) * 100)}%`;
    ui.micLevel.style.width = `${Math.round((graph?.micLevel() ?? 0) * 100)}%`;
    render();
  }, 250);
}

ui.pause.onclick = () => onCommand({ to: 'recorder', type: phase === 'paused' ? 'RESUME' : 'PAUSE' });
ui.stop.onclick = () => void finish();
ui.mic.onclick = () => void applyMic(!(graph?.micEnabled ?? false), true);
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
