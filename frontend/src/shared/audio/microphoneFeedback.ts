export interface MicrophoneCueOutput {
  play(enabled: boolean): void;
  stop(): void;
}

// One state transition covers taps, voice commands and startup readiness.
export class MicrophoneFeedback {
  private state?: boolean;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private output: MicrophoneCueOutput) {}
  update(enabled: boolean) {
    if (this.state === enabled) return;
    const previous = this.state;
    this.state = enabled;
    this.pause();
    // Opening in a disabled state is silent; opening ready to listen is not.
    if (previous === undefined && !enabled) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { this.output.play(enabled); } catch { /* Feedback must not break capture. */ }
    }, 200);
  }
  pause() {
    clearTimeout(this.timer); this.timer = undefined;
    this.output.stop();
  }
  reset() { this.pause(); this.state = undefined; }
}

// 162 ms, 24 kHz mono: a soft ascending/descending pair with click-free edges.
export function microphoneCuePcm(enabled: boolean) {
  const rate = 24000;
  const pcm = new Uint8Array(Math.round(.162 * rate) * 2);
  const view = new DataView(pcm.buffer);
  const frequencies = enabled ? [587.33, 880] : [880, 587.33];
  for (let note = 0; note < 2; note++) {
    const start = Math.round((note === 0 ? 0 : .077) * rate);
    const length = Math.round((note === 0 ? .065 : .085) * rate);
    for (let sample = 0; sample < length; sample++) {
      const time = sample / rate;
      const edge = Math.min(1, sample / (rate * .009), (length - 1 - sample) / (rate * .025));
      const envelope = Math.sin(edge * Math.PI / 2) ** 2;
      const phase = 2 * Math.PI * frequencies[note]! * time;
      const wave = Math.sin(phase) + .12 * Math.sin(phase * 2);
      view.setInt16((start + sample) * 2, Math.round(32767 * .32 * envelope * wave), true);
    }
  }
  return pcm;
}
