// Preparation is serialized; playback completion never holds the ownership queue.
export class AudioOwnership {
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  async transition(operation: (current: () => boolean) => Promise<void>) {
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    const task = this.queue.then(() => operation(current));
    this.queue = task.catch(() => {});
    await task;
  }
}
