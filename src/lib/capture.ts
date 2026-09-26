import { RESOLUTION_BOX, type Settings } from './settings';

export interface Size {
  width: number;
  height: number;
}

const MAX_TAB_SIZE: Size = { width: 3840, height: 2160 };
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Size limit for the captured video.
 * - Presets are a bounding box: the tab is scaled to fit, keeping its aspect.
 * - 'tab' uses the tab's own size in device pixels (sharp on Retina, never
 *   upscaled), capped at 4K.
 * Encoders need even dimensions.
 */
export function captureSize(settings: Pick<Settings, 'resolution'>, tab: Size | undefined, dpr: number): Size {
  if (settings.resolution === 'tab' && tab && tab.width > 0 && tab.height > 0) {
    let w = tab.width * dpr;
    let h = tab.height * dpr;
    const scale = Math.min(1, MAX_TAB_SIZE.width / w, MAX_TAB_SIZE.height / h);
    w *= scale;
    h *= scale;
    return { width: even(w), height: even(h) };
  }
  const box = settings.resolution === 'tab' ? RESOLUTION_BOX['1080p'] : RESOLUTION_BOX[settings.resolution];
  return { ...box };
}

/** Turn a tabCapture stream id into a MediaStream (must run in an extension page). */
export async function getTabStream(streamId: string, size: Size, fps: number): Promise<MediaStream> {
  // Chrome-specific "mandatory" constraints are the only way to consume a
  // tabCapture stream id; they are not in the standard TS types.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: size.width,
        maxHeight: size.height,
        maxFrameRate: fps,
      },
    },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}
