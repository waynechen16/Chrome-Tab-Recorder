/** Microphone helpers shared by the recorder window, popup and options page. */

export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

/** Current microphone permission for this extension's origin. */
export async function micPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state;
  } catch {
    return 'unknown';
  }
}

/** Constraints used everywhere the mic is opened, so the test matches the recording. */
export function micConstraints(deviceId?: string): MediaTrackConstraints {
  return {
    // `ideal` so a missing saved device falls back to the system default.
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

/** Human-readable reason a mic could not be opened. */
export function micErrorMessage(e: unknown): string {
  const name = (e as DOMException)?.name ?? '';
  const msg = (e as Error)?.message ?? String(e);
  if (msg === 'NOT_GRANTED' || name === 'NotAllowedError' || name === 'SecurityError') {
    return '尚未授權麥克風：請到設定頁按「授權並測試麥克風」。';
  }
  if (msg === 'MIX_UNAVAILABLE') {
    return '課程聲音回放被瀏覽器暫停，這次錄製無法混入麥克風。下次開始錄製前先在錄製視窗點一下提示即可。';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到麥克風裝置。';
  if (name === 'NotReadableError') return '麥克風正被其他程式占用或無法讀取。';
  return `無法開啟麥克風：${msg}`;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** Audio input devices (labels are only available after permission is granted). */
export async function listMics(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `麥克風 ${i + 1}` }));
}
