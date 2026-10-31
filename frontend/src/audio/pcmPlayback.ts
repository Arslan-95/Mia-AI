import { CancelledError, UserFacingError } from '../errors';
import type { PlaybackProgress } from './types';

// Pause the shared native player without releasing its microphone graph.
// Resume schedules the remaining original samples, never a second full copy.
export class PcmPlayback {
  private offset = 0;
  private started = 0;
  private paused = false;
  private segmentPaused = false;
  private playing = false;
  private wake?: () => void;
  private barrier = Promise.resolve();
  constructor(private pcm: Uint8Array, private playPart: (bytes: Uint8Array) => Promise<void>, private stopPart: () => Promise<void>) {}
  get durationMs() { return this.pcm.length / 48; }
  private position() { return Math.min(this.durationMs, this.offset + (this.playing && !this.paused ? Date.now() - this.started : 0)); }
  async pause() {
    if (this.paused || !this.playing) return;
    this.offset = this.position(); this.paused = true; this.segmentPaused = true;
    this.barrier = this.stopPart(); await this.barrier;
  }
  resume() { if (!this.paused) return; this.paused = false; this.wake?.(); this.wake = undefined; }
  async play(signal: AbortSignal, report?: (progress: PlaybackProgress) => void) {
    let stalled = false;
    const progress = () => report?.({ positionMs: this.position(), durationMs: this.durationMs, playing: this.playing && !this.paused, buffering: false });
    const cancel = () => { this.wake?.(); void this.stopPart().catch(() => {}); };
    const timer = setInterval(() => {
      progress();
      if (this.playing && !this.paused && Date.now() - this.started > this.durationMs - this.offset + 5000) {
        stalled = true; void this.stopPart().catch(() => {});
      }
    }, 100);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (this.offset < this.durationMs) {
        if (signal.aborted) throw new CancelledError();
        await this.barrier;
        if (signal.aborted) throw new CancelledError();
        if (this.paused) { progress(); await new Promise<void>(resolve => { this.wake = resolve; if (signal.aborted) resolve(); }); continue; }
        this.started = Date.now(); this.segmentPaused = false; this.playing = true;
        const sample = Math.min(this.pcm.length / 2, Math.floor(this.offset * 24));
        const part = this.playPart(this.pcm.subarray(sample * 2)); progress();
        try { await part; }
        catch (error) { if (stalled) throw new UserFacingError('Playback did not finish. Please try again.'); if (!this.segmentPaused || signal.aborted) throw error; }
        this.playing = false;
        if (signal.aborted) throw new CancelledError();
        if (!this.segmentPaused) this.offset = this.durationMs;
      }
      progress();
    } finally { clearInterval(timer); signal.removeEventListener('abort', cancel); this.playing = false; this.wake = undefined; }
  }
}
