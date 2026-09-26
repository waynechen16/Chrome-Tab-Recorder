import { describe, expect, it } from 'vitest';
import { buildFileName, sanitizeTitle } from '../src/lib/filename';

describe('file names', () => {
  const at = new Date(2026, 8, 26, 9, 5, 7);

  it('expands the template', () => {
    expect(buildFileName('{title}_{date}_{time}', 'Meet – abc-defg-hij', at)).toBe('Meet – abc-defg-hij_2026-09-26_090507.webm');
  });

  it('removes characters illegal in file names', () => {
    expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('strips our own REC / PAUSED title prefix', () => {
    expect(sanitizeTitle('● REC │ Meet – class')).toBe('Meet – class');
    expect(sanitizeTitle('‖ PAUSED │ Meet – class')).toBe('Meet – class');
  });

  it('truncates long titles and falls back when empty', () => {
    expect(sanitizeTitle('x'.repeat(200))).toHaveLength(60);
    expect(sanitizeTitle('   ...  ')).toBe('recording');
    expect(buildFileName('{title}', '', at)).toBe('recording.webm');
  });

  it('keeps CJK titles intact', () => {
    expect(sanitizeTitle('線上課程：第三週')).toBe('線上課程：第三週');
  });
});
