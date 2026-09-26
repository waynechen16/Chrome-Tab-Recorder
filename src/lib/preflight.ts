/**
 * Pre-class check (M5): everything we can verify before a real recording,
 * without capturing a tab. `evaluatePreflight` is pure so it can be tested;
 * `collectPreflightInputs` gathers the facts in an extension page.
 */
import type { Settings } from './settings';

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';

export interface CheckItem {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface PreflightInputs {
  chromeMajor: number | null;
  cpuCores: number;
  /** navigator.deviceMemory (GB, coarse) if available. */
  memoryGB: number | null;
  supports: { vp9: boolean; vp8: boolean };
  /** Free bytes available to the extension's storage. */
  freeBytes: number | null;
  settings: Settings;
  folder: 'downloads' | 'granted' | 'prompt' | 'denied' | 'missing';
  mic: 'granted' | 'denied' | 'prompt' | 'unknown';
  pendingCount: number;
}

const GB = 1024 ** 3;

/** Bytes per hour at the configured bitrates. */
export function bytesPerHour(s: Pick<Settings, 'videoBitsPerSecond' | 'audioBitsPerSecond'>): number {
  return ((s.videoBitsPerSecond + s.audioBitsPerSecond) / 8) * 3600;
}

export function evaluatePreflight(i: PreflightInputs): CheckItem[] {
  const items: CheckItem[] = [];
  const s = i.settings;

  // Chrome version
  if (i.chromeMajor === null) {
    items.push({ id: 'chrome', level: 'info', title: 'Chrome 版本', detail: '無法判斷版本。' });
  } else if (i.chromeMajor < 116) {
    items.push({ id: 'chrome', level: 'fail', title: 'Chrome 版本', detail: `目前是 ${i.chromeMajor}，需要 116 以上，請更新 Chrome。` });
  } else {
    items.push({ id: 'chrome', level: 'ok', title: 'Chrome 版本', detail: `Chrome ${i.chromeMajor}` });
  }

  // Codec
  const want = s.videoCodec;
  if (!i.supports.vp9 && !i.supports.vp8) {
    items.push({ id: 'codec', level: 'fail', title: '影像編碼', detail: '這個 Chrome 不支援 WebM 錄製。' });
  } else if (!i.supports[want]) {
    items.push({ id: 'codec', level: 'warn', title: '影像編碼', detail: `不支援 ${want.toUpperCase()}，會自動改用 ${want === 'vp9' ? 'VP8' : 'VP9'}。` });
  } else {
    items.push({ id: 'codec', level: 'ok', title: '影像編碼', detail: `${want.toUpperCase()} + Opus` });
  }

  // CPU load estimate for software VP9/VP8 encoding
  const heavy =
    (s.videoCodec === 'vp9' && (s.resolution === '2160p' || s.resolution === '1440p' || s.resolution === 'tab' || s.fps >= 60)) ||
    s.fps >= 60;
  const cores = i.cpuCores;
  if (cores > 0 && cores <= 4 && (heavy || (s.videoCodec === 'vp9' && s.resolution === '1080p' && s.fps >= 30))) {
    items.push({
      id: 'cpu',
      level: 'warn',
      title: 'CPU 負擔',
      detail: `${cores} 核心的電腦用目前設定錄製可能讓 Meet 變卡。建議改 VP8，或 720p／15 fps。`,
    });
  } else if (heavy) {
    items.push({
      id: 'cpu',
      level: 'info',
      title: 'CPU 負擔',
      detail: `目前設定（${s.resolution === 'tab' ? '跟隨分頁' : s.resolution}／${s.fps} fps／${s.videoCodec.toUpperCase()}）較吃 CPU，第一次使用請留意 Meet 是否變卡。`,
    });
  } else {
    items.push({ id: 'cpu', level: 'ok', title: 'CPU 負擔', detail: cores > 0 ? `${cores} 核心，目前設定應可負荷。` : '目前設定屬輕量。' });
  }

  // Disk
  const perHour = bytesPerHour(s);
  if (i.freeBytes === null) {
    items.push({ id: 'disk', level: 'info', title: '可用空間', detail: '無法取得可用空間。' });
  } else {
    // During export the OPFS copy and the exported file coexist briefly, so budget 2×.
    const hours = i.freeBytes / (perHour * 2);
    const free = `${(i.freeBytes / GB).toFixed(1)} GB`;
    if (hours < 1) {
      items.push({ id: 'disk', level: 'fail', title: '可用空間', detail: `剩 ${free}，不足以錄 1 小時（每小時約 ${(perHour / GB).toFixed(1)} GB，存檔時需約兩倍空間）。` });
    } else if (hours < 3) {
      items.push({ id: 'disk', level: 'warn', title: '可用空間', detail: `剩 ${free}，約可錄 ${hours.toFixed(1)} 小時。長課程建議先清出空間或降低位元率。` });
    } else {
      items.push({ id: 'disk', level: 'ok', title: '可用空間', detail: `剩 ${free}，約可錄 ${Math.floor(hours)} 小時以上。` });
    }
  }

  // Save location
  const folderDetail = {
    downloads: ['ok', '存到 Chrome 的下載資料夾。'],
    granted: ['ok', `存到「${s.directoryName}」，已授權寫入。`],
    prompt: ['warn', `存到「${s.directoryName}」，但需要重新授權；請按下方「重新授權」，或開始錄製時在錄製視窗點一下。`],
    denied: ['warn', `沒有寫入「${s.directoryName}」的權限，錄影會改存到下載資料夾。`],
    missing: ['warn', '找不到設定的資料夾，錄影會改存到下載資料夾。請重新選擇資料夾。'],
  }[i.folder] as [CheckLevel, string];
  items.push({ id: 'folder', level: folderDetail[0], title: '儲存位置', detail: folderDetail[1] });

  // Microphone (only matters if the user wants it at start)
  if (s.micOnAtStart) {
    if (i.mic === 'granted') items.push({ id: 'mic', level: 'ok', title: '麥克風', detail: '已授權，開始錄製時會混入麥克風。' });
    else items.push({ id: 'mic', level: 'warn', title: '麥克風', detail: '已設定開始時混入麥克風，但尚未授權。請按下方「授權並測試麥克風」。' });
  } else {
    items.push({
      id: 'mic',
      level: 'info',
      title: '麥克風',
      detail: i.mic === 'granted' ? '已授權；開始時不混入，錄製中可隨時打開。' : '開始時不混入。若課堂中想錄自己的聲音，請先授權。',
    });
  }

  // Long recordings
  items.push(
    s.segmentMinutes > 0
      ? { id: 'segment', level: 'ok', title: '自動分段', detail: `每 ${s.segmentMinutes} 分鐘一個檔案。` }
      : { id: 'segment', level: 'info', title: '自動分段', detail: '未開啟。超過 2 小時的課程建議開啟 60 分鐘分段，降低當機時的損失。' },
  );

  // Unfinished recordings
  if (i.pendingCount > 0) {
    items.push({ id: 'pending', level: 'warn', title: '未完成的錄製', detail: `有 ${i.pendingCount} 筆未完成的錄製佔用空間，可在上方修復或刪除。` });
  }

  return items;
}

export function overallLevel(items: CheckItem[]): CheckLevel {
  if (items.some((x) => x.level === 'fail')) return 'fail';
  if (items.some((x) => x.level === 'warn')) return 'warn';
  return 'ok';
}

/** Chrome major version from the user agent. */
export function chromeMajorFromUA(ua: string): number | null {
  const m = /Chrome\/(\d+)/.exec(ua);
  return m ? Number(m[1]) : null;
}
