import { concatBytes } from './wav';

// Queue two batches on the native player. This lets it join them without a JS
// round trip at the boundary and keeps a short buffer against network jitter.
export class StreamedSpeech {
  private parts: Uint8Array[] = [];
  private bytes = 0;
  private queued: Uint8Array[] = [];
  private playing = 0;
  private ended = false;
  private stopped = false;
  private started = false;

  constructor(private play: (bytes: Uint8Array) => Promise<void>,
    private start: () => void, private settle: (error?: unknown) => void) {}

  push(bytes: Uint8Array) {
    if (this.stopped || this.ended) return;
    this.parts.push(bytes);
    this.bytes += bytes.length;
    if (this.bytes >= 12_000) this.flush();
    this.pump();
  }

  finish() {
    if (this.stopped) return;
    this.ended = true;
    if (this.bytes) this.flush();
    this.pump();
  }

  cancel() {
    this.stopped = true;
    this.parts = [];
    this.queued = [];
  }

  private flush() {
    this.queued.push(concatBytes(this.parts));
    this.parts = [];
    this.bytes = 0;
  }

  private pump() {
    if (this.stopped) return;
    while (this.playing < 2 && this.queued.length) {
      const bytes = this.queued.shift()!;
      if (!this.started) { this.started = true; this.start(); }
      this.playing++;
      void this.play(bytes).then(() => {
        this.playing--;
        this.pump();
      }, error => {
        if (this.stopped) return;
        this.cancel();
        this.settle(error);
      });
    }
    if (this.ended && !this.playing) {
      this.cancel();
      this.settle();
    }
  }
}
