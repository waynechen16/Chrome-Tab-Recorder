/** User settings, stored in chrome.storage.local and edited on the Options page. */

export type Resolution = 'tab' | '2160p' | '1440p' | '1080p' | '720p';
export type SaveLocation = 'downloads' | 'directory';

export interface Settings {
  /** Output size limit; 'tab' follows the captured tab's own size (no upscaling). */
  resolution: Resolution;
  fps: 15 | 24 | 30 | 60;
  /** Preferred video codec; falls back to the other one when unsupported. */
  videoCodec: 'vp9' | 'vp8';
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** Minimise the recorder window once recording has started. */
  autoMinimize: boolean;
  /** Start a new file every N minutes of recording (0 = one file). */
  segmentMinutes: 0 | 30 | 60 | 120;
  /** Tokens: {title} {date} {time}. `.webm` is appended. */
  fileNameTemplate: string;
  /** Where finished recordings go. 'directory' uses the folder picked on the Options page. */
  saveLocation: SaveLocation;
  /** Display name of the picked folder (the handle itself lives in IndexedDB). */
  directoryName: string;
  /** Initial mic state when a recording starts (the popup toggle remembers it). */
  micOnAtStart: boolean;
  /** Preferred mic; empty = system default. */
  micDeviceId: string;
  /** Mic volume multiplier (1 = unchanged). A limiter prevents clipping when boosted. */
  micGain: number;
}

export const DEFAULT_SETTINGS: Settings = {
  resolution: '1080p',
  fps: 30,
  videoCodec: 'vp9',
  videoBitsPerSecond: 4_000_000,
  audioBitsPerSecond: 128_000,
  autoMinimize: true,
  segmentMinutes: 0,
  fileNameTemplate: '{title}_{date}_{time}',
  saveLocation: 'downloads',
  directoryName: '',
  micOnAtStart: false,
  micDeviceId: '',
  micGain: 1.5,
};

export const MIC_GAIN_MIN = 0.5;
export const MIC_GAIN_MAX = 4;

export const RESOLUTION_BOX: Record<Exclude<Resolution, 'tab'>, { width: number; height: number }> = {
  '2160p': { width: 3840, height: 2160 },
  '1440p': { width: 2560, height: 1440 },
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
};

export const CHOICES = {
  resolution: ['tab', '2160p', '1440p', '1080p', '720p'] as Resolution[],
  fps: [15, 24, 30, 60] as Settings['fps'][],
  videoCodec: ['vp9', 'vp8'] as Settings['videoCodec'][],
  videoBitsPerSecond: [2_000_000, 4_000_000, 6_000_000, 8_000_000, 12_000_000],
  audioBitsPerSecond: [96_000, 128_000, 192_000],
  segmentMinutes: [0, 30, 60, 120] as Settings['segmentMinutes'][],
};

/**
 * Merge stored values over defaults, dropping anything invalid (older
 * versions stored different keys, and storage can be edited by hand).
 */
export function normalizeSettings(stored: Record<string, unknown> | undefined): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!stored) return s;
  const pick = <K extends keyof Settings>(key: K, ok: (v: unknown) => boolean) => {
    if (ok(stored[key])) s[key] = stored[key] as Settings[K];
  };
  const oneOf = (list: readonly unknown[]) => (v: unknown) => list.includes(v);
  const bool = (v: unknown) => typeof v === 'boolean';
  const str = (v: unknown) => typeof v === 'string';
  pick('resolution', oneOf(CHOICES.resolution));
  pick('fps', oneOf(CHOICES.fps));
  pick('videoCodec', oneOf(CHOICES.videoCodec));
  pick('videoBitsPerSecond', (v) => typeof v === 'number' && v >= 500_000 && v <= 50_000_000);
  pick('audioBitsPerSecond', (v) => typeof v === 'number' && v >= 32_000 && v <= 512_000);
  pick('autoMinimize', bool);
  pick('segmentMinutes', oneOf(CHOICES.segmentMinutes));
  pick('fileNameTemplate', (v) => str(v) && (v as string).trim().length > 0);
  pick('saveLocation', oneOf(['downloads', 'directory']));
  pick('directoryName', str);
  pick('micOnAtStart', bool);
  pick('micDeviceId', str);
  pick('micGain', (v) => typeof v === 'number' && v >= MIC_GAIN_MIN && v <= MIC_GAIN_MAX);
  return s;
}

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Record<string, unknown> | undefined;
  return normalizeSettings(stored);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings(keep: Partial<Settings> = {}): Promise<Settings> {
  const next = normalizeSettings({ ...DEFAULT_SETTINGS, ...keep });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
