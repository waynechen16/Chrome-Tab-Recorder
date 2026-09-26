import { describe, expect, it } from 'vitest';
import { chromeMajorFromUA, evaluatePreflight, overallLevel, type PreflightInputs } from '../src/lib/preflight';
import { DEFAULT_SETTINGS } from '../src/lib/settings';

const base: PreflightInputs = {
  chromeMajor: 140,
  cpuCores: 10,
  memoryGB: 16,
  supports: { vp9: true, vp8: true },
  freeBytes: 200 * 1024 ** 3,
  settings: { ...DEFAULT_SETTINGS },
  folder: 'downloads',
  mic: 'granted',
  pendingCount: 0,
};
const find = (items: ReturnType<typeof evaluatePreflight>, id: string) => items.find((x) => x.id === id)!;

describe('evaluatePreflight', () => {
  it('passes a typical good setup', () => {
    const items = evaluatePreflight(base);
    expect(overallLevel(items)).toBe('ok');
  });

  it('fails on old Chrome and insufficient disk', () => {
    const items = evaluatePreflight({ ...base, chromeMajor: 110, freeBytes: 2 * 1024 ** 3 });
    expect(find(items, 'chrome').level).toBe('fail');
    expect(find(items, 'disk').level).toBe('fail');
    expect(overallLevel(items)).toBe('fail');
  });

  it('warns about CPU on a 4-core machine with VP9 1080p30', () => {
    expect(find(evaluatePreflight({ ...base, cpuCores: 4 }), 'cpu').level).toBe('warn');
    const light = { ...base, cpuCores: 4, settings: { ...DEFAULT_SETTINGS, videoCodec: 'vp8' as const } };
    expect(find(evaluatePreflight(light), 'cpu').level).toBe('ok');
  });

  it('warns when the chosen codec is missing, and about folder / mic permissions', () => {
    const items = evaluatePreflight({
      ...base,
      supports: { vp9: false, vp8: true },
      folder: 'prompt',
      mic: 'prompt',
      settings: { ...DEFAULT_SETTINGS, micOnAtStart: true, saveLocation: 'directory', directoryName: 'Classes' },
      pendingCount: 2,
    });
    expect(find(items, 'codec').level).toBe('warn');
    expect(find(items, 'folder').detail).toContain('Classes');
    expect(find(items, 'mic').level).toBe('warn');
    expect(find(items, 'pending').detail).toContain('2');
    expect(overallLevel(items)).toBe('warn');
  });

  it('estimates recordable hours with a 2× export budget', () => {
    // 4.128 Mbps ≈ 1.86 GB/h → 20 GB free ≈ 5.4 h at 2×
    const d = find(evaluatePreflight({ ...base, freeBytes: 20 * 1024 ** 3 }), 'disk');
    expect(d.level).toBe('ok');
    expect(d.detail).toContain('5 小時');
  });

  it('parses the Chrome major version', () => {
    expect(chromeMajorFromUA('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0.7390.54 Safari/537.36')).toBe(141);
    expect(chromeMajorFromUA('Firefox/130')).toBeNull();
  });
});
