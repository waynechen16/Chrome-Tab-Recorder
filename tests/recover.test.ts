import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DurationHeaderRewriter } from '../src/lib/webm/duration-patch';
import { analyzeRecording, lastTimestampMs } from '../src/lib/webm/recover';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string) => new Uint8Array(readFileSync(join(dir, `${n}.webm`)));

function lastPts(name: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', join(dir, `${name}.webm`)])
    .toString()
    .split('\n')
    .map((l) => parseFloat(l))
    .filter((n) => !Number.isNaN(n));
  return Math.max(...out) * 1000;
}

function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('lastTimestampMs', () => {
  it.runIf(hasFfprobe()).each(['vp9', 'vp8', 'vp9-pause', 'vp8-pause'])('%s: matches the last packet timestamp', (name) => {
    const ms = lastTimestampMs(load(name));
    expect(ms).not.toBeNull();
    expect(Math.abs(ms! - lastPts(name))).toBeLessThan(40);
  });

  it('works on a truncated file (crash mid-write)', () => {
    const full = load('vp9');
    const cut = full.subarray(0, Math.floor(full.length * 0.7));
    const ms = lastTimestampMs(cut);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(1000);
    expect(ms!).toBeLessThan(lastTimestampMs(full)!);
  });

  it('returns null without a cluster', () => {
    expect(lastTimestampMs(load('vp9').subarray(0, 200))).toBeNull();
  });
});

describe('analyzeRecording', () => {
  it('finds the Duration placeholder written during recording', async () => {
    const rw = new DurationHeaderRewriter();
    const src = load('vp8');
    const patched = new Uint8Array([...rw.push(src.subarray(0, 60000)), ...rw.push(src.subarray(60000)), ...rw.flush()]);
    const a = await analyzeRecording(new Blob([patched]));
    expect(a.durationOffset).toBe(rw.durationOffset);
    expect(a.durationMs).toBeGreaterThan(3000);
  });

  it('reports no in-place offset for a raw Chrome file', async () => {
    const a = await analyzeRecording(new Blob([load('vp9')]));
    expect(a.durationOffset).toBeNull();
    expect(a.durationMs).toBeGreaterThan(3000);
  });
});
