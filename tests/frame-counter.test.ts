import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FrameCounter } from '../src/lib/webm/frame-counter';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string) => new Uint8Array(readFileSync(join(dir, `${n}.webm`)));
const packets = (n: string, sel: 'v' | 'a') =>
  Number(
    execFileSync('ffprobe', ['-v', 'error', '-select_streams', sel, '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', join(dir, `${n}.webm`)])
      .toString()
      .trim(),
  );
function hasFfprobe(): boolean {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('FrameCounter', () => {
  it.runIf(hasFfprobe()).each(['vp9', 'vp8', 'vp9-pause', 'vp8-pause'])('%s: counts every video frame, in odd-sized chunks', (name) => {
    const src = load(name);
    for (const step of [1000, 4093, 65536, src.length]) {
      const c = new FrameCounter();
      for (let i = 0; i < src.length; i += step) c.push(src.subarray(i, i + step));
      expect(c.ok).toBe(true);
      expect(c.videoTrack).not.toBeNull();
      expect(c.videoFrames).toBe(packets(name, 'v'));
      const audio = [...c.blocks.entries()].find(([t]) => t !== c.videoTrack)?.[1];
      expect(audio).toBe(packets(name, 'a'));
    }
  });
});
