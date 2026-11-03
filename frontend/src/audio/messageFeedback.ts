import type { Message } from '../types';

type Output = { play(pcm: Uint8Array, name: string): void; stop(): void };
type Context = { userId?: string; foreground: boolean; audioBusy: boolean };

export class MessageFeedback {
  private seen = new Set<string>();
  private lastPlayed = -Infinity;
  constructor(private output: Output) {}
  receive(message: Pick<Message, 'id' | 'senderId'>, context: Context, now = Date.now()) {
    if (this.seen.has(message.id)) return;
    this.seen.add(message.id);
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    // Suppressed messages stay silent on retries; never queue a stale alert.
    if (!context.userId || message.senderId === context.userId || !context.foreground || context.audioBusy || now - this.lastPlayed < 1500) return;
    this.lastPlayed = now;
    try { this.output.play(messageCuePcm(), 'message-soft-v1'); } catch { /* Optional feedback cannot break delivery. */ }
  }
  stop() { this.output.stop(); }
  reset() { this.stop(); this.seen.clear(); this.lastPlayed = -Infinity; }
}

// One quiet, rounded 180 ms chime, including a soft attack and a fading tail.
export function messageCuePcm() {
  const rate = 24000, samples = Math.round(.18 * rate);
  const pcm = new Uint8Array(samples * 2), view = new DataView(pcm.buffer);
  for (let i = 0; i < samples; i++) {
    const time = i / rate;
    const attack = Math.min(1, time / .012);
    const tail = Math.sin(Math.PI / 2 * (1 - i / (samples - 1))) ** 2;
    const wave = Math.sin(2 * Math.PI * 784 * time) + .15 * Math.sin(2 * Math.PI * 1174.66 * time);
    view.setInt16(i * 2, Math.round(32767 * .1 * attack * tail * wave), true);
  }
  return pcm;
}
