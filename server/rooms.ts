import { randomBytes, randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { ChatMessage, ControlMode, Member, RoomSnapshot, RoomState, ServerMessage } from '../shared/protocol.js';
import type { MediaFile } from './video.js';
import { summary } from './video.js';

export const token = () => randomBytes(32).toString('base64url');
export interface Session {
  id: string; role: 'host' | 'guest'; name: string; roomId?: string; memberId?: string; expiresAt: number;
}
export interface LiveMember extends Member { sessionId: string; sockets: Set<WebSocket>; lastSeen: number }
export interface Room {
  id: string; name: string; media: MediaFile; state: RoomState; invite: string;
  controlMode: ControlMode; members: Map<string, LiveMember>; messages: ChatMessage[];
  touchedAt: number; closed: boolean;
}
export function createRoom(name: string, media: MediaFile): Room {
  const now = Date.now();
  return { id: randomBytes(9).toString('base64url'), name, media, invite: token(),
    state: { videoId: media.id, playing: false, position: 0, updatedAt: now, version: 1 },
    controlMode: 'everyone', members: new Map(), messages: [], touchedAt: now, closed: false };
}
export function positionAt(state: RoomState, now = Date.now()) {
  return Math.max(0, state.position + (state.playing ? Math.max(0, now - state.updatedAt) / 1000 : 0));
}
export function findMember(room: Room, session: Session) {
  return [...room.members.values()].find((member) => member.sessionId === session.id);
}
export function addMember(room: Room, session: Session, name: string, maxMembers: number): LiveMember {
  const existing = findMember(room, session);
  if (existing) { existing.name = name; existing.lastSeen = Date.now(); return existing; }
  // Offline guests retain a seat for two minutes so they can reconnect.
  for (const [id, m] of room.members)
    if (m.role === 'guest' && !m.sockets.size && Date.now() - m.lastSeen > 120_000) room.members.delete(id);
  if (room.members.size >= maxMembers) throw new Error('房间已满，请房主移除离线成员后重试');
  const member: LiveMember = { id: randomUUID(), name, role: session.role, online: false,
    status: 'unready', sessionId: session.id, sockets: new Set(), lastSeen: Date.now() };
  room.members.set(member.id, member);
  room.touchedAt = Date.now();
  return member;
}
export function publicMembers(room: Room): Member[] {
  return [...room.members.values()].map(({ id, name, role, status, sockets }) => ({ id, name, role, status, online: sockets.size > 0 }));
}
export function snapshot(room: Room, member: LiveMember): RoomSnapshot {
  return { id: room.id, name: room.name, media: summary(room.media), state: { ...room.state },
    members: publicMembers(room), messages: room.messages, controlMode: room.controlMode,
    serverTime: Date.now(), me: { id: member.id, role: member.role } };
}
export function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === 1) {
    if (socket.bufferedAmount > 256 * 1024) { socket.close(1013, 'Client too slow'); return; }
    socket.send(JSON.stringify(message));
  }
}
export function broadcast(room: Room, message: ServerMessage) {
  for (const member of room.members.values()) for (const socket of member.sockets) send(socket, message);
}
export function closeRoom(room: Room, reason: string) {
  room.closed = true;
  broadcast(room, { type: 'closed', reason });
  for (const m of room.members.values()) for (const socket of m.sockets) socket.close(1000, 'Room closed');
}
