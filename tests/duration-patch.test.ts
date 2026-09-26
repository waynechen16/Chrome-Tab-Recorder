import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DurationHeaderRewriter,
  encodeDurationValue,
  injectDurationPlaceholder,
} from '../src/lib/webm/duration-patch';

// Real files recorded by Chromium's MediaRecorder (see tests/fixtures/README.md).
const FIXTURES = ['vp9', 'vp8', 'vp9-pause', 'vp8-pause'];
const load = (name: string) => new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.webm`)));

function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function probeDuration(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'webm-'));
  const file = join(dir, 'out.webm');
  writeFileSync(file, bytes);
  return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    .toString()
    .trim();
}

/** Simulate the recorder: feed ~1 s sized chunks through the rewriter, then patch. */
function simulate(src: Uint8Array, chunkSizes: number[], durationMs: number) {
  const rw = new DurationHeaderRewriter();
  const out: Uint8Array[] = [];
  let pos = 0;
  for (const size of chunkSizes) {
    out.push(rw.push(src.subarray(pos, Math.min(pos + size, src.length))));
    pos += size;
    if (pos >= src.length) break;
  }
  if (pos < src.length) out.push(rw.push(src.subarray(pos)));
  out.push(rw.flush());
  const total = out.reduce((n, p) => n + p.length, 0);
  const file = new Uint8Array(total);
  let off = 0;
  for (const p of out) {
    file.set(p, off);
    off += p.length;
  }
  expect(rw.durationOffset).not.toBeNull();
  file.set(encodeDurationValue(durationMs, rw.timecodeScale), rw.durationOffset!);
  return file;
}

describe('injectDurationPlaceholder', () => {
  it.each(FIXTURES)('%s: inserts an 11-byte Duration element into Info', (name) => {
    const src = load(name);
    const r = injectDurationPlaceholder(src.subarray(0, 4096));
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.bytes.length).toBe(4096 + 11);
    expect(r.timecodeScale).toBe(1_000_000);
    // ID 0x4489, size 0x88 precede the 8 value bytes.
    expect(Array.from(r.bytes.subarray(r.durationOffset - 3, r.durationOffset))).toEqual([0x44, 0x89, 0x88]);
  });

  it('asks for more data when Info is incomplete', () => {
    expect(injectDurationPlaceholder(load('vp9').subarray(0, 40)).status).toBe('need-more');
    expect(injectDurationPlaceholder(new Uint8Array(0)).status).toBe('need-more');
  });

  it('rejects non-WebM input', () => {
    expect(injectDurationPlaceholder(Uint8Array.from([1, 2, 3, 4, 5, 6])).status).toBe('unsupported');
  });

  it('reuses an existing Duration instead of inserting a second one', () => {
    const once = injectDurationPlaceholder(load('vp9').subarray(0, 4096));
    if (once.status !== 'ok') throw new Error('patch failed');
    const twice = injectDurationPlaceholder(once.bytes);
    expect(twice.status).toBe('ok');
    if (twice.status === 'ok') {
      expect(twice.bytes.length).toBe(once.bytes.length);
      expect(twice.durationOffset).toBe(once.durationOffset);
    }
  });
});

describe('DurationHeaderRewriter', () => {
  it('holds back tiny first chunks until Info is complete', () => {
    const src = load('vp8');
    const file = simulate(src, [10, 10, 10, 50000, 60000], 3200);
    expect(file.length).toBe(src.length + 11);
  });

  it.runIf(hasFfprobe()).each(FIXTURES)('%s: ffprobe reports the patched duration', (name) => {
    const src = load(name);
    expect(probeDuration(src)).toBe('N/A');
    const file = simulate(src, [50000, 65000, 65000, 65000], 3210);
    expect(Number(probeDuration(file))).toBeCloseTo(3.21, 2);
  });

  it.runIf(hasFfprobe())('patched file decodes end to end without errors', () => {
    const file = simulate(load('vp9-pause'), [48000, 40000, 70000], 3000);
    const dir = mkdtempSync(join(tmpdir(), 'webm-'));
    const path = join(dir, 'out.webm');
    writeFileSync(path, file);
    const log = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: 'pipe' }).toString();
    expect(log).toBe('');
  });
});
