import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface Config {
  host: string; port: number; mediaDirectories: string[]; publicUrl: string;
  trustProxy: boolean; maxMembers: number; roomIdleMinutes: number;
}
export async function loadConfig(root: string): Promise<Config> {
  const read = async (name: string) => {
    try { return JSON.parse((await readFile(path.join(root, name), 'utf8')).replace(/^\uFEFF/, '')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  };
  const c = { host: '::', port: 3000, mediaDirectories: ['./media'], publicUrl: '',
    trustProxy: false, maxMembers: 4, roomIdleMinutes: 120,
    ...await read('config.json'), ...await read('config.local.json') } as Config;
  if (typeof c.host !== 'string' || !c.host || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
    throw new Error('config: host / port 配置无效');
  if (!Array.isArray(c.mediaDirectories) || !c.mediaDirectories.length ||
      c.mediaDirectories.some((v) => typeof v !== 'string' || !v))
    throw new Error('config: mediaDirectories 必须是非空目录列表');
  if (typeof c.publicUrl !== 'string' || typeof c.trustProxy !== 'boolean' ||
      !Number.isInteger(c.maxMembers) || c.maxMembers < 2 || c.maxMembers > 4 ||
      !Number.isInteger(c.roomIdleMinutes) || c.roomIdleMinutes < 5)
    throw new Error('config: publicUrl / trustProxy / maxMembers / roomIdleMinutes 配置无效');
  if (c.publicUrl) {
    const u = new URL(c.publicUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
      throw new Error('config: publicUrl 应为完整站点地址，不包含路径或参数');
    c.publicUrl = u.origin;
  }
  c.mediaDirectories = c.mediaDirectories.map((dir) => path.resolve(root, dir));
  return c;
}
