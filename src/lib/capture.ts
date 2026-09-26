import type { Settings } from './settings';

/** Turn a tabCapture stream id into a MediaStream (must run in an extension page). */
export async function getTabStream(streamId: string, settings: Settings): Promise<MediaStream> {
  // Chrome-specific "mandatory" constraints are the only way to consume a
  // tabCapture stream id; they are not in the standard TS types.
  const constraints = {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: settings.maxWidth,
        maxHeight: settings.maxHeight,
        maxFrameRate: settings.fps,
      },
    },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
}
