import type { Message, ServerEvent } from './types';
// A local navigation or newer request revokes every older presentation lease.
export class PresentationLease {
  private epoch = 0;
  turnId: string | null = null;
  private clientId: string | null = null;
  revoke() { this.epoch++; this.turnId = null; this.clientId = null; return this.epoch; }
  begin(clientId: string) { this.revoke(); this.clientId = clientId; return this.epoch; }
  accept(clientId: string, turnId: string) { if (this.clientId === clientId) this.turnId = turnId; }
  owns(turnId: unknown) { return typeof turnId === 'string' && turnId === this.turnId; }
  snapshot() { return this.epoch; }
  current(epoch: number) { return epoch === this.epoch; }
}
export function mergeMessages(previous: Message[], incoming: Message[]) {
  const unique = new Map(previous.map(message => [message.id, message]));
  incoming.forEach(message => unique.set(message.id, message));
  return [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export function isLiveAction(event: ServerEvent, connectedAt: number) {
  const time = Date.parse(event.createdAt);
  return event.type === 'device.action_requested' && time >= connectedAt && Date.now() - time < 18000;
}
