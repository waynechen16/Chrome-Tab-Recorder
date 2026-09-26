/** Recording settings. M1 uses fixed defaults; the Options page arrives in M3. */
export interface Settings {
  maxWidth: number;
  maxHeight: number;
  fps: number;
  /** Preferred video codec; falls back to VP8 when unsupported. */
  videoCodec: 'vp9' | 'vp8';
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  /** Minimise the recorder window once recording has started. */
  autoMinimize: boolean;
  /** Tokens: {title} {date} {time}. `.webm` is appended. */
  fileNameTemplate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  maxWidth: 1920,
  maxHeight: 1080,
  fps: 30,
  videoCodec: 'vp9',
  videoBitsPerSecond: 4_000_000,
  audioBitsPerSecond: 128_000,
  autoMinimize: true,
  fileNameTemplate: '{title}_{date}_{time}',
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...stored };
}
