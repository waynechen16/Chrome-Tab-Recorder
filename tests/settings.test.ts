import { describe, expect, it } from 'vitest';
import { captureSize } from '../src/lib/capture';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/lib/settings';

describe('normalizeSettings', () => {
  it('fills defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps valid values and drops invalid or legacy ones', () => {
    const s = normalizeSettings({
      resolution: '720p',
      fps: 15,
      videoCodec: 'h264', // unsupported
      videoBitsPerSecond: 99, // out of range
      fileNameTemplate: '   ', // empty
      maxWidth: 1920, // legacy key from 0.1/0.2
      saveLocation: 'directory',
      directoryName: 'Classes',
      micOnAtStart: true,
    });
    expect(s.resolution).toBe('720p');
    expect(s.fps).toBe(15);
    expect(s.videoCodec).toBe('vp9');
    expect(s.videoBitsPerSecond).toBe(4_000_000);
    expect(s.fileNameTemplate).toBe(DEFAULT_SETTINGS.fileNameTemplate);
    expect(s).not.toHaveProperty('maxWidth');
    expect(s.saveLocation).toBe('directory');
    expect(s.directoryName).toBe('Classes');
    expect(s.micOnAtStart).toBe(true);
  });
});

describe('captureSize', () => {
  it('uses the preset bounding box', () => {
    expect(captureSize({ resolution: '720p' }, { width: 1440, height: 900 }, 2)).toEqual({ width: 1280, height: 720 });
    expect(captureSize({ resolution: '1080p' }, undefined, 1)).toEqual({ width: 1920, height: 1080 });
  });

  it("follows the tab in device pixels for 'tab'", () => {
    expect(captureSize({ resolution: 'tab' }, { width: 1440, height: 821 }, 2)).toEqual({ width: 2880, height: 1642 });
    expect(captureSize({ resolution: 'tab' }, { width: 1001, height: 601 }, 1)).toEqual({ width: 1002, height: 602 });
  });

  it("caps 'tab' at 4K keeping the aspect ratio", () => {
    expect(captureSize({ resolution: 'tab' }, { width: 2560, height: 1440 }, 2)).toEqual({ width: 3840, height: 2160 });
    const s = captureSize({ resolution: 'tab' }, { width: 3000, height: 1000 }, 2);
    expect(s.width).toBe(3840);
    expect(s.height).toBe(1280);
  });

  it("falls back to 1080p for 'tab' when the tab size is unknown", () => {
    expect(captureSize({ resolution: 'tab' }, undefined, 2)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('micGain setting', () => {
  it('defaults to 150% and rejects out-of-range values', () => {
    expect(normalizeSettings(undefined).micGain).toBe(1.5);
    expect(normalizeSettings({ micGain: 2.5 }).micGain).toBe(2.5);
    expect(normalizeSettings({ micGain: 9 }).micGain).toBe(1.5);
    expect(normalizeSettings({ micGain: 0.1 }).micGain).toBe(1.5);
  });
});
