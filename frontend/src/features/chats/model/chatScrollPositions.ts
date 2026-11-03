import type { Message } from '../../../shared/types';

type Position = { offset: number; messages: readonly Message[] };
export class ChatScrollPositions {
  private positions = new Map<string, Position>();
  private generation = 0;
  private consumedScrolls = new Map<string, string>();

  read(userId: string, chatId: string) {
    return { ...this.positions.get(`${userId}/${chatId}`), generation: this.generation };
  }
  save(userId: string, chatId: string, generation: number, offset: number, messages: readonly Message[]) {
    if (generation !== this.generation || !Number.isFinite(offset)) return;
    this.positions.set(`${userId}/${chatId}`, { offset: Math.max(0, offset), messages });
  }
  consumeScrollRequest(userId: string, chatId: string, request: string) {
    const key = `${userId}/${chatId}`;
    if (this.consumedScrolls.get(key) === request) return false;
    this.consumedScrolls.set(key, request); return true;
  }
  clear() { this.generation++; this.positions.clear(); this.consumedScrolls.clear(); }
}
