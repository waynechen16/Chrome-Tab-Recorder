/** Repair and export an unfinished recording left in OPFS (plan §7, §9). */
import { removePending } from './pending';
import { OpfsSink, type ExportResult, type ExportTarget } from './storage/sink';
import { encodeDurationValue } from './webm/duration-patch';
import { analyzeRecording } from './webm/recover';

export interface RepairResult extends ExportResult {
  durationMs: number | null;
  durationFixed: boolean;
}

export async function repairAndExport(name: string, target: ExportTarget): Promise<RepairResult> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('recordings');
  const file = await (await dir.getFileHandle(name)).getFile();
  const analysis = await analyzeRecording(file);
  let sink: OpfsSink;
  try {
    sink = await OpfsSink.adopt(name);
  } catch (e) {
    const n = (e as DOMException).name;
    if (n === 'NoModificationAllowedError' || n === 'InvalidStateError') {
      throw new Error('這個檔案正在被錄製視窗使用中');
    }
    throw e;
  }
  try {
    let durationFixed = false;
    if (analysis.durationOffset !== null && analysis.durationMs !== null) {
      await sink.patchAt(analysis.durationOffset, encodeDurationValue(analysis.durationMs, analysis.timecodeScale));
      durationFixed = true;
    }
    const result = await sink.finalize(target);
    await removePending(name);
    return { ...result, durationMs: analysis.durationMs, durationFixed };
  } finally {
    sink.terminate();
  }
}

export async function discardRecording(name: string): Promise<void> {
  await OpfsSink.discard(name);
  await removePending(name);
}
