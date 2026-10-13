import type { ClientMessage, ServerMessage, RoomState } from '../../shared/protocol';
export type Connection = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export class SyncClient {
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private retries = 0;
  private anchor = Date.now() - performance.now();
  private offset = 0;
  private samples: { rtt: number; offset: number }[] = [];
  private lastPong = 0;
  private offline = () => { if (!this.stopped) { this.onConnection('reconnecting'); this.socket?.close(); } };
  private online = () => { if (!this.stopped) { clearTimeout(this.timer); this.retries = 0; this.connect(); } };
  constructor(private roomId: string, private onMessage: (message: ServerMessage) => void,
    private onConnection: (state: Connection) => void) {
    window.addEventListener('offline', this.offline); window.addEventListener('online', this.online);
  }
  now() { return this.anchor + performance.now(); }
  target(state: RoomState) {
    return Math.max(0, state.position + (state.playing ? Math.max(0, (this.now() + this.offset - state.updatedAt) / 1000) : 0));
  }
  connect() {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.onConnection('reconnecting'); this.timer = setTimeout(() => this.connect(), 3000); return;
    }
    clearTimeout(this.deadline); clearInterval(this.heartbeat);
    this.socket?.close();
    this.onConnection(this.retries ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${this.roomId}`);
    this.socket = ws;
    this.deadline = setTimeout(() => ws.close(), 10_000);
    ws.onopen = () => {
      if (this.socket !== ws || this.stopped) return;
      clearTimeout(this.deadline); this.retries = 0; this.lastPong = this.now(); this.onConnection('connected');
      this.ping(); this.heartbeat = setInterval(() => this.ping(), 8000);
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || this.stopped) return;
      let m: ServerMessage;
      try { m = JSON.parse(event.data); } catch { return; }
      if (m.type === 'pong') {
        this.lastPong = this.now();
        const rtt = this.now() - m.sentAt;
        if (rtt >= 0 && rtt < 5000) {
          this.samples.push({ rtt, offset: m.serverTime - (m.sentAt + rtt / 2) });
          if (this.samples.length > 10) this.samples.shift();
          this.offset = this.samples.reduce((a, b) => a.rtt < b.rtt ? a : b).offset;
        }
      } else {
        if (m.type === 'snapshot' && !this.samples.length) this.offset = m.room.serverTime - this.now();
        if (m.type === 'closed') this.stop();
        this.onMessage(m);
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.socket !== ws) return;
      clearTimeout(this.deadline); clearInterval(this.heartbeat);
      if (this.stopped) return;
      this.onConnection('reconnecting');
      const delay = Math.min(12_000, 600 * 2 ** this.retries++) + Math.random() * 300;
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
  private ping() {
    if (this.lastPong && this.now() - this.lastPong > 20_000) { this.socket?.close(); return; }
    this.send({ type: 'ping', sentAt: this.now() });
  }
  send(message: ClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message)); return true;
  }
  stop() {
    this.stopped = true; clearTimeout(this.timer); clearTimeout(this.deadline); clearInterval(this.heartbeat);
    window.removeEventListener('offline', this.offline); window.removeEventListener('online', this.online);
    this.socket?.close(); this.onConnection('closed');
  }
}
