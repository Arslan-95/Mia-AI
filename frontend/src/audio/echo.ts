// A residual-echo guard AFTER iOS voice-processing AEC. It compares audio,
// never text, so a person can repeat the exact words spoken by the assistant.
// It only suppresses high-confidence copies of the speaker reference. It is
// not a replacement for the platform's adaptive acoustic echo canceller.
const rate = 24000;
const stride = 12; // 2 kHz coarse timing search; full-rate audio confirms it.
const windowSamples = 1920; // 80 ms of input, retained until classified.
const tailMs = 800;
type Reference = { id: string; samples: Float32Array; bytes: Uint8Array; start: number; end: number };

function sample(bytes: Uint8Array, index: number) {
  const raw = bytes[index * 2]! | bytes[index * 2 + 1]! << 8;
  return (raw >= 32768 ? raw - 65536 : raw) / 32768;
}
function downsample(bytes: Uint8Array) {
  const values = new Float32Array(Math.floor(bytes.length / (2 * stride)));
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < stride; j++) sum += sample(bytes, i * stride + j);
    values[i] = sum / stride;
  }
  return values;
}
export class ResidualEchoGuard {
  private references: Reference[] = [];
  private pending = new Uint8Array(0);
  readonly stats = { echoFrames: 0, speechFrames: 0, quietFrames: 0 };
  begin(bytes: Uint8Array, id: string, now = Date.now()) {
    this.prune(now);
    this.references.push({ id, samples: downsample(bytes), bytes, start: now, end: Infinity });
    this.references = this.references.slice(-2);
  }
  end(id: string, now = Date.now()) {
    const ref = this.references.find(value => value.id === id);
    if (ref) ref.end = Math.min(ref.end, now);
  }
  reset() { this.references = []; this.pending = new Uint8Array(0); }
  private prune(now: number) { this.references = this.references.filter(ref => now <= ref.end + tailMs); }
  process(bytes: Uint8Array, now = Date.now()): Uint8Array[] {
    this.prune(now);
    if (!this.references.length && !this.pending.length) return [bytes];
    const input = new Uint8Array(this.pending.length + bytes.length);
    input.set(this.pending); input.set(bytes, this.pending.length);
    const result: Uint8Array[] = [];
    let offset = 0;
    for (; offset + windowSamples * 2 <= input.length; offset += windowSamples * 2) {
      const part = input.subarray(offset, offset + windowSamples * 2);
      const capturedEnd = now - (input.length - offset - part.length) / (rate * 2) * 1000;
      result.push(this.classify(part, capturedEnd) ? new Uint8Array(part.length) : part.slice());
    }
    this.pending = input.slice(offset);
    if (!this.references.length && this.pending.length) { result.push(this.pending); this.pending = new Uint8Array(0); }
    return result;
  }
  private classify(bytes: Uint8Array, now: number) {
    if (!this.references.length) return false;
    let fullSum = 0, fullSquare = 0;
    const fullCount = bytes.length / 2;
    for (let i = 0; i < fullCount; i++) {
      const value = sample(bytes, i); fullSum += value; fullSquare += value * value;
    }
    const fullEnergy = Math.max(0, fullSquare - fullSum * fullSum / fullCount);
    const fullRms = Math.sqrt(fullEnergy / fullCount);
    if (fullRms < 0.0004) { this.stats.quietFrames++; return true; }
    const mic = downsample(bytes);
    const n = mic.length;
    let sum = 0, square = 0;
    for (const value of mic) { sum += value; square += value * value; }
    const energy = Math.max(0, square - sum * sum / n);
    // Search clock/tap/acoustic delay instead of assuming that scheduling PCM
    // means it reached the loudspeaker at the same millisecond. Normalized
    // correlation tolerates speaker volume changes and polarity inversion.
    for (const ref of this.references) {
      const center = Math.round((now - ref.start) * 2) - n;
      const first = Math.max(0, center - 1800);
      const last = Math.min(ref.samples.length - n, center + 200);
      let refSum = 0, refSquare = 0;
      let bestAt = -1, bestCorrelation = 0;
      for (let j = 0; j < n && first + j < ref.samples.length; j++) {
        const value = ref.samples[first + j]!; refSum += value; refSquare += value * value;
      }
      for (let at = first; at <= last; at++) {
        const refEnergy = refSquare - refSum * refSum / n;
        if (refEnergy > 1e-9) {
          let dot = 0;
          for (let j = 0; j < n; j++) dot += mic[j]! * ref.samples[at + j]!;
          const covariance = dot - sum * refSum / n;
          const correlation = Math.min(1, covariance * covariance / (energy * refEnergy));
          if (correlation > bestCorrelation) { bestCorrelation = correlation; bestAt = at; }
        }
        const outgoing = ref.samples[at]!, incoming = ref.samples[at + n] ?? 0;
        refSum += incoming - outgoing; refSquare += incoming * incoming - outgoing * outgoing;
      }
      if (bestCorrelation < 0.9 || bestAt < 0) continue;
      // The timing search omits high frequencies. Never suppress a whole
      // frame on that evidence alone: near-end consonants can be absent from
      // the coarse signal. Confirm the match using the original 24 kHz PCM,
      // including sub-stride delay, before rejecting an echo-only frame.
      for (let at = Math.max(0, bestAt * stride - stride); at <= bestAt * stride + stride && at + fullCount <= ref.bytes.length / 2; at++) {
        let referenceSum = 0, referenceSquare = 0, dot = 0;
        for (let i = 0; i < fullCount; i++) {
          const value = sample(ref.bytes, at + i);
          referenceSum += value; referenceSquare += value * value; dot += value * sample(bytes, i);
        }
        const referenceEnergy = referenceSquare - referenceSum * referenceSum / fullCount;
        if (referenceEnergy <= 1e-9) continue;
        const covariance = dot - fullSum * referenceSum / fullCount;
        const correlation = Math.min(1, covariance * covariance / (fullEnergy * referenceEnergy));
        const residualRms = Math.sqrt(Math.max(0, fullEnergy * (1 - correlation)) / fullCount);
        if (correlation > 0.95 && residualRms < Math.max(0.0004, fullRms * 0.1)) {
          this.stats.echoFrames++; return true;
        }
      }
    }
    this.stats.speechFrames++; return false;
  }
}
