/**
 * Recording state — single source of truth, kept in chrome.storage.session so
 * it survives the service worker being shut down. The popup subscribes via
 * chrome.storage.onChanged.
 */
import type { Phase } from './messages';

export interface LastRecording {
  fileName: string;
  bytes: number;
  durationMs: number;
  finishedAt: number;
  durationFixed: boolean;
  savedTo?: 'downloads' | 'directory';
  location?: string;
  fallbackReason?: string;
  parts?: number;
  avgFps?: number | null;
  targetFps?: number;
}

export interface RecordingState {
  phase: Phase;
  targetTabId?: number;
  targetTitle?: string;
  recorderWindowId?: number;
  /** Active (un-paused) recording time reported by the recorder… */
  elapsedMs: number;
  /** …as of this epoch ms. The popup extrapolates while recording. */
  elapsedAt?: number;
  bytesWritten: number;
  audioPlaybackBlocked: boolean;
  /** Mic state: requested at START, then as reported by the recorder. */
  micOn: boolean;
  micError?: string;
  warning?: string;
  attention?: string;
  /** OPFS files the recorder still has open. */
  openFiles?: string[];
  /** Current segment number (1-based). */
  part?: number;
  encodedFps?: number | null;
  capturedFps?: number | null;
  targetFps?: number;
  lastError?: string;
  lastRecording?: LastRecording;
}

export const INITIAL_STATE: RecordingState = {
  phase: 'idle',
  elapsedMs: 0,
  bytesWritten: 0,
  audioPlaybackBlocked: false,
  micOn: false,
};

const TRANSITIONS: Record<Phase, Phase[]> = {
  idle: ['starting'],
  starting: ['recording', 'error', 'idle'],
  recording: ['paused', 'stopping', 'error'],
  paused: ['recording', 'stopping', 'error'],
  stopping: ['idle', 'error'],
  error: ['idle'],
};

export function canTransition(from: Phase, to: Phase): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** Elapsed active recording time at `now`, excluding pauses. */
export function elapsedMs(s: RecordingState, now: number): number {
  if (s.phase !== 'recording' || s.elapsedAt === undefined) return s.elapsedMs;
  return s.elapsedMs + Math.max(0, now - s.elapsedAt);
}

const KEY = 'recordingState';

export async function getState(): Promise<RecordingState> {
  const stored = (await chrome.storage.session.get(KEY))[KEY] as RecordingState | undefined;
  return { ...INITIAL_STATE, ...stored };
}

export async function setState(patch: Partial<RecordingState>): Promise<RecordingState> {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ [KEY]: next });
  return next;
}

export async function resetState(keep: Partial<RecordingState> = {}): Promise<RecordingState> {
  const prev = await getState();
  const next: RecordingState = { ...INITIAL_STATE, lastRecording: prev.lastRecording, ...keep };
  await chrome.storage.session.set({ [KEY]: next });
  return next;
}

export function onStateChanged(cb: (s: RecordingState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[KEY]) cb({ ...INITIAL_STATE, ...(changes[KEY].newValue as RecordingState) });
  });
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
