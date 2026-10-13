import type { MediaSummary } from './protocol.js';
export interface DesktopMedia extends MediaSummary { previewUrl: string; removable: boolean; demo: boolean }
export interface DesktopSettings { nickname: string; port: number; maxMembers: number; publicUrl: string; connectionMode: 'direct' | 'tunnel'; autoStart: boolean }
export interface DesktopSnapshot {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'; message: string; warnings: string[];
  settings: DesktopSettings; media: DesktopMedia[]; directories: string[];
  network: { localUrl: string; publicUrl: string; publicVerified: boolean;
    lan: { name: string; address: string; url: string; virtual: boolean }[]; ipv6: { name: string; address: string }[] };
  rooms: { id: string; name: string; media: MediaSummary; members: number; inviteUrl: string }[];
  caddy: 'running' | 'stopped' | 'unused';
}
export interface Diagnosis { local: boolean; dnsRecords: string[]; https: boolean; endpoint: boolean; connectionMode: 'direct' | 'tunnel'; ipv6: { name: string; address: string }[];
  notes: string[]; externalVerified: boolean; externalMessage: string }
export interface DesktopBridge {
  snapshot(): Promise<DesktopSnapshot>; start(): Promise<DesktopSnapshot>; stop(): Promise<DesktopSnapshot>;
  settings(value: Partial<DesktopSettings>): Promise<DesktopSnapshot>;
  pickFiles(): Promise<DesktopSnapshot>; importFiles(files: File[]): Promise<DesktopSnapshot>;
  pickDirectory(): Promise<DesktopSnapshot>; removeDirectory(directory: string): Promise<DesktopSnapshot>;
  removeMedia(id: string): Promise<DesktopSnapshot>; subtitle(id: string): Promise<DesktopSnapshot>; scan(): Promise<DesktopSnapshot>;
  createRoom(id: string, name: string): Promise<{ room: { id: string }; inviteUrl: string }>;
  openRoom(id: string): Promise<void>; invite(id: string, origin: string, renew?: boolean): Promise<string>;
  copyInvite(id: string, origin: string): Promise<boolean>; endRoom(id: string): Promise<DesktopSnapshot>;
  diagnose(): Promise<Diagnosis>; onSnapshot(callback: (value: DesktopSnapshot) => void): () => void;
}
declare global { interface Window { togetherDesktop: DesktopBridge } }
