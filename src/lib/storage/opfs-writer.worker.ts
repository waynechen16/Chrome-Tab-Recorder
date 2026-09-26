/// <reference lib="webworker" />
/**
 * Dedicated worker that owns the OPFS sync access handle for the recording.
 * Every chunk is written and flushed immediately, so a Chrome crash loses at
 * most the chunk in flight (see implementation plan §7).
 */
import type { WriterRequest, WriterResponse, WriterResponseBody } from './writer-protocol';

declare const self: DedicatedWorkerGlobalScope;

let handle: FileSystemSyncAccessHandle | null = null;
let position = 0;

async function recordingsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('recordings', { create: true });
}

async function handleRequest(req: WriterRequest): Promise<WriterResponseBody> {
  switch (req.op) {
    case 'open': {
      const dir = await recordingsDir();
      const file = await dir.getFileHandle(req.name, { create: true });
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      position = 0;
      return { ok: true, bytes: 0 };
    }
    case 'write': {
      if (!handle) throw new Error('Writer not open');
      const data = new Uint8Array(req.data);
      let written = 0;
      while (written < data.length) {
        const n = handle.write(data.subarray(written), { at: position + written });
        if (n <= 0) throw new Error('Short write (disk full?)');
        written += n;
      }
      position += written;
      handle.flush();
      return { ok: true, bytes: position };
    }
    case 'patch': {
      if (!handle) throw new Error('Writer not open');
      handle.write(new Uint8Array(req.data), { at: req.offset });
      handle.flush();
      return { ok: true, bytes: position };
    }
    case 'close': {
      if (handle) {
        handle.flush();
        handle.close();
        handle = null;
      }
      return { ok: true, bytes: position };
    }
    case 'remove': {
      const dir = await recordingsDir();
      await dir.removeEntry(req.name).catch(() => undefined);
      return { ok: true, bytes: 0 };
    }
  }
}

self.onmessage = async (ev: MessageEvent<WriterRequest>) => {
  const req = ev.data;
  let res: WriterResponse;
  try {
    res = { id: req.id, ...(await handleRequest(req)) };
  } catch (e) {
    const err = e as DOMException;
    res = { id: req.id, ok: false, error: `${err.name ?? 'Error'}: ${err.message ?? String(e)}` };
  }
  self.postMessage(res);
};
