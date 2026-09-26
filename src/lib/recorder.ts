/**
 * MediaRecorder wrapper: 1-second chunks → Duration header rewrite → Sink.
 * Tracks active (un-paused) time for the final Duration value.
 */
import { DurationHeaderRewriter, encodeDurationValue } from './webm/duration-patch';
import type { Settings } from './settings';
import type { Sink } from './storage/sink';

export const TIMESLICE_MS = 1000;

export function pickMimeType(preferred: Settings['videoCodec']): string {
  const candidates =
    preferred === 'vp9'
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? 'video/webm';
}

export interface RecorderCallbacks {
  onBytes(total: number): void;
  onError(err: Error): void;
  /** Fired when the gap between chunks suggests the system slept. */
  onStall?(gapMs: number): void;
}

export class TabRecorder {
  private mr: MediaRecorder;
  private rewriter = new DurationHeaderRewriter();
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  private activeMs = 0;
  private segmentStart = 0;
  private lastChunkAt = 0;
  readonly mimeType: string;

  constructor(
    stream: MediaStream,
    settings: Settings,
    private sink: Sink,
    private cb: RecorderCallbacks,
  ) {
    this.mimeType = pickMimeType(settings.videoCodec);
    this.mr = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: settings.videoBitsPerSecond,
      audioBitsPerSecond: settings.audioBitsPerSecond,
    });
    this.mr.ondataavailable = (ev) => this.enqueue(ev.data);
    this.mr.onerror = (ev) => this.fail(new Error(`MediaRecorder error: ${(ev as ErrorEvent).message ?? 'unknown'}`));
  }

  get state(): RecordingState {
    return this.mr.state;
  }

  /** Resolves when MediaRecorder has actually started. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.mr.onstart = () => {
        this.segmentStart = performance.now();
        this.lastChunkAt = this.segmentStart;
        resolve();
      };
      this.mr.start(TIMESLICE_MS);
    });
  }

  pause(): void {
    if (this.mr.state !== 'recording') return;
    this.mr.pause();
    this.activeMs += performance.now() - this.segmentStart;
  }

  resume(): void {
    if (this.mr.state !== 'paused') return;
    this.mr.resume();
    this.segmentStart = performance.now();
    this.lastChunkAt = this.segmentStart;
  }

  elapsedMs(): number {
    return this.activeMs + (this.mr.state === 'recording' ? performance.now() - this.segmentStart : 0);
  }

  /**
   * Stop, drain every pending write, then patch the Duration.
   * Returns the duration and whether the header patch was applied.
   */
  async stop(): Promise<{ durationMs: number; durationFixed: boolean }> {
    if (this.mr.state !== 'inactive') {
      const stopped = new Promise<void>((r) => (this.mr.onstop = () => r()));
      if (this.mr.state === 'recording') this.activeMs += performance.now() - this.segmentStart;
      this.mr.stop();
      await stopped;
    }
    await this.chain;
    const rest = this.rewriter.flush();
    if (rest.length) await this.sink.write(rest);
    const durationMs = Math.round(this.activeMs);
    const offset = this.rewriter.durationOffset;
    if (offset !== null && !this.failed) {
      await this.sink.patchAt(offset, encodeDurationValue(durationMs, this.rewriter.timecodeScale));
      return { durationMs, durationFixed: true };
    }
    if (this.rewriter.unsupportedReason) console.warn('Duration not patched:', this.rewriter.unsupportedReason);
    return { durationMs, durationFixed: false };
  }

  private enqueue(blob: Blob): void {
    if (this.failed || blob.size === 0) return;
    const now = performance.now();
    if (this.mr.state === 'recording' && now - this.lastChunkAt > 10_000) this.cb.onStall?.(now - this.lastChunkAt);
    this.lastChunkAt = now;
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        const bytes = this.rewriter.push(new Uint8Array(await blob.arrayBuffer()));
        const total = await this.sink.write(bytes);
        this.cb.onBytes(total);
      } catch (e) {
        this.fail(e as Error);
      }
    });
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    if (this.mr.state !== 'inactive') {
      try {
        this.mr.stop();
      } catch {
        /* already stopped */
      }
    }
    this.cb.onError(err);
  }
}
