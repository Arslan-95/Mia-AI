import type { ServerEvent, Session } from './types';
import { preferences } from './storage';
export type Frame = Record<string, unknown>;
export class Realtime {
  private socket?: WebSocket;
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private connectedAt = Date.now();
  private ready = false;
  constructor(private base: string, private session: Session, private onEvent: (event: ServerEvent, connectedAt: number) => Promise<void>, private onFrame: (frame: Frame) => void, private onStatus: (status: string) => void) {}
  async connect() {
    const after = await preferences.get(`mia.cursor.${this.session.user.id}`) ?? '0';
    if (this.disposed) return;
    this.connectedAt = Date.now();
    const socket = this.socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/v1/realtime');
    this.onStatus('Connecting');
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.session.token, after }));
    socket.onmessage = message => {
      this.queue = this.queue.then(async () => {
        if (this.disposed || socket !== this.socket) return;
        const frame = JSON.parse(String(message.data)) as Frame;
        if (frame.type === 'ready') { this.ready = true; this.onStatus('Connected'); }
        if (frame.type === 'event') {
          const event = frame.event as ServerEvent;
          await this.onEvent(event, this.connectedAt);
          await preferences.set(`mia.cursor.${this.session.user.id}`, event.id);
        } else this.onFrame(frame);
      }).catch(() => { socket.close(); });
    };
    socket.onerror = () => this.onStatus('Connection interrupted');
    socket.onclose = () => {
      this.ready = false;
      if (this.disposed) return;
      this.onStatus('Offline · reconnecting');
      this.retry = setTimeout(() => void this.connect(), 2500);
    };
  }
  send(frame: Frame) { if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false; this.socket.send(JSON.stringify(frame)); return true; }
  dispose() { this.disposed = true; this.ready = false; clearTimeout(this.retry); this.socket?.close(); }
}
