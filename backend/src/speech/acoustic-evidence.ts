// Track sustained input after AEC on Meta's audio timeline, independent of
// network, endpointing and database delays. No audio payloads are stored.
export class AcousticEvidence {
  private voiced: { start: number; end: number }[] = [];
  position = 0;
  reset() { this.voiced = []; this.position = 0; }
  consumeThrough(time: number) { this.voiced = this.voiced.filter(part => part.end > time); }
  observe(bytes: Uint8Array) {
    const samples = Math.floor(bytes.length / 2);
    for (let start = 0; start < samples; start += 240) {
      const count = Math.min(240, samples - start);
      let sum = 0, square = 0;
      for (let i = start; i < start + count; i++) {
        const raw = bytes[i * 2]! | bytes[i * 2 + 1]! << 8;
        const value = (raw >= 32768 ? raw - 65536 : raw) / 32768;
        sum += value; square += value * value;
      }
      if (Math.sqrt(Math.max(0, square / count - (sum / count) ** 2)) >= 0.0012) {
        this.voiced.push({ start: this.position + start / 24, end: this.position + (start + count) / 24 });
      }
    }
    this.position += samples / 24;
    // At most 30 seconds of 10 ms energy measurements, never PCM payloads.
    this.voiced = this.voiced.filter(part => part.end > this.position - 30000);
  }
  hasSpeech(at = this.position) {
    const end = Math.min(at, this.position), start = end - 2000;
    return this.voiced.reduce((sum, part) => sum + Math.max(0, Math.min(end, part.end) - Math.max(start, part.start)), 0) >= 50;
  }
}
