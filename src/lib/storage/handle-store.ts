/**
 * Persist the user-chosen save folder. FileSystemDirectoryHandle can only be
 * stored in IndexedDB (not chrome.storage), and is shared by every page of
 * this extension (same origin).
 */

const DB = 'tab-recorder';
const STORE = 'handles';
const KEY = 'saveDirectory';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function getSaveDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  return (await tx('readonly', (s) => s.get(KEY))) as FileSystemDirectoryHandle | undefined;
}

export async function setSaveDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  await tx('readwrite', (s) => s.put(handle, KEY));
}

export async function clearSaveDirectory(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

export type DirPermission = 'granted' | 'prompt' | 'denied' | 'missing';

/** Permission state for writing into the saved folder (no prompt). */
export async function saveDirectoryPermission(handle?: FileSystemDirectoryHandle): Promise<DirPermission> {
  const h = handle ?? (await getSaveDirectory());
  if (!h) return 'missing';
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) as DirPermission;
  } catch {
    return 'missing';
  }
}

/** Ask for write access. Must be called from a user gesture in a visible page. */
export async function requestSaveDirectoryPermission(handle?: FileSystemDirectoryHandle): Promise<DirPermission> {
  const h = handle ?? (await getSaveDirectory());
  if (!h) return 'missing';
  try {
    return (await h.requestPermission({ mode: 'readwrite' })) as DirPermission;
  } catch {
    return 'denied';
  }
}

/** "name.webm" → "name (1).webm", "name (2).webm", … until unused in `dir`. */
export async function uniqueName(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      if ((e as DOMException).name === 'NotFoundError') return candidate;
      throw e;
    }
  }
  throw new Error('Too many files with the same name');
}
