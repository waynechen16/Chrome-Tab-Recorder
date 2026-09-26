/** Messages between OpfsSink (page) and opfs-writer.worker.ts. */
export type WriterRequest =
  | { id: number; op: 'open'; name: string }
  | { id: number; op: 'write'; data: ArrayBuffer }
  | { id: number; op: 'patch'; offset: number; data: ArrayBuffer }
  | { id: number; op: 'close' }
  | { id: number; op: 'remove'; name: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WriterRequestBody = DistributiveOmit<WriterRequest, 'id'>;

export type WriterResponseBody = { ok: true; bytes: number } | { ok: false; error: string };
export type WriterResponse = { id: number; ok: true; bytes: number } | { id: number; ok: false; error: string };
