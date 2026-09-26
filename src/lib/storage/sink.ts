/**
 * Sink = where recorded bytes go. During recording everything is written to
 * OPFS (crash-safe, see plan §7); on finalize the file is exported to its
 * destination. M1 exports to the Downloads folder; M3 adds a user-chosen
 * directory as a second export target.
 */
import type { WriterRequestBody, WriterResponse } from './writer-protocol';

export interface Sink {
  open(fileName: string): Promise<void>;
  /** Append bytes. Resolves with total bytes written so far. */
  write(chunk: Uint8Array): Promise<number>;
  /** Overwrite bytes at an absolute offset (used for the Duration fix). */
  patchAt(offset: number, bytes: Uint8Array): Promise<void>;
  /** Close and export. Resolves once the file is at its destination. */
  finalize(): Promise<{ fileName: string; bytes: number }>;
}

export class OpfsSink implements Sink {
  private worker = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private waiting = new Map<number, (r: WriterResponse) => void>();
  /** Serialises all worker calls so chunks can never be reordered. */
  private queue: Promise<unknown> = Promise.resolve();
  private name = '';
  private bytes = 0;

  constructor() {
    this.worker.onmessage = (ev: MessageEvent<WriterResponse>) => {
      this.waiting.get(ev.data.id)?.(ev.data);
      this.waiting.delete(ev.data.id);
    };
  }

  private call(body: WriterRequestBody, transfer: Transferable[] = []): Promise<number> {
    const run = () =>
      new Promise<number>((resolve, reject) => {
        const id = this.nextId++;
        this.waiting.set(id, (r) => (r.ok ? resolve(r.bytes) : reject(new Error(r.error))));
        this.worker.postMessage({ id, ...body }, transfer);
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  async open(fileName: string): Promise<void> {
    this.name = fileName;
    await this.call({ op: 'open', name: fileName });
  }

  async write(chunk: Uint8Array): Promise<number> {
    if (chunk.length === 0) return this.bytes;
    const copy = chunk.slice().buffer; // own buffer so it can be transferred
    this.bytes = await this.call({ op: 'write', data: copy }, [copy]);
    return this.bytes;
  }

  async patchAt(offset: number, bytes: Uint8Array): Promise<void> {
    const copy = bytes.slice().buffer;
    await this.call({ op: 'patch', offset, data: copy }, [copy]);
  }

  /** Close the OPFS file and save it to the Downloads folder. */
  async finalize(): Promise<{ fileName: string; bytes: number }> {
    const bytes = await this.call({ op: 'close' });
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings');
    // A File from OPFS is disk-backed: the blob URL streams from disk, not memory.
    const file = await (await dir.getFileHandle(this.name)).getFile();
    const url = URL.createObjectURL(file);
    try {
      const finalName = await downloadAndWait(url, this.name);
      await this.call({ op: 'remove', name: this.name });
      return { fileName: finalName, bytes };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Close without exporting; the OPFS file is kept for later recovery. */
  async closeOnly(): Promise<void> {
    await this.call({ op: 'close' }).catch(() => undefined);
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** Start a download and resolve with the final file name once it completes. */
function downloadAndWait(url: string, filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let downloadId: number | undefined;
    const early: chrome.downloads.DownloadDelta[] = [];
    const done = (fn: () => void) => {
      chrome.downloads.onChanged.removeListener(listener);
      fn();
    };
    const handle = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'complete') {
        done(() =>
          chrome.downloads.search({ id: downloadId }).then(
            ([item]) => resolve(item?.filename?.split(/[\\/]/).pop() ?? filename),
            () => resolve(filename),
          ),
        );
      } else if (delta.state.current === 'interrupted') {
        done(() => reject(new Error(`Download interrupted: ${delta.error?.current ?? 'unknown'}`)));
      }
    };
    // A small file can finish before download() resolves with its id.
    const listener = (delta: chrome.downloads.DownloadDelta) =>
      downloadId === undefined ? early.push(delta) : handle(delta);
    chrome.downloads.onChanged.addListener(listener);
    chrome.downloads
      .download({ url, filename, conflictAction: 'uniquify', saveAs: false })
      .then((id) => {
        downloadId = id;
        early.forEach(handle);
      })
      .catch((e) => done(() => reject(e)));
  });
}
