import { CancelledError, UserFacingError } from '../errors';
import { playbackPcm } from './wav';

export type CachedVoice = { id: string; uri: string; size: number; usedAt: number };
export interface VoiceMediaStore {
  entries(): CachedVoice[];
  lookup(id: string): CachedVoice | null;
  read(id: string): Promise<Uint8Array>;
  write(id: string, bytes: Uint8Array, usedAt: number): CachedVoice;
  copy(id: string, sourceUri: string, usedAt: number): CachedVoice;
  touch(id: string, usedAt: number): void;
  remove(id: string): void;
}
type Task = {
  id: string; priority: number; background: boolean; users: number;
  controller: AbortController; promise: Promise<string>; resolve(uri: string): void; reject(error: unknown): void;
};

/** Account-scoped disk cache shared by the classic player and Mia's PCM player. */
export class VoiceMediaCache {
  private tasks = new Map<string, Task>();
  private queue: Task[] = [];
  private active = 0;
  private pins = new Map<string, number>();
  private validated = new Map<string, number>();
  private prefetched = new Set<string>();
  private backgroundEnabled = true;
  private closed = false;
  constructor(private store: VoiceMediaStore, private options: {
    baseUrl: string; token: string; maxBytes?: number; onUnauthorized?(): void;
  }) {}
  updateToken(token: string) { this.options.token = token; }
  activate() { this.closed = false; }

  prefetch(ids: readonly string[], visible = false) {
    if (this.closed || !this.backgroundEnabled) return;
    for (const id of new Set(ids)) {
      try {
        if (this.store.lookup(id)) { this.prefetched.add(id); continue; }
        // Eviction must not cause every chat refresh to download old media
        // again. A deliberate scroll or Play can still fetch it on demand.
        if (!visible && this.prefetched.has(id)) continue;
        this.enqueue(id, visible ? 1 : 2, true);
      } catch { /* Prefetch must not interrupt chat navigation. */ }
    }
  }

  async acquire(id: string, signal?: AbortSignal): Promise<{ uri: string; release(): void }> {
    this.check(signal);
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.pins.get(id) ?? 1) - 1;
      if (count) this.pins.set(id, count); else this.pins.delete(id);
      this.prune();
    };
    try {
      const existing = this.store.lookup(id);
      if (existing) {
        let valid = this.validated.get(id) === existing.size;
        if (!valid) {
          try { playbackPcm(await this.store.read(id)); valid = true; } catch { /* Repair a missing/corrupt file below. */ }
          this.check(signal);
        }
        if (valid) {
          this.prefetched.add(id);
          this.validated.set(id, existing.size); this.store.touch(id, Date.now());
          return { uri: existing.uri, release };
        }
        this.store.remove(id); this.validated.delete(id);
      }
      this.check(signal);
      const task = this.enqueue(id, 0, false);
      task.users++;
      try {
        const uri = await this.wait(task.promise, signal);
        this.check(signal);
        return { uri, release };
      } finally {
        task.users--;
        if (!task.users && !task.background && this.tasks.get(id) === task) this.cancel(task);
      }
    } catch (error) { release(); throw error; }
  }

  /** Keep the original file after upload; deleting a recording draft cannot remove this copy. */
  remember(id: string, sourceUri: string) {
    this.check();
    let entry = this.store.lookup(id);
    if (entry && this.validated.get(id) !== entry.size) { this.store.remove(id); entry = null; }
    entry ??= this.store.copy(id, sourceUri, Date.now());
    this.validated.set(id, entry.size); this.store.touch(id, Date.now());
    this.prefetched.add(id);
    const task = this.tasks.get(id);
    if (task) {
      this.tasks.delete(id); this.queue = this.queue.filter(item => item !== task);
      task.resolve(entry.uri); task.controller.abort();
    }
    this.prune(id);
  }

  setPrefetchEnabled(enabled: boolean) {
    this.backgroundEnabled = enabled;
    if (!enabled) for (const task of this.tasks.values()) {
      task.background = false;
      if (!task.users) this.cancel(task);
    }
  }

  dispose() {
    this.closed = true;
    for (const task of this.tasks.values()) this.cancel(task);
  }

  private enqueue(id: string, priority: number, background: boolean) {
    let task = this.tasks.get(id);
    if (task) {
      task.priority = Math.min(task.priority, priority); task.background ||= background;
    } else {
      let resolve!: Task['resolve'], reject!: Task['reject'];
      const promise = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
      void promise.catch(() => {});
      task = { id, priority, background, users: 0, controller: new AbortController(), promise, resolve, reject };
      this.tasks.set(id, task); this.queue.push(task);
    }
    this.pump(); return task;
  }

  private pump() {
    if (this.closed) return;
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.queue.length && this.active < (this.queue[0]!.priority === 0 ? 3 : 2)) {
      const task = this.queue.shift()!;
      this.active++;
      void this.download(task);
    }
  }

  private async download(task: Task) {
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; task.controller.abort(); }, 20000);
    const token = this.options.token;
    try {
      const response = await fetch(`${this.options.baseUrl}/v1/media/${encodeURIComponent(task.id)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: task.controller.signal,
      });
      if (response.status === 401 && token === this.options.token) this.options.onUnauthorized?.();
      this.check(task.controller.signal);
      if (!response.ok || Number(response.headers.get('content-length')) > 12_000_000) throw new UserFacingError('The voice message could not be loaded. Please try again.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      this.check(task.controller.signal);
      try { playbackPcm(bytes); } catch { throw new UserFacingError('The voice message could not be played. Please try again.'); }
      const entry = this.store.write(task.id, bytes, Date.now());
      this.prefetched.add(task.id);
      this.validated.set(task.id, entry.size); this.prune(task.id); task.resolve(entry.uri);
    } catch (error) {
      task.reject(timedOut ? new UserFacingError('Loading the voice message took too long. Please try again.')
        : this.closed || task.controller.signal.aborted ? new CancelledError()
        : error instanceof UserFacingError ? error : new UserFacingError('The voice message could not be loaded. Check your connection and try again.'));
    } finally {
      clearTimeout(timeout); this.active--;
      if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
      this.pump();
    }
  }

  private cancel(task: Task) {
    if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
    this.queue = this.queue.filter(item => item !== task);
    task.controller.abort(); task.reject(new CancelledError());
  }
  private check(signal?: AbortSignal) { if (this.closed || signal?.aborted) throw new CancelledError(); }
  private wait<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      const cancel = () => reject(new CancelledError());
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
  }
  private prune(protect?: string) {
    try {
      const entries = this.store.entries().sort((a, b) => a.usedAt - b.usedAt);
      let bytes = entries.reduce((sum, item) => sum + item.size, 0);
      let count = entries.length;
      for (const item of entries) {
        if (bytes <= (this.options.maxBytes ?? 256 * 1024 * 1024) && count <= 1000) break;
        if (item.id === protect || this.pins.has(item.id)) continue;
        this.store.remove(item.id); this.validated.delete(item.id); bytes -= item.size; count--;
      }
    } catch { /* A cache cleanup failure must not stop playback. */ }
  }
}
