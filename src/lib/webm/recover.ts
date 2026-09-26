/**
 * Crash recovery helpers (plan §7, §9): find how long an unfinished live
 * WebM file is, so its Duration can be patched before export.
 *
 * Live WebM has unknown-size Clusters, so we cannot jump from cluster to
 * cluster. Instead we read the file's tail, search backwards for the last
 * Cluster header, and walk its blocks to find the latest timestamp.
 */
import { ID, UNKNOWN_SIZE, readElementHeader, readUint } from './ebml';
import { injectDurationPlaceholder, DEFAULT_TIMECODE_SCALE } from './duration-patch';

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;

/** Relative timecode (signed 16-bit) of a (Simple)Block payload starting at `pos`. */
function blockRelTimecode(buf: Uint8Array, pos: number, end: number): number | null {
  const first = buf[pos];
  if (first === undefined) return null;
  // Track number is a VINT; skip it.
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  const at = pos + len;
  if (len > 8 || at + 2 > end) return null;
  const v = (buf[at]! << 8) | buf[at + 1]!;
  return v & 0x8000 ? v - 0x10000 : v;
}

/** Walk one Cluster starting at `start`; returns its latest absolute timecode (ticks). */
function scanCluster(buf: Uint8Array, start: number): number | null {
  const cluster = readElementHeader(buf, start);
  if (!cluster || cluster.id !== ID.Cluster) return null;
  const end = cluster.size === UNKNOWN_SIZE ? buf.length : Math.min(buf.length, cluster.dataStart + cluster.size);
  let pos = cluster.dataStart;
  let base: number | null = null;
  let maxRel = 0;
  while (pos < end) {
    let el;
    try {
      el = readElementHeader(buf, pos);
    } catch {
      break;
    }
    if (!el || el.size === UNKNOWN_SIZE) break;
    const elEnd = el.dataStart + el.size;
    if (el.id === TIMECODE) {
      if (elEnd > buf.length) break;
      base = readUint(buf, el.dataStart, el.size);
    } else if (el.id === SIMPLE_BLOCK) {
      // A truncated final block still carries a valid timestamp in its first bytes.
      const rel = blockRelTimecode(buf, el.dataStart, Math.min(elEnd, buf.length));
      if (rel !== null && rel > maxRel) maxRel = rel;
    } else if (el.id === BLOCK_GROUP) {
      const inner = readElementHeader(buf, el.dataStart);
      if (inner && inner.id === BLOCK) {
        const rel = blockRelTimecode(buf, inner.dataStart, Math.min(elEnd, buf.length));
        if (rel !== null && rel > maxRel) maxRel = rel;
      }
    } else if (el.id === ID.Cluster) {
      break; // next cluster (should not happen when scanning the last one)
    }
    if (elEnd > buf.length) break;
    pos = elEnd;
  }
  return base === null ? null : base + maxRel;
}

/**
 * Latest timestamp in ms found in `tail` (the last bytes of a live WebM),
 * or null if no complete Cluster header is present.
 */
export function lastTimestampMs(tail: Uint8Array, timecodeScale = DEFAULT_TIMECODE_SCALE): number | null {
  for (let i = tail.length - CLUSTER_ID.length; i >= 0; i--) {
    if (tail[i] !== CLUSTER_ID[0] || tail[i + 1] !== CLUSTER_ID[1] || tail[i + 2] !== CLUSTER_ID[2] || tail[i + 3] !== CLUSTER_ID[3]) {
      continue;
    }
    const ticks = scanCluster(tail, i);
    if (ticks !== null) return (ticks * timecodeScale) / 1_000_000;
  }
  return null;
}

export interface RecordingAnalysis {
  /** Estimated length; null when no cluster could be found. */
  durationMs: number | null;
  /** Offset of the Duration value to patch in place; null when the header has none. */
  durationOffset: number | null;
  timecodeScale: number;
}

const HEAD_BYTES = 64 * 1024;
const TAIL_STEPS = [8, 64] as const; // MB

/** Inspect an unfinished recording without loading it into memory. */
export async function analyzeRecording(file: Blob): Promise<RecordingAnalysis> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const h = injectDurationPlaceholder(head);
  // Our recordings already contain a Duration placeholder, so the head comes
  // back unchanged; anything else cannot be patched in place.
  const hasDuration = h.status === 'ok' && h.bytes.length === head.length;
  const timecodeScale = h.status === 'ok' ? h.timecodeScale : DEFAULT_TIMECODE_SCALE;
  let durationMs: number | null = null;
  for (const mb of TAIL_STEPS) {
    const start = Math.max(0, file.size - mb * 1024 * 1024);
    const tail = new Uint8Array(await file.slice(start).arrayBuffer());
    durationMs = lastTimestampMs(tail, timecodeScale);
    if (durationMs !== null || start === 0) break;
  }
  return {
    durationMs: durationMs === null ? null : Math.round(durationMs),
    durationOffset: hasDuration && h.status === 'ok' ? h.durationOffset : null,
    timecodeScale,
  };
}
