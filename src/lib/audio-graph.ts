/**
 * Audio routing for the recorder (plan §6).
 *
 *   tab audio ─► tabGain ─┬─► dest (MediaStreamDestination) ─► MediaRecorder
 *                         ├─► ctx.destination (speakers — tabCapture mutes the tab)
 *                         └─► tabAnalyser (level meter)
 *   mic (lazy) ─► micVolume (0.5–4×) ─┬─► micGain (0/1) ─► micLimiter ─► dest
 *                                     └─► micAnalyser (level meter, post-volume)
 *
 * MediaRecorder always records the same `dest` track, so turning the mic on
 * or off never touches the recorder. The mic is never routed to the speakers.
 * Once acquired, the mic stays open until the recording ends: switching off
 * only fades the gain to 0, so switching on again is instant and never
 * re-prompts. The limiter keeps a boosted mic from clipping.
 */
import { micConstraints } from './mic';

export class AudioGraph {
  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  private dest = this.ctx.createMediaStreamDestination();
  private micGain = this.ctx.createGain();
  private micVolume = this.ctx.createGain();
  private micLimiter = this.ctx.createDynamicsCompressor();
  private micStream?: MediaStream;
  private micSource?: MediaStreamAudioSourceNode;
  private readonly tabAudio?: MediaStreamTrack;
  private tabAnalyser = this.ctx.createAnalyser();
  private micAnalyser = this.ctx.createAnalyser();
  private levelBuf = new Float32Array(1024);
  private mixing: boolean;
  private micOn = false;
  /** Called when the mic device disappears (unplugged, revoked). */
  onMicLost?: () => void;

  constructor(tabStream: MediaStream) {
    this.tabAudio = tabStream.getAudioTracks()[0];
    this.tabAnalyser.fftSize = 1024;
    this.micAnalyser.fftSize = 1024;
    if (this.tabAudio) {
      const tabSrc = this.ctx.createMediaStreamSource(new MediaStream([this.tabAudio]));
      const tabGain = this.ctx.createGain();
      tabSrc.connect(tabGain);
      tabGain.connect(this.dest);
      tabGain.connect(this.ctx.destination);
      tabGain.connect(this.tabAnalyser);
    }
    this.micGain.gain.value = 0;
    // Limiter: transparent for normal speech, catches peaks when the volume is boosted.
    this.micLimiter.threshold.value = -6;
    this.micLimiter.knee.value = 0;
    this.micLimiter.ratio.value = 20;
    this.micLimiter.attack.value = 0.003;
    this.micLimiter.release.value = 0.25;
    this.micVolume.connect(this.micGain);
    this.micVolume.connect(this.micAnalyser);
    this.micGain.connect(this.micLimiter);
    this.micLimiter.connect(this.dest);
    this.mixing = false;
  }

  /** Try to start audio processing. Returns false if autoplay policy blocked it. */
  async resume(): Promise<boolean> {
    if (this.ctx.state !== 'running') {
      await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 500))]);
    }
    return this.ctx.state === 'running';
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  onStateChange(cb: (running: boolean) => void): void {
    this.ctx.onstatechange = () => cb(this.running);
  }

  /**
   * Track to hand to MediaRecorder (call once, before recording starts).
   * If the context could not start (autoplay blocked) the mixed track would
   * be silent, so fall back to the raw tab audio track: the recording stays
   * correct, but local playback and mic mixing are unavailable.
   */
  recordingTrack(): MediaStreamTrack | undefined {
    this.mixing = this.running;
    if (this.mixing) return this.dest.stream.getAudioTracks()[0];
    return this.tabAudio;
  }

  /** Whether the mic can be mixed into the recording. */
  get canMixMic(): boolean {
    return this.mixing;
  }

  get micEnabled(): boolean {
    return this.micOn;
  }

  private rms(analyser: AnalyserNode): number {
    if (!this.running) return 0;
    analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  /** Tab audio level 0–1, for the recorder window meter. */
  level(): number {
    return this.rms(this.tabAnalyser);
  }

  /** Mic level 0–1 (0 when the mic is off). */
  micLevel(): number {
    return this.micOn ? this.rms(this.micAnalyser) : 0;
  }

  /**
   * Turn the mic on or off. Throws (without changing state) if the mic cannot
   * be opened; callers check permission first so this never shows a prompt
   * in a minimised window.
   */
  async setMic(on: boolean, deviceId?: string): Promise<void> {
    if (on && !this.mixing) throw new Error('MIX_UNAVAILABLE');
    if (on && !this.micStream) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) });
      const track = stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => {
        // Device unplugged or permission revoked: drop it so the next "on" re-acquires.
        this.micSource?.disconnect();
        this.micStream = undefined;
        this.micSource = undefined;
        this.micOn = false;
        this.micGain.gain.setValueAtTime(0, this.ctx.currentTime);
        this.onMicLost?.();
      });
      this.micStream = stream;
      this.micSource = this.ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.micVolume);
    }
    this.micOn = on;
    // 20 ms fade avoids clicks.
    this.micGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  /** Mic volume multiplier; applies immediately (short ramp to avoid clicks). */
  setMicVolume(gain: number): void {
    const g = Math.min(4, Math.max(0.5, gain));
    this.micVolume.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }

  async close(): Promise<void> {
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }
}
