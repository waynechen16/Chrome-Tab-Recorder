/** Build a safe download file name from the template and the tab title. */

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
/** Prefixes our own tab indicator adds to the title (see indicator.ts). */
const INDICATOR_PREFIX = /^(?:● REC|‖ PAUSED) │ /;
const MAX_TITLE = 60;

export function sanitizeTitle(title: string): string {
  let t = title.replace(INDICATOR_PREFIX, '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[.\s]+|[.\s]+$/g, '');
  if (t.length > MAX_TITLE) t = t.slice(0, MAX_TITLE).trim();
  return t || 'recording';
}

const pad = (n: number) => String(n).padStart(2, '0');

export function buildFileName(template: string, title: string, at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const base = template
    .replaceAll('{title}', sanitizeTitle(title))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time)
    .replace(ILLEGAL, '_');
  return `${base || 'recording'}.webm`;
}

/** "name.webm" → "name_part2.webm" (auto-segmented recordings). */
export function partFileName(name: string, part: number): string {
  return name.replace(/(\.webm)?$/i, `_part${part}.webm`);
}
