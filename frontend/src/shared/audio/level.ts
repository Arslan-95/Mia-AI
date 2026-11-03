// Normalized RMS of mono, signed 16-bit little-endian PCM. This is only a
// visual meter; it never changes the captured or played audio.
export function pcmLevel(bytes: Uint8Array, startSample = 0, sampleCount = 1920) {
  const start = Math.max(0, Math.floor(startSample)) * 2;
  const end = Math.min(bytes.length - bytes.length % 2, start + sampleCount * 2);
  let squares = 0; let count = 0;
  for (let index = start; index < end; index += 2) {
    const raw = bytes[index]! | bytes[index + 1]! << 8;
    const sample = (raw >= 32768 ? raw - 65536 : raw) / 32768;
    squares += sample * sample; count++;
  }
  return count ? Math.min(1, Math.sqrt(squares / count) * 3) : 0;
}
