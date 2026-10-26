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
