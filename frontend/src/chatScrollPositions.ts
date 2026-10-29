import type { Message } from './types';

type Position = { offset: number; messages: readonly Message[] };
export class ChatScrollPositions {
  private positions = new Map<string, Position>();
  private generation = 0;

  read(userId: string, chatId: string) {
    return { ...this.positions.get(`${userId}/${chatId}`), generation: this.generation };
  }
  save(userId: string, chatId: string, generation: number, offset: number, messages: readonly Message[]) {
    if (generation !== this.generation || !Number.isFinite(offset)) return;
    this.positions.set(`${userId}/${chatId}`, { offset: Math.max(0, offset), messages });
  }
  clear() { this.generation++; this.positions.clear(); }
}
