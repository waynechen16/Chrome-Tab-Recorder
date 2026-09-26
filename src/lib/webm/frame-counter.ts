/**
 * Streaming frame counter for live WebM (M5 quality stats).
 *
 * Counts SimpleBlocks per track as bytes arrive from MediaRecorder, so we
 * know how many video frames the encoder actually produced — the honest
 * measure of whether the machine keeps up (tab capture may deliver 30 fps
 * while an overloaded encoder silently drops frames).
 *
 * Walker rule: Segment and Cluster are containers (often unknown size), so
 * only their header is consumed and we continue with their children; every
 * other element is skipped by its size. This works across chunk boundaries.
 */
import { ID, UNKNOWN_SIZE, readElementHeader } from './ebml';

const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const TYPE_VIDEO = 1;

export class FrameCounter {
  private pending = new Uint8Array(0);
  private skip = 0;
  private broken = false;
  /** Blocks per track number (1-based track numbers as in the file). */
  readonly blocks = new Map<number, number>();
  /** Track number of the video track, from the Tracks element. */
  videoTrack: number | null = null;

  push(chunk: Uint8Array): void {
    if (this.broken || chunk.length === 0) return;
    let buf = chunk;
    if (this.skip > 0) {
      if (this.skip >= buf.length) {
        this.skip -= buf.length;
        return;
      }
      buf = buf.subarray(this.skip);
      this.skip = 0;
    }
    if (this.pending.length) {
      const joined = new Uint8Array(this.pending.length + buf.length);
      joined.set(this.pending);
      joined.set(buf, this.pending.length);
      buf = joined;
      this.pending = new Uint8Array(0);
    }
    let pos = 0;
    try {
      while (pos < buf.length) {
        const el = readElementHeader(buf, pos);
        if (!el) break; // header split across chunks
        if (el.id === ID.Segment || el.id === ID.Cluster) {
          pos = el.dataStart;
          continue;
        }
        if (el.size === UNKNOWN_SIZE) {
          this.broken = true; // unexpected: stop counting rather than guess
          return;
        }
        if (el.id === ID.Tracks && el.dataStart + el.size <= buf.length) {
          this.readTracks(buf, el.dataStart, el.dataStart + el.size);
        }
        if (el.id === SIMPLE_BLOCK || el.id === BLOCK_GROUP) {
          // Track number is the first VINT of the block payload (inside A1 for groups).
          let at = el.dataStart;
          if (el.id === BLOCK_GROUP) {
            const inner = readElementHeader(buf, at);
            if (!inner) break;
            at = inner.dataStart;
          }
          if (at >= buf.length) break;
          const track = buf[at]! & 0x7f; // 1-byte VINT covers tracks 1–127
          this.blocks.set(track, (this.blocks.get(track) ?? 0) + 1);
        }
        const end = el.dataStart + el.size;
        if (end > buf.length) {
          this.skip = end - buf.length;
          return;
        }
        pos = end;
      }
    } catch {
      this.broken = true;
      return;
    }
    this.pending = buf.slice(pos);
  }

  private readTracks(buf: Uint8Array, start: number, end: number): void {
    let pos = start;
    while (pos < end) {
      const entry = readElementHeader(buf, pos);
      if (!entry || entry.size === UNKNOWN_SIZE) return;
      if (entry.id === TRACK_ENTRY) {
        let number: number | null = null;
        let type: number | null = null;
        let p = entry.dataStart;
        const e = entry.dataStart + entry.size;
        while (p < e) {
          const c = readElementHeader(buf, p);
          if (!c || c.size === UNKNOWN_SIZE) break;
          if (c.id === TRACK_NUMBER) number = buf[c.dataStart]!;
          if (c.id === TRACK_TYPE) type = buf[c.dataStart]!;
          p = c.dataStart + c.size;
        }
        if (type === TYPE_VIDEO && number !== null) this.videoTrack = number;
      }
      pos = entry.dataStart + entry.size;
    }
  }

  /** Encoded video frames so far. */
  get videoFrames(): number {
    return this.videoTrack === null ? 0 : this.blocks.get(this.videoTrack) ?? 0;
  }

  get ok(): boolean {
    return !this.broken;
  }
}
