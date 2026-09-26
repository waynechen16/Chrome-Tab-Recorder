/** Recent problems, kept for the Options page (plan §9). */

export interface LogEntry {
  at: number;
  level: 'error' | 'warn' | 'info';
  code: string;
  message: string;
}

const KEY = 'errorLog';
const MAX = 20;

export async function logEvent(level: LogEntry['level'], code: string, message: string): Promise<void> {
  try {
    const list = ((await chrome.storage.local.get(KEY))[KEY] as LogEntry[] | undefined) ?? [];
    list.unshift({ at: Date.now(), level, code, message });
    await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
  } catch (e) {
    console.warn('logEvent failed', e);
  }
}

export async function readLog(): Promise<LogEntry[]> {
  return ((await chrome.storage.local.get(KEY))[KEY] as LogEntry[] | undefined) ?? [];
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
