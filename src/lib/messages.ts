/**
 * Every cross-component message. All go through chrome.runtime.sendMessage;
 * `to` says who should handle it, because runtime messages reach every
 * extension page (popup, recorder window) as well as the service worker.
 */
import type { Settings } from './settings';

export type Phase = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error';

export type ErrorCode =
  | 'CAPTURE_FAILED'
  | 'MIC_FAILED'
  | 'SINK_OPEN_FAILED'
  | 'WRITE_FAILED'
  | 'FINALIZE_FAILED'
  | 'ALREADY_RECORDING'
  | 'NOT_RECORDABLE'
  | 'LOW_DISK'
  | 'RECORDER_CLOSED';

/** popup → background */
export type PopupCommand =
  | { to: 'background'; type: 'START'; tabId: number; tabTitle: string; micOn: boolean }
  | { to: 'background'; type: 'STOP' }
  | { to: 'background'; type: 'PAUSE' }
  | { to: 'background'; type: 'RESUME' }
  | { to: 'background'; type: 'SHOW_RECORDER' }
  | { to: 'background'; type: 'SET_MIC'; enabled: boolean }
  | { to: 'background'; type: 'ACK_ERROR' };

/** background → recorder */
export type RecorderCommand =
  | { to: 'recorder'; type: 'STOP' }
  | { to: 'recorder'; type: 'PAUSE' }
  | { to: 'recorder'; type: 'RESUME' }
  | { to: 'recorder'; type: 'SET_MIC'; enabled: boolean };

/** recorder → background */
export type RecorderEvent =
  | { to: 'background'; type: 'RECORDER_READY' }
  | {
      to: 'background';
      type: 'STATUS';
      phase: Phase;
      bytesWritten: number;
      /** Active (un-paused) recording time so far. */
      elapsedMs: number;
      audioPlaybackBlocked: boolean;
      micOn: boolean;
      /** Why the mic is off although the user asked for it (cleared on success). */
      micError?: string;
      warning?: string;
    }
  | { to: 'background'; type: 'DONE'; fileName: string; bytes: number; durationMs: number; durationFixed: boolean }
  | { to: 'background'; type: 'ERROR'; code: ErrorCode; message: string };

export type BackgroundMessage = PopupCommand | RecorderEvent;

/** Response to RECORDER_READY: everything the recorder needs to start. */
export type InitResponse =
  | { ok: true; streamId: string; tabId: number; tabTitle: string; micOn: boolean; settings: Settings }
  | { ok: false; code: ErrorCode; message: string };

export type CommandResponse = { ok: true } | { ok: false; code: ErrorCode; message: string };

/** sendMessage that swallows "Receiving end does not exist" when nobody listens. */
export async function send<T = unknown>(msg: BackgroundMessage | RecorderCommand): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T;
  } catch (e) {
    const text = String((e as Error)?.message ?? e);
    if (text.includes('Receiving end does not exist') || text.includes('message port closed')) return undefined;
    throw e;
  }
}
