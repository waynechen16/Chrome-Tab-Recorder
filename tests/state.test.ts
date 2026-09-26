import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, canTransition, elapsedMs, formatBytes, formatDuration } from '../src/lib/state';

describe('state machine', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('idle', 'starting')).toBe(true);
    expect(canTransition('starting', 'recording')).toBe(true);
    expect(canTransition('recording', 'paused')).toBe(true);
    expect(canTransition('paused', 'recording')).toBe(true);
    expect(canTransition('recording', 'stopping')).toBe(true);
    expect(canTransition('stopping', 'idle')).toBe(true);
    expect(canTransition('error', 'idle')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('idle', 'recording')).toBe(false);
    expect(canTransition('stopping', 'recording')).toBe(false);
    expect(canTransition('error', 'recording')).toBe(false);
  });
});

describe('elapsed time', () => {
  it('extrapolates only while recording', () => {
    const base = { ...INITIAL_STATE, elapsedMs: 10_000, elapsedAt: 1_000 };
    expect(elapsedMs({ ...base, phase: 'recording' }, 4_000)).toBe(13_000);
    expect(elapsedMs({ ...base, phase: 'paused' }, 4_000)).toBe(10_000);
  });

  it('formats durations and sizes', () => {
    expect(formatDuration(3_723_000)).toBe('01:02:03');
    expect(formatBytes(1.8 * 1024 ** 3)).toBe('1.80 GB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
  });
});
