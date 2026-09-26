/**
 * Unfinished recordings (plan §7, §9). Every recording is written to OPFS
 * first and removed from there only after a successful export, so anything
 * left in OPFS/recordings that is not currently open is recoverable.
 * A small metadata record (title, start time) makes the list readable.
 */

export interface PendingMeta {
  title: string;
  startedAt: number;
  part?: number;
}

export interface PendingRecording extends PendingMeta {
  name: string;
  size: number;
  lastModified: number;
}

const KEY = 'pendingRecordings';

async function readMeta(): Promise<Record<string, PendingMeta>> {
  return ((await chrome.storage.local.get(KEY))[KEY] as Record<string, PendingMeta> | undefined) ?? {};
}

export async function addPending(name: string, meta: PendingMeta): Promise<void> {
  const all = await readMeta();
  all[name] = meta;
  await chrome.storage.local.set({ [KEY]: all });
}

export async function removePending(name: string): Promise<void> {
  const all = await readMeta();
  delete all[name];
  await chrome.storage.local.set({ [KEY]: all });
}

/**
 * Files in OPFS/recordings, minus `exclude` (files the recorder still has
 * open). Stale metadata for files that no longer exist is cleaned up.
 */
export async function listPending(exclude: string[] = []): Promise<PendingRecording[]> {
  const meta = await readMeta();
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings');
  } catch {
    return [];
  }
  const out: PendingRecording[] = [];
  const seen = new Set<string>();
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (handle.kind !== 'file') continue;
    seen.add(name);
    if (exclude.includes(name)) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    const m = meta[name];
    out.push({
      name,
      size: file.size,
      lastModified: file.lastModified,
      title: m?.title ?? name.replace(/\.webm$/i, ''),
      startedAt: m?.startedAt ?? file.lastModified,
      part: m?.part,
    });
  }
  const stale = Object.keys(meta).filter((n) => !seen.has(n));
  if (stale.length) {
    stale.forEach((n) => delete meta[n]);
    await chrome.storage.local.set({ [KEY]: meta });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}
