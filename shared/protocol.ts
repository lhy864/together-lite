export type MemberStatus = 'unready' | 'ready' | 'buffering' | 'error';
export type ControlMode = 'everyone' | 'host';
export type ControlAction = 'play' | 'pause' | 'seek';
export interface MediaSummary { id: string; name: string; size: number; subtitle: boolean }
export interface RoomState {
  videoId: string; playing: boolean; position: number; updatedAt: number; version: number;
}
export interface Member {
  id: string; name: string; role: 'host' | 'guest'; online: boolean; status: MemberStatus;
}
export interface ChatMessage { id: string; memberId: string; name: string; text: string; time: number }
export interface RoomSnapshot {
  id: string; name: string; media: MediaSummary; state: RoomState;
  members: Member[]; messages: ChatMessage[]; controlMode: ControlMode;
  serverTime: number; me: { id: string; role: 'host' | 'guest' };
}
export type ServerMessage =
  | { type: 'snapshot'; room: RoomSnapshot }
  | { type: 'state'; state: RoomState; serverTime: number; media: MediaSummary; commandId?: string }
  | { type: 'members'; members: Member[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'settings'; controlMode: ControlMode }
  | { type: 'pong'; sentAt: number; serverTime: number }
  | { type: 'error'; message: string; commandId?: string }
  | { type: 'closed'; reason: string };
export type ClientMessage =
  | { type: 'ping'; sentAt: number }
  | { type: 'control'; action: ControlAction; position: number; videoId: string; baseVersion: number; commandId: string }
  | { type: 'status'; status: MemberStatus }
  | { type: 'chat'; text: string };
