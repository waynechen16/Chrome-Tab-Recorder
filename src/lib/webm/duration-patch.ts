/**
 * In-place WebM Duration fix.
 *
 * Chrome's MediaRecorder writes "live" WebM: the Segment has unknown size and
 * Segment › Info has no Duration, so players show no length and cannot seek.
 * Instead of rewriting the whole (multi-GB) file at the end, we:
 *
 *   1. Take the first bytes of the stream (EBML header + Segment start + Info),
 *      insert a Duration element (float64, value 0) at the end of Info and
 *      grow Info's size field accordingly.
 *   2. Remember the absolute file offset of the 8 Duration value bytes.
 *   3. When recording stops, overwrite just those 8 bytes with the real value.
 *
 * Because the Segment size is unknown, inserting bytes into Info does not
 * invalidate any other size field. A SeekHead would contain absolute
 * positions that shift; Chrome does not write one for live output, so we
 * refuse to patch (and leave the file untouched) if one is present.
 */
import {
  ID,
  UNKNOWN_SIZE,
  concat,
  encodeId,
  encodeSize,
  float64BE,
  readElementHeader,
  readUint,
} from './ebml';

export const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns per tick → ticks are ms

export type HeaderPatchResult =
  /** More bytes are needed before Info can be parsed completely. */
  | { status: 'need-more' }
  /** The stream cannot be patched safely; write it unchanged. */
  | { status: 'unsupported'; reason: string }
  | {
      status: 'ok';
      /** Bytes to write in place of the input. */
      bytes: Uint8Array;
      /** Absolute offset (from file start) of the 8-byte Duration value. */
      durationOffset: number;
      timecodeScale: number;
    };

/**
 * Insert a Duration placeholder into the head of a live WebM stream.
 * `head` must start at file offset 0. Returns 'need-more' until `head`
 * contains the entire Info element.
 */
export function injectDurationPlaceholder(head: Uint8Array): HeaderPatchResult {
  try {
    return inject(head);
  } catch (e) {
    return { status: 'unsupported', reason: (e as Error).message };
  }
}

function inject(head: Uint8Array): HeaderPatchResult {
  const ebml = readElementHeader(head, 0);
  if (!ebml) return { status: 'need-more' };
  if (ebml.id !== ID.EBML) return { status: 'unsupported', reason: 'Not an EBML stream' };
  if (ebml.size === UNKNOWN_SIZE) return { status: 'unsupported', reason: 'EBML header size unknown' };

  const seg = readElementHeader(head, ebml.dataStart + ebml.size);
  if (!seg) return { status: 'need-more' };
  if (seg.id !== ID.Segment) return { status: 'unsupported', reason: 'Segment not found' };
  if (seg.size !== UNKNOWN_SIZE) {
    // A finite Segment size would also need to grow; not produced by Chrome live output.
    return { status: 'unsupported', reason: 'Segment has a known size' };
  }

  // Walk Segment children until Info.
  let pos = seg.dataStart;
  for (;;) {
    const el = readElementHeader(head, pos);
    if (!el) return { status: 'need-more' };
    if (el.id === ID.SeekHead) return { status: 'unsupported', reason: 'SeekHead present' };
    if (el.id === ID.Cluster || el.id === ID.Tracks || el.id === ID.Cues) {
      return { status: 'unsupported', reason: 'Info not found before media data' };
    }
    if (el.size === UNKNOWN_SIZE) return { status: 'unsupported', reason: 'Unknown-size element before Info' };
    if (el.id === ID.Info) return patchInfo(head, el);
    pos = el.dataStart + el.size;
  }
}

function patchInfo(head: Uint8Array, info: NonNullable<ReturnType<typeof readElementHeader>>): HeaderPatchResult {
  const infoEnd = info.dataStart + info.size;
  if (infoEnd > head.length) return { status: 'need-more' };

  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let pos = info.dataStart;
  while (pos < infoEnd) {
    const child = readElementHeader(head, pos);
    if (!child || child.size === UNKNOWN_SIZE) {
      return { status: 'unsupported', reason: 'Malformed Info element' };
    }
    if (child.id === ID.TimecodeScale) {
      timecodeScale = readUint(head, child.dataStart, child.size);
    } else if (child.id === ID.Duration) {
      if (child.size !== 8) return { status: 'unsupported', reason: 'Existing Duration is not float64' };
      // Already present (e.g. a future Chrome): reuse it.
      return { status: 'ok', bytes: head, durationOffset: child.dataStart, timecodeScale };
    }
    pos = child.dataStart + child.size;
  }

  const durationEl = concat([encodeId(ID.Duration), encodeSize(8), float64BE(0)]);
  const newInfoSize = info.size + durationEl.length;

  let sizeField: Uint8Array;
  try {
    sizeField = encodeSize(newInfoSize, info.sizeLength);
  } catch {
    sizeField = encodeSize(newInfoSize);
  }

  const bytes = concat([
    head.subarray(0, info.sizeStart),
    sizeField,
    head.subarray(info.dataStart, infoEnd),
    durationEl,
    head.subarray(infoEnd),
  ]);
  const newInfoDataStart = info.sizeStart + sizeField.length;
  const durationOffset = newInfoDataStart + info.size + durationEl.length - 8;
  return { status: 'ok', bytes, durationOffset, timecodeScale };
}

/** The 8 bytes to write at `durationOffset` for a recording of `durationMs`. */
export function encodeDurationValue(durationMs: number, timecodeScale = DEFAULT_TIMECODE_SCALE): Uint8Array {
  const ticks = (durationMs * 1_000_000) / timecodeScale;
  return float64BE(ticks);
}

/** Give up looking for Info after this many bytes and pass the stream through. */
const MAX_HEADER_SCAN = 1024 * 1024;

/**
 * Streaming wrapper: feed MediaRecorder chunks in order, write whatever
 * `push` returns. After the header has been seen, `durationOffset` is set
 * (or stays null if the stream could not be patched).
 */
export class DurationHeaderRewriter {
  private pending: Uint8Array | null = new Uint8Array(0);
  durationOffset: number | null = null;
  timecodeScale = DEFAULT_TIMECODE_SCALE;
  unsupportedReason: string | null = null;

  /** Returns the bytes that should be appended to the output now. */
  push(chunk: Uint8Array): Uint8Array {
    if (this.pending === null) return chunk;
    const head = concat([this.pending, chunk]);
    const r = injectDurationPlaceholder(head);
    if (r.status === 'need-more' && head.length < MAX_HEADER_SCAN) {
      this.pending = head;
      return new Uint8Array(0);
    }
    this.pending = null;
    if (r.status === 'ok') {
      this.durationOffset = r.durationOffset;
      this.timecodeScale = r.timecodeScale;
      return r.bytes;
    }
    this.unsupportedReason = r.status === 'unsupported' ? r.reason : 'Header not found';
    return head;
  }

  /** Bytes still held back (only non-empty if the stream ended mid-header). */
  flush(): Uint8Array {
    const rest = this.pending ?? new Uint8Array(0);
    this.pending = null;
    return rest;
  }
}
