import { describe, expect, it } from 'vitest';
import { micConstraints, micErrorMessage } from '../src/lib/mic';

describe('mic helpers', () => {
  it('uses an ideal (not exact) device id so a missing device falls back', () => {
    expect(micConstraints('abc')).toMatchObject({ deviceId: { ideal: 'abc' }, echoCancellation: true });
    expect(micConstraints('')).not.toHaveProperty('deviceId');
  });

  it('explains permission and device errors', () => {
    expect(micErrorMessage(new Error('NOT_GRANTED'))).toContain('尚未授權');
    expect(micErrorMessage(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toContain('尚未授權');
    expect(micErrorMessage(Object.assign(new Error('x'), { name: 'NotFoundError' }))).toContain('找不到');
    expect(micErrorMessage(Object.assign(new Error('x'), { name: 'NotReadableError' }))).toContain('占用');
    expect(micErrorMessage(new Error('MIX_UNAVAILABLE'))).toContain('無法混入');
  });
});
