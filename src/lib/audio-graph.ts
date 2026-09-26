/**
 * Audio routing for the recorder (plan §6).
 *
 *   tab audio ─► tabGain ─┬─► dest (MediaStreamDestination) ─► MediaRecorder
 *                         └─► ctx.destination (speakers — tabCapture mutes the tab)
 *   mic (lazy) ─► micGain (0/1) ─► dest
 *
 * MediaRecorder always records the same `dest` track, so turning the mic on
 * or off never touches the recorder. The mic is never routed to the speakers.
 */
export class AudioGraph {
  private ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
  private dest = this.ctx.createMediaStreamDestination();
  private micGain = this.ctx.createGain();
  private micStream?: MediaStream;
  private readonly tabAudio?: MediaStreamTrack;
  private analyser = this.ctx.createAnalyser();
  private levelBuf = new Float32Array(1024);

  constructor(tabStream: MediaStream) {
    this.tabAudio = tabStream.getAudioTracks()[0];
    if (this.tabAudio) {
      const tabSrc = this.ctx.createMediaStreamSource(new MediaStream([this.tabAudio]));
      const tabGain = this.ctx.createGain();
      tabSrc.connect(tabGain);
      tabGain.connect(this.dest);
      tabGain.connect(this.ctx.destination);
      this.analyser.fftSize = 1024;
      tabGain.connect(this.analyser);
    }
    this.micGain.gain.value = 0;
    this.micGain.connect(this.dest);
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
   * Track to hand to MediaRecorder. If the context could not start (autoplay
   * blocked) the mixed track would be silent, so fall back to the raw tab
   * audio track: the recording stays correct, only local playback is missing.
   */
  recordingTrack(): MediaStreamTrack | undefined {
    if (this.running) return this.dest.stream.getAudioTracks()[0];
    return this.tabAudio;
  }

  /** Current tab audio level 0–1 (RMS), for the recorder window meter. */
  level(): number {
    if (!this.running) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf);
    let sum = 0;
    for (const v of this.levelBuf) sum += v * v;
    return Math.min(1, Math.sqrt(sum / this.levelBuf.length) * 4);
  }

  /** Mic mixing (UI arrives in M2). */
  async setMic(on: boolean, deviceId?: string): Promise<void> {
    if (on && !this.micStream) {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.ctx.createMediaStreamSource(this.micStream).connect(this.micGain);
    }
    this.micGain.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.02);
  }

  async close(): Promise<void> {
    this.micStream?.getTracks().forEach((t) => t.stop());
    if (this.ctx.state !== 'closed') await this.ctx.close();
  }
}
