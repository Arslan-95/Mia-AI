type Entry = { time: number; stage: string; durationMs?: number; bytes?: number; elapsedMs?: number };
const entries: Entry[] = [];
// Development-only counters; never record audio, message text or credentials.
export const getVoiceNoteDiagnostics = () => [...entries];
export function diagnoseVoiceNote(stage: string, detail: Omit<Entry, 'time' | 'stage'> = {}) {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  entries.push({ time: Date.now(), stage, ...detail });
  if (entries.length > 60) entries.shift();
}
