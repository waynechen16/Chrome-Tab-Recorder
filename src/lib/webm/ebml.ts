/**
 * Minimal EBML reader/writer — just enough to walk the top of a WebM file
 * produced by Chrome's MediaRecorder and rewrite the Segment › Info element.
 *
 * EBML variable-size integers (VINT): the number of leading zero bits in the
 * first byte + 1 gives the total length (1–8 bytes). Element IDs keep the
 * marker bit; element sizes strip it. A size whose value bits are all 1s means
 * "unknown size" (used by live WebM for Segment and Cluster).
 */

export const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Void: 0xec,
} as const;

export const UNKNOWN_SIZE = -1;

/** Length in bytes of the VINT starting with `first`, or 0 if invalid. */
export function vintLength(first: number): number {
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) return i + 1;
  }
  return 0;
}

export interface ReadResult {
  value: number;
  length: number;
}

/** Read an element ID (marker bit kept). Returns null when `buf` is too short. */
export function readId(buf: Uint8Array, pos: number): ReadResult | null {
  if (pos >= buf.length) return null;
  const len = vintLength(buf[pos]!);
  if (len === 0 || len > 4) throw new Error(`Invalid EBML ID at ${pos}`);
  if (pos + len > buf.length) return null;
  let value = 0;
  for (let i = 0; i < len; i++) value = value * 256 + buf[pos + i]!;
  return { value, length: len };
}

/** Read an element size (marker bit stripped). Unknown size → UNKNOWN_SIZE. */
export function readSize(buf: Uint8Array, pos: number): ReadResult | null {
  if (pos >= buf.length) return null;
  const len = vintLength(buf[pos]!);
  if (len === 0) throw new Error(`Invalid EBML size at ${pos}`);
  if (pos + len > buf.length) return null;
  let value = buf[pos]! & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    const b = buf[pos + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value: allOnes ? UNKNOWN_SIZE : value, length: len };
}

/**
 * Encode `value` as an EBML size VINT. If `width` is given the result uses
 * exactly that many bytes (throws if it does not fit); otherwise the minimal
 * width is used. All-ones patterns are avoided because they mean "unknown".
 */
export function encodeSize(value: number, width?: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Bad size ${value}`);
  const fits = (w: number) => value < 2 ** (7 * w) - 1;
  let w = width ?? 1;
  if (width === undefined) {
    while (!fits(w)) w++;
  } else if (!fits(w)) {
    throw new Error(`Size ${value} does not fit in ${w} bytes`);
  }
  if (w > 8) throw new Error(`Size ${value} too large`);
  const out = new Uint8Array(w);
  let v = value;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (w - 1);
  return out;
}

/** Encode an element ID (already includes its marker bit). */
export function encodeId(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(bytes);
}

export function readUint(buf: Uint8Array, pos: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i]!;
  return v;
}

export function float64BE(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

export interface ElementHeader {
  id: number;
  /** Offset of the element's first ID byte. */
  start: number;
  /** Offset of the first byte of the size VINT. */
  sizeStart: number;
  sizeLength: number;
  /** Offset of the first payload byte. */
  dataStart: number;
  /** Payload size, or UNKNOWN_SIZE. */
  size: number;
}

/** Read an element header at `pos`, or null when `buf` ends first. */
export function readElementHeader(buf: Uint8Array, pos: number): ElementHeader | null {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readSize(buf, pos + id.length);
  if (!size) return null;
  return {
    id: id.value,
    start: pos,
    sizeStart: pos + id.length,
    sizeLength: size.length,
    dataStart: pos + id.length + size.length,
    size: size.value,
  };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
