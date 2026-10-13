import { mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const root = process.cwd();
try {
  const config = await loadConfig(root);
  const { app, hostToken, library } = await createApp(config, root);
  await app.listen({ host: config.host, port: config.port });
  const localUrl = `http://localhost:${config.port}`;
  const hostUrl = `${config.publicUrl || localUrl}/host#host=${hostToken}`;
  await mkdir(path.join(root, '.runtime'), { recursive: true });
  await writeFile(path.join(root, '.runtime/host-entry.url'), `[InternetShortcut]\r\nURL=${hostUrl}\r\n`, 'utf8');
  console.log(`\nTogether Lite v0.2.0 已启动\n本机页面：${localUrl}\n房主入口已保存：.runtime/host-entry.url\n媒体：${library.list().length} 部\n`);
  for (const warning of library.warnings) console.log(warning);
  if (!config.publicUrl) {
    for (const addresses of Object.values(networkInterfaces())) for (const addr of addresses || [])
      if (!addr.internal && addr.family === 'IPv4') console.log(`局域网入口：http://${addr.address}:${config.port}`);
    console.log('公网 IPv6 尚未验收。局域网邀请请使用局域网地址或手动修改邀请链接的主机部分。');
  } else console.log(`邀请地址：${config.publicUrl}`);
  if (process.env.TOGETHER_OPEN === '1' && process.platform === 'win32')
    spawn('explorer.exe', [hostUrl], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) {
  console.error(`启动失败：${(error as Error).message}`);
  process.exitCode = 1;
}
