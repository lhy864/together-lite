import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { broadcast, findMember, publicMembers, send, snapshot } from './rooms.js';
import type { Room, Session } from './rooms.js';
import { summary } from './video.js';

export function installSync(app: FastifyInstance, config: Config, rooms: Map<string, Room>,
  getSession: (request: IncomingMessage) => Session | undefined, originAllowed: (origin: string | undefined, request: IncomingMessage) => boolean) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();
  app.server.on('upgrade', (request, socket, head) => {
    const refuse = (status: number) => { socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); socket.destroy(); };
    const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec((request.url || '').split('?')[0]);
    if (!match) return refuse(404);
    if (!originAllowed(request.headers.origin, request)) return refuse(403);
    const session = getSession(request);
    const room = rooms.get(match[1]);
    const member = session && room && findMember(room, session);
    if (!session || !room || room.closed || !member || (session.role !== 'host' && session.roomId !== room.id)) return refuse(401);
    if (member.sockets.size >= 3) return refuse(429);
    wss.handleUpgrade(request, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      member.sockets.add(ws); member.lastSeen = Date.now(); room.touchedAt = Date.now();
      send(ws, { type: 'snapshot', room: snapshot(room, member) });
      broadcast(room, { type: 'members', members: publicMembers(room) });
      let messageStart = Date.now(), count = 0;
      const commandIds = new Set<string>();
      ws.on('message', (raw, binary) => {
        if (session.expiresAt < Date.now() || room.closed || !room.members.has(member.id)) return ws.close(1008, 'Session expired');
        if (Date.now() - messageStart > 10_000) { messageStart = Date.now(); count = 0; }
        if (++count > 100 || binary) return ws.close(1008, 'Invalid message rate');
        let commandId: string | undefined;
        try {
          const m = JSON.parse(raw.toString());
          if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('无效消息');
          room.touchedAt = Date.now(); member.lastSeen = Date.now();
          if (m.type === 'ping') {
            if (typeof m.sentAt !== 'number' || !Number.isFinite(m.sentAt)) throw new Error('无效时间');
            send(ws, { type: 'pong', sentAt: m.sentAt, serverTime: Date.now() });
          } else if (m.type === 'status') {
            if (!['unready', 'ready', 'buffering', 'error'].includes(m.status)) throw new Error('无效状态');
            member.status = m.status;
            broadcast(room, { type: 'members', members: publicMembers(room) });
          } else if (m.type === 'chat') {
            if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 500) throw new Error('消息长度须为 1～500 字');
            const message = { id: randomUUID(), memberId: member.id, name: member.name, text: m.text.trim(), time: Date.now() };
            room.messages.push(message);
            if (room.messages.length > 100) room.messages.shift();
            broadcast(room, { type: 'chat', message });
          } else if (m.type === 'control') {
            if (typeof m.commandId !== 'string' || m.commandId.length > 80) throw new Error('无效操作编号');
            commandId = m.commandId as string;
            if (commandIds.has(commandId!)) { send(ws, { type: 'snapshot', room: snapshot(room, member) }); return; }
            if (room.controlMode === 'host' && member.role !== 'host') throw new Error('当前仅房主可以控制播放');
            if (!['play', 'pause', 'seek'].includes(m.action) || typeof m.position !== 'number' ||
              !Number.isFinite(m.position) || m.position < 0 || m.position > 86_400) throw new Error('无效播放操作');
            if (m.videoId !== room.state.videoId || m.baseVersion !== room.state.version) {
              send(ws, { type: 'snapshot', room: snapshot(room, member) });
              throw new Error('房间状态已更新，请重试操作');
            }
            room.state = { ...room.state, position: m.position, updatedAt: Date.now(), version: room.state.version + 1,
              playing: m.action === 'seek' ? room.state.playing : m.action === 'play' };
            commandIds.add(commandId!);
            if (commandIds.size > 100) commandIds.delete(commandIds.values().next().value!);
            broadcast(room, { type: 'state', state: { ...room.state }, serverTime: Date.now(), media: summary(room.media), commandId });
          } else throw new Error('未知消息');
        } catch (error) { send(ws, { type: 'error', message: error instanceof Error ? error.message : '无效消息', commandId }); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        member.sockets.delete(ws); member.lastSeen = Date.now();
        if (!member.sockets.size) member.status = 'unready';
        if (!room.closed) broadcast(room, { type: 'members', members: publicMembers(room) });
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) ws.terminate();
      else { alive.set(ws, false); ws.ping(); }
    }
  }, 30_000);
  heartbeat.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  return wss;
}
