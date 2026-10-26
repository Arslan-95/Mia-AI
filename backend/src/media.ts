import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from './db/database.js';
import { AppError, notFound } from './errors.js';

export type Media = { id: string; mimeType: string; byteSize: number; durationMs: number };

export function inspectWav(audio: Buffer) {
  const invalid = () => new AppError(400, 'INVALID_AUDIO', 'Upload a complete mono 16-bit PCM WAV recording, up to two minutes.');
  if (audio.length < 44 || audio.length > 12_000_000 || audio.toString('ascii', 0, 4) !== 'RIFF'
    || audio.toString('ascii', 8, 12) !== 'WAVE' || audio.readUInt32LE(4) + 8 !== audio.length) throw invalid();
  let sampleRate = 0;
  let data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > audio.length) throw invalid();
    const type = audio.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') {
      if (size < 16 || audio.readUInt16LE(start) !== 1 || audio.readUInt16LE(start + 2) !== 1
        || audio.readUInt16LE(start + 14) !== 16 || audio.readUInt16LE(start + 12) !== 2) throw invalid();
      sampleRate = audio.readUInt32LE(start + 4);
      if (sampleRate < 8000 || sampleRate > 48000 || audio.readUInt32LE(start + 8) !== sampleRate * 2) throw invalid();
    } else if (type === 'data') {
      if (data) throw invalid();
      data = audio.subarray(start, end);
    }
    offset = end + size % 2;
  }
  if (!sampleRate || !data?.length || data.length % 2) throw invalid();
  const durationMs = Math.ceil(data.length / (sampleRate * 2) * 1000);
  if (durationMs > 120_000) throw invalid();
  return { sampleRate, durationMs, pcm: data };
}

export class MediaService {
  constructor(private readonly db: Database, private readonly directory: string) {}

  async upload(userId: string, audio: Buffer): Promise<Media> {
    const { durationMs } = inspectWav(audio);
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true });
    const finalPath = join(this.directory, `${id}.wav`);
    const temporaryPath = `${finalPath}.part`;
    try {
      await writeFile(temporaryPath, audio, { flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, finalPath);
      await this.db.query(`INSERT INTO media(id,owner_id,mime_type,byte_size,digest,duration_ms)
        VALUES ($1,$2,'audio/wav',$3,$4,$5)`,
      [id, userId, audio.length, createHash('sha256').update(audio).digest('hex'), durationMs]);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(finalPath).catch(() => undefined);
      throw error;
    }
    return { id, mimeType: 'audio/wav', byteSize: audio.length, durationMs };
  }

  async read(userId: string, mediaId: string) {
    const [media] = await this.db.query<Media>(`SELECT id,mime_type AS "mimeType",byte_size AS "byteSize",duration_ms AS "durationMs"
      FROM media WHERE id = $1 AND (owner_id = $2 OR EXISTS (
        SELECT 1 FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id
        WHERE m.media_id = media.id AND cm.user_id = $2))`, [mediaId, userId]);
    if (!media) throw notFound();
    let audio: Buffer;
    try { audio = await readFile(join(this.directory, `${media.id}.wav`)); }
    catch { throw new AppError(503, 'MEDIA_UNAVAILABLE', 'The recording is temporarily unavailable.'); }
    return { ...media, audio };
  }
}
