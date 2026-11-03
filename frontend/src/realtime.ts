import type { ServerEvent, Session } from './types';
export type Frame = Record<string, unknown>;
export type CursorStore = { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
const diagnostics: { time: number; event: string; code?: string | number; status?: number }[] = [];
export const getRealtimeDiagnostics = () => [...diagnostics];
function diagnose(event: string, code?: string | number, status?: number) {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  diagnostics.push({ time: Date.now(), event, code, status });
  if (diagnostics.length > 40) diagnostics.shift();
}
export class Realtime {
  private socket?: WebSocket;
  private disposed = false;
  private retry?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private connectedAt = Date.now();
  private ready = false;
  private replayThrough?: bigint;
  constructor(private base: string, private session: Session, private onEvent: (event: ServerEvent, connectedAt: number, replayed?: boolean) => Promise<void>, private onFrame: (frame: Frame) => void, private onStatus: (status: string) => void, private cursors: CursorStore) {}
  async connect() {
    const after = await this.cursors.get(`mia.cursor.${this.session.user.id}`) ?? '0';
    if (this.disposed) return;
    this.connectedAt = Date.now();
    this.replayThrough = undefined;
    const socket = this.socket = new WebSocket(this.base.replace(/^http/, 'ws') + '/v1/realtime');
    diagnose('connecting');
    this.onStatus('Connecting');
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.session.token, after }));
    socket.onmessage = message => {
      this.queue = this.queue.then(async () => {
        if (this.disposed || socket !== this.socket) return;
        const frame = JSON.parse(String(message.data)) as Frame;
        if (frame.type === 'ready') {
          if (typeof frame.replayThrough === 'string' && /^\d+$/.test(frame.replayThrough)) this.replayThrough = BigInt(frame.replayThrough);
          diagnose('ready'); this.ready = true; this.onStatus('Connected');
        }
        if (frame.type === 'event') {
          const event = frame.event as ServerEvent;
          const replayed = this.replayThrough !== undefined ? BigInt(event.id) <= this.replayThrough : Date.parse(event.createdAt) < this.connectedAt;
          await this.onEvent(event, this.connectedAt, replayed);
          await this.cursors.set(`mia.cursor.${this.session.user.id}`, event.id);
        } else this.onFrame(frame);
      }).catch(reason => {
        const error = reason as { code?: unknown; status?: unknown } | null;
        const code = typeof error?.code === 'string' && /^[A-Z_]{1,50}$/.test(error.code) ? error.code : 'EVENT_FAILED';
        diagnose('event_failed', code, typeof error?.status === 'number' ? error.status : undefined);
        socket.close();
      });
    };
    socket.onerror = () => { diagnose('transport_error'); this.onStatus('Connection interrupted'); };
    socket.onclose = event => {
      diagnose('closed', event?.code);
      this.ready = false;
      if (this.disposed) return;
      this.onStatus('Offline · reconnecting');
      this.retry = setTimeout(() => void this.connect(), 2500);
    };
  }
  send(frame: Frame) { if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return false; this.socket.send(JSON.stringify(frame)); return true; }
  sendAudio(bytes: Uint8Array) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 256000) return false;
    this.socket.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); return true;
  }
  dispose() { this.disposed = true; this.ready = false; clearTimeout(this.retry); this.socket?.close(); }
}
