import { Directory, File, Paths } from 'expo-file-system';
import type { CachedVoice, VoiceMediaStore } from './mediaCache';

// Keep URL escapes literal in file:// paths; underscores are escaped as well
// so two different server/account/media identifiers cannot share a directory.
const segment = (value: string) => encodeURIComponent(value).replace(/_/g, '%5F').replace(/%/g, '_');

/** Only complete WAVs appear under their media ID; interrupted writes remain .part files. */
export class FileVoiceMediaStore implements VoiceMediaStore {
  private directory: Directory;
  private records: Map<string, CachedVoice> | undefined;
  constructor(server: string, userId: string) {
    this.directory = new Directory(Paths.cache, 'mia-voice-v1', `server-${segment(server)}`, `user-${segment(userId)}`);
  }
  private file(id: string) { return new File(this.directory, `media-${segment(id)}.wav`); }
  private load() {
    if (this.records) return this.records;
    this.directory.create({ intermediates: true, idempotent: true });
    const records = new Map<string, CachedVoice>();
    let times: Record<string, number> = {};
    try { times = JSON.parse(new File(this.directory, 'access.json').textSync()); } catch { /* Rebuild from files after eviction or a crash. */ }
    for (const file of this.directory.list()) {
      if (!(file instanceof File)) continue;
      if (file.name.endsWith('.part')) { try { file.delete(); } catch {} continue; }
      if (!file.name.startsWith('media-') || !file.name.endsWith('.wav')) continue;
      try {
        const id = decodeURIComponent(file.name.slice(6, -4).replace(/_/g, '%'));
        records.set(id, { id, uri: file.uri, size: file.size, usedAt: Number.isFinite(times?.[id]) ? times[id]! : file.modificationTime ?? 0 });
      } catch { /* Ignore unrelated files. */ }
    }
    this.records = records; return records;
  }
  private saveTimes() {
    try { new File(this.directory, 'access.json').write(JSON.stringify(Object.fromEntries([...this.load()].map(([id, item]) => [id, item.usedAt])))); } catch {}
  }
  entries() { return [...this.load().keys()].map(id => this.lookup(id)).filter((entry): entry is CachedVoice => !!entry); }
  lookup(id: string) {
    const records = this.load(), file = this.file(id);
    if (!file.exists) { records.delete(id); return null; }
    const entry = { id, uri: file.uri, size: file.size, usedAt: records.get(id)?.usedAt ?? file.modificationTime ?? 0 };
    records.set(id, entry); return entry;
  }
  read(id: string) { return this.file(id).bytes(); }
  write(id: string, bytes: Uint8Array, usedAt: number) { return this.commit(id, usedAt, file => file.write(bytes)); }
  copy(id: string, sourceUri: string, usedAt: number) { return this.commit(id, usedAt, file => new File(sourceUri).copy(file)); }
  private commit(id: string, usedAt: number, write: (file: File) => void) {
    this.load();
    const existing = this.lookup(id);
    if (existing) { this.touch(id, usedAt); return existing; }
    const temporary = new File(this.directory, `write-${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
    try {
      write(temporary); temporary.move(this.file(id));
      const entry = { id, uri: this.file(id).uri, size: temporary.size, usedAt };
      this.records!.set(id, entry); this.saveTimes(); return entry;
    } finally { if (temporary.exists && temporary.uri.endsWith('.part')) temporary.delete(); }
  }
  touch(id: string, usedAt: number) {
    const entry = this.load().get(id); if (entry) { entry.usedAt = usedAt; this.saveTimes(); }
  }
  remove(id: string) {
    this.load(); const file = this.file(id); if (file.exists) file.delete();
    this.records!.delete(id); this.saveTimes();
  }
}
