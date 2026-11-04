import { CancelledError } from '../shared/errors';
import type { Message, ServerEvent, Turn } from '../shared/types';
// A local navigation or newer request revokes every older presentation lease.
export class PresentationLease {
  private epoch = 0;
  turnId: string | null = null;
  private clientId: string | null = null;
  revoke() { this.epoch++; this.turnId = null; this.clientId = null; return this.epoch; }
  begin(clientId: string) { this.revoke(); this.clientId = clientId; return this.epoch; }
  accept(clientId: string, turnId: string) { if (this.clientId !== clientId) return false; this.turnId = turnId; return true; }
  owns(turnId: unknown) { return typeof turnId === 'string' && turnId === this.turnId; }
  snapshot() { return this.epoch; }
  current(epoch: number) { return epoch === this.epoch; }
}

export class TurnCompletion {
  private completion?: { id: string; sessionId: string; text: string; epoch: number };
  private wake?: () => void;

  receive(payload: ServerEvent['payload'], epoch: number) {
    const { turnId, sessionId, text } = payload;
    if (typeof turnId !== 'string' || typeof sessionId !== 'string' || typeof text !== 'string') return;
    this.completion = { id: turnId, sessionId, text, epoch };
    this.wake?.();
  }

  result(turn: Turn, epoch: number): Turn | undefined {
    const completion = this.completion;
    if (completion?.id === turn.id && completion.sessionId === turn.sessionId && completion.epoch === epoch) {
      return { ...turn, status: 'completed', assistantText: completion.text };
    }
  }

  wait(turn: Turn, epoch: number, signal: AbortSignal): Promise<Turn | undefined> {
    if (signal.aborted) return Promise.reject(new CancelledError());
    const completed = this.result(turn, epoch);
    if (completed) return Promise.resolve(completed);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if (this.wake === wake) this.wake = undefined;
      };
      const cancel = () => { cleanup(); reject(new CancelledError()); };
      const wake = () => {
        const completed = this.result(turn, epoch);
        if (completed) { cleanup(); resolve(completed); }
      };
      const timer = setTimeout(() => { cleanup(); resolve(undefined); }, 1000);
      this.wake = wake;
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
}
export function mergeMessages(previous: Message[], incoming: Message[]) {
  const unique = new Map(previous.map(message => [message.id, message]));
  incoming.forEach(message => unique.set(message.id, message));
  return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export function isLiveAction(event: ServerEvent, connectedAt: number) {
  const time = Date.parse(event.createdAt);
  return event.type === 'device.action_requested' && time >= connectedAt && Date.now() - time < Math.min(180000, typeof event.payload.expiresIn === 'number' ? event.payload.expiresIn : 18000);
}
