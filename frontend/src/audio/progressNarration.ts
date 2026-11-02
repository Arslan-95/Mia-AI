// Optional speech never queues behind another update or interrupts a source
// reading/final reply. Let a short update finish instead of cutting it mid-word.
export class ProgressNarration {
  private active?: { controller: AbortController; work: Promise<boolean> };
  private priority = 0;

  get hasPriority() { return this.priority > 0; }

  offer(play: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (this.hasPriority || this.active) return Promise.resolve(false);
    const current = { controller: new AbortController(), work: Promise.resolve(false) };
    current.work = Promise.resolve().then(async () => {
      try {
        if (current.controller.signal.aborted || this.hasPriority) return false;
        await play(current.controller.signal);
        return !current.controller.signal.aborted;
      } catch (error) {
        if (current.controller.signal.aborted) return false;
        throw error;
      } finally {
        if (this.active === current) this.active = undefined;
      }
    });
    this.active = current;
    return current.work;
  }

  cancel() { this.active?.controller.abort(); }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.priority++;
    const previous = this.active;
    previous?.controller.abort();
    try {
      await previous?.work.catch(() => false);
      return await work();
    } finally { this.priority--; }
  }
}
