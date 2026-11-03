// Produces short, generic listening samples. ASR checks the spoken words only;
// a person still needs to assess naturalness and the degree of expression.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { CloudSpeechProvider } from '../src/speech/providers.js';
import { inspectWav } from '../src/media.js';
import type { SpeechOptions } from '../src/speech/delivery.js';

const config = readConfig();
assert.equal(config.googleTtsModel, 'gemini-3.1-flash-tts-preview');
const provider = new CloudSpeechProvider(config);
const cases: { name: string; text: string; options: SpeechOptions }[] = [
  { name: 'calm', text: 'Hello. The notebook is on the desk.', options: {} },
  { name: 'gentle', text: 'You can take a pause. We can continue when you are ready.',
    options: { delivery: { tone: 'gentle', pace: 'unhurried', warmth: 'reserved' } } },
  { name: 'light', text: 'The notebook is taking a day off. We can try again tomorrow.',
    options: { delivery: { tone: 'light', pace: 'steady', warmth: 'friendly' } } },
  { name: 'narration', text: 'Ben wrote: The notebook is on the desk.', options: { narration: true } },
];
const directory = new URL('../.data/voice-samples/', import.meta.url);
await mkdir(directory, { recursive: true });
const results = [];
const words = (text: string) => text.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
for (const sample of cases) {
  const started = Date.now(), chunks = [];
  for await (const chunk of provider.synthesize(sample.text, AbortSignal.timeout(60_000), sample.options)) chunks.push(Buffer.from(chunk));
  const pcm = Buffer.concat(chunks), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const audio = Buffer.concat([header, pcm]), synthesisMs = Date.now() - started;
  inspectWav(audio);
  await writeFile(new URL(`${sample.name}.wav`, directory), audio);
  const transcripts = [await provider.transcribe(audio, AbortSignal.timeout(60_000))];
  // The recognizer can repeat words nondeterministically. Recheck the SAME audio
  // once rather than regenerating a sample to hide a synthesis defect.
  if (words(transcripts[0]!) !== words(sample.text)) transcripts.push(await provider.transcribe(audio, AbortSignal.timeout(60_000)));
  results.push({ ...sample, transcripts, synthesisMs, audioSeconds: pcm.length / 48_000 });
  console.info(JSON.stringify(results.at(-1)));
  assert.ok(transcripts.some(transcript => words(transcript) === words(sample.text)), 'ASR should hear exactly the supplied words, without delivery metadata.');
}
await writeFile(new URL('report.json', directory), JSON.stringify({ time: new Date().toISOString(),
  model: config.googleTtsModel, voice: config.googleTtsVoice, scope: 'Real Gemini synthesis and Meta transcription; human listening required for naturalness.', results }, null, 2));
console.info(`PASS: ${results.length} real synthesis/transcription samples.`);
