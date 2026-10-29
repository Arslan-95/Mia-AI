// A double-talk gate AFTER iOS voice-processing AEC. While Mia plays, the
// residual of her voice is distorted, so it cannot be matched sample by
// sample; but the device knows exactly how loud she is at each moment. Input
// is forwarded to recognition only while it is clearly louder than her echo
// is expected to be; otherwise silence of the same length is sent, keeping
// the recognition timeline intact.
const rate = 24000;
const frameSamples = 480; // 20 ms
const frameMs = 20;
const lookahead = 10; // frames held while deciding, so speech onset is kept
const window = 10; // frames considered for one decision
const required = 7; // loud frames within the window to open the gate
const hangover = 40; // frames kept open after the last decision (800 ms)
const tailMs = 500; // room reverberation and tap delay after playback ends
const lookBackMs = 400; // playback start, output and tap latency
const lookAheadMs = 40;
const marginDb = 10;
const floorDb = -50;
const silentDb = -100;
// Residual echo relative to the playback level, learned per capture session
// (a route change restarts it). It starts conservatively: Mia is harder to
// interrupt at first. The lower bound keeps AEC reconvergence (volume keys,
// moving the phone) from opening the gate when VPIO usually suppresses all.
const initialCouplingDb = -15;
const minCouplingDb = -35;
const maxCouplingDb = 10;
const packetBytes = 3840; // the server accepts at most 8192 bytes per frame
type Reference = { id: string; levels: Float32Array; start: number; end: number };
type Frame = { index: number; bytes: Uint8Array; guarded: boolean };

function decibels(bytes: Uint8Array, offset = 0, samples = bytes.length / 2) {
  let square = 0;
  for (let i = 0; i < samples; i++) {
    const raw = bytes[offset + i * 2]! | bytes[offset + i * 2 + 1]! << 8;
    const value = (raw >= 32768 ? raw - 65536 : raw) / 32768;
    square += value * value;
  }
  return square > 0 ? 10 * Math.log10(square / samples) : silentDb;
}
function levels(bytes: Uint8Array) {
  const values = new Float32Array(Math.ceil(bytes.length / 2 / frameSamples));
  for (let i = 0; i < values.length; i++) {
    const offset = i * frameSamples * 2;
    values[i] = decibels(bytes, offset, Math.min(frameSamples, (bytes.length - offset) / 2));
  }
  return values;
}

export class PlaybackEchoGate {
  private references: Reference[] = [];
  private pending = new Uint8Array(0);
  private queue: Frame[] = [];
  private recent: boolean[] = [];
  private index = 0;
  private open = { from: -1, through: -2 };
  private openFrames = 0;
  coupling = initialCouplingDb;
  readonly stats = { passedFrames: 0, gatedFrames: 0, openings: 0 };
  begin(bytes: Uint8Array, id: string, now = Date.now()) {
    this.prune(now);
    this.references.push({ id, levels: levels(bytes), start: now, end: now + bytes.length / 2 / rate * 1000 + 1000 });
    this.references = this.references.slice(-2);
  }
  end(id: string, now = Date.now()) {
    const ref = this.references.find(value => value.id === id);
    if (ref) ref.end = Math.min(ref.end, now);
  }
  reset() {
    this.references = []; this.pending = new Uint8Array(0); this.queue = []; this.recent = [];
    this.open = { from: -1, through: -2 }; this.openFrames = 0; this.coupling = initialCouplingDb;
  }
  discardInput() {
    this.pending = new Uint8Array(0); this.queue = []; this.recent = [];
    this.open = { from: -1, through: -2 }; this.openFrames = 0;
  }
  private prune(now: number) { this.references = this.references.filter(ref => now <= ref.end + tailMs); }
  process(bytes: Uint8Array, now = Date.now()): Uint8Array[] {
    this.prune(now);
    if (!this.references.length && !this.queue.length && !this.pending.length) return [bytes];
    const input = new Uint8Array(this.pending.length + bytes.length);
    input.set(this.pending); input.set(bytes, this.pending.length);
    const result: Uint8Array[] = [];
    let offset = 0;
    for (; offset + frameSamples * 2 <= input.length; offset += frameSamples * 2) {
      const part = input.slice(offset, offset + frameSamples * 2);
      const capturedAt = now - (input.length - offset - part.length) / 2 / rate * 1000;
      this.classify(part, capturedAt);
      this.queue.push({ index: this.index++, bytes: part, guarded: this.references.length > 0 });
      if (this.queue.length > lookahead) result.push(this.release(this.queue.shift()!));
    }
    this.pending = input.slice(offset);
    if (!this.references.length) {
      for (const frame of this.queue) result.push(this.release(frame));
      this.queue = [];
      if (this.pending.length) { result.push(this.pending); this.pending = new Uint8Array(0); }
    }
    // Released frames are regrouped into packets no larger than the native
    // ones; a flush of the held frames must not exceed the server's limit.
    if (result.length < 2) return result;
    const joined = new Uint8Array(result.reduce((sum, part) => sum + part.length, 0));
    result.reduce((at, part) => { joined.set(part, at); return at + part.length; }, 0);
    const packets: Uint8Array[] = [];
    for (let at = 0; at < joined.length; at += packetBytes) packets.push(joined.subarray(at, at + packetBytes));
    return packets;
  }
  private release(frame: Frame) {
    if (!frame.guarded || frame.index >= this.open.from && frame.index <= this.open.through) { this.stats.passedFrames++; return frame.bytes; }
    this.stats.gatedFrames++; return new Uint8Array(frame.bytes.length);
  }
  private playbackLevel(at: number) {
    let level = silentDb;
    for (const ref of this.references) {
      if (at - lookBackMs > ref.end) continue;
      // Audio after a cancelled playback was never played.
      const first = Math.max(0, Math.floor((at - lookBackMs - ref.start) / frameMs));
      const last = Math.min(ref.levels.length - 1, Math.floor((Math.min(at + lookAheadMs, ref.end) - ref.start) / frameMs));
      for (let i = first; i <= last; i++) level = Math.max(level, ref.levels[i]!);
    }
    return level;
  }
  private classify(bytes: Uint8Array, at: number) {
    const mic = decibels(bytes), playback = this.playbackLevel(at);
    const loud = mic > Math.max(playback + this.coupling + marginDb, floorDb);
    const gateOpen = this.index <= this.open.through;
    if (playback > -40) {
      // Track a high quantile of the residual, learning only from frames that
      // are not a person speaking over Mia. If the gate stays open while Mia
      // keeps playing, the estimate is too low: raise it slowly (2.5 dB/s).
      if (!loud && !gateOpen) this.coupling += mic - playback > this.coupling ? 0.8 : -0.2;
      this.openFrames = gateOpen ? this.openFrames + 1 : 0;
      if (this.openFrames > 100) this.coupling += 0.05;
      this.coupling = Math.max(minCouplingDb, Math.min(maxCouplingDb, this.coupling));
    }
    this.recent.push(loud); if (this.recent.length > window) this.recent.shift();
    if (this.recent.filter(Boolean).length < required) return;
    const first = this.index - window + 1;
    if (first > this.open.through + 1) { this.open.from = first; this.stats.openings++; }
    this.open.through = this.index + hangover;
  }
}
