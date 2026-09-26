import { describe, expect, it } from 'vitest';
import { UNKNOWN_SIZE, encodeId, encodeSize, readId, readSize, vintLength } from '../src/lib/webm/ebml';

describe('EBML VINT', () => {
  it('computes lengths from the first byte', () => {
    expect(vintLength(0x81)).toBe(1);
    expect(vintLength(0x40)).toBe(2);
    expect(vintLength(0x01)).toBe(8);
    expect(vintLength(0x00)).toBe(0);
  });

  it('round-trips sizes at minimal and fixed widths', () => {
    for (const v of [0, 1, 126, 127, 128, 16382, 16383, 2 ** 21, 2 ** 40]) {
      const enc = encodeSize(v);
      expect(readSize(enc, 0)).toEqual({ value: v, length: enc.length });
      const wide = encodeSize(v, 8);
      expect(readSize(wide, 0)).toEqual({ value: v, length: 8 });
    }
  });

  it('never emits the all-ones (unknown) pattern', () => {
    expect(encodeSize(127)).toEqual(Uint8Array.from([0x40, 0x7f]));
    expect(() => encodeSize(127, 1)).toThrow();
  });

  it('detects unknown sizes', () => {
    expect(readSize(Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 0)?.value).toBe(UNKNOWN_SIZE);
    expect(readSize(Uint8Array.from([0xff]), 0)?.value).toBe(UNKNOWN_SIZE);
  });

  it('reads and encodes IDs with marker bits', () => {
    const seg = encodeId(0x18538067);
    expect(Array.from(seg)).toEqual([0x18, 0x53, 0x80, 0x67]);
    expect(readId(seg, 0)).toEqual({ value: 0x18538067, length: 4 });
    expect(readId(Uint8Array.from([0x18, 0x53]), 0)).toBeNull();
  });
});
