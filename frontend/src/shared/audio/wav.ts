export function pcmWav(pcm: Uint8Array, sampleRate = 24000) {
  if (pcm.length % 2 || sampleRate < 8000 || sampleRate > 48000) throw new Error('Invalid PCM audio.');
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  const label = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  label(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data'); view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44); return bytes;
}
export function concatBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}

// Stored voice notes are mono PCM WAV, 8–48 kHz. The shared voice graph plays
// 24 kHz PCM; resample the original recording without opening another session.
export function playbackPcm(wav: Uint8Array) {
  const invalid = () => new Error('The voice recording is not a supported PCM WAV file.');
  if (wav.length < 44 || wav.length > 12_000_000) throw invalid();
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== wav.length) throw invalid();
  let rate = 0, pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size;
    if (end > wav.length) throw invalid();
    if (tag(offset) === 'fmt ') {
      if (size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint16(start + 12, true) !== 2 || view.getUint16(start + 14, true) !== 16) throw invalid();
      rate = view.getUint32(start + 4, true);
      if (rate < 8000 || rate > 48000 || view.getUint32(start + 8, true) !== rate * 2) throw invalid();
    } else if (tag(offset) === 'data') { if (pcm) throw invalid(); pcm = wav.subarray(start, end); }
    offset = end + size % 2;
  }
  if (!rate || !pcm?.length || pcm.length % 2 || pcm.length / (rate * 2) > 120) throw invalid();
  if (rate === 24000) return pcm;
  const source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength), count = pcm.length / 2;
  const result = new Uint8Array(Math.round(count * 24000 / rate) * 2), output = new DataView(result.buffer);
  for (let i = 0; i < result.length / 2; i++) {
    const position = i * rate / 24000, left = Math.min(count - 1, Math.floor(position)), fraction = position - left;
    const a = source.getInt16(left * 2, true), b = source.getInt16(Math.min(left + 1, count - 1) * 2, true);
    output.setInt16(i * 2, Math.round(a + (b - a) * fraction), true);
  }
  return result;
}
