import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(args) {
  if (!existsSync(npmCli)) throw new Error('找不到 npm。请安装 Node.js LTS，或在终端手动执行 npm install 和 npm run build。');
  const result = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', cwd: root, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm ${args[0]} 失败，请查看上方信息。`);
}
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('请安装 Node.js 22.12 或更新的 LTS 版本。');
  if (!existsSync(path.join(root, 'node_modules/fastify/package.json'))) npm(['ci', '--no-audit', '--no-fund']);
  npm(['run', 'build']);
  const read = name => existsSync(path.join(root, name)) ? JSON.parse(readFileSync(path.join(root, name), 'utf8').replace(/^\uFEFF/, '')) : {};
  const config = { port: 3000, ...read('config.json'), ...read('config.local.json') };
  const children = [];
  const shutdown = () => { for (const child of children) if (!child.killed) child.kill(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('exit', shutdown);
  if (config.publicUrl?.startsWith('https://')) {
    if (!['127.0.0.1', '::1'].includes(config.host) || config.trustProxy !== true)
      throw new Error('公网 HTTPS 模式请设置 host: 127.0.0.1 和 trustProxy: true，使 Node 服务只通过 Caddy 提供。');
    const caddyPath = path.join(root, 'tools/caddy.exe');
    if (!existsSync(caddyPath)) throw new Error('请将 Caddy 放到 tools/caddy.exe，再启动公网 HTTPS 模式。');
    const caddy = spawn(caddyPath, ['run', '--config', path.join(root, 'Caddyfile')], { cwd: root, stdio: 'inherit', windowsHide: true,
      env: { ...process.env, TOGETHER_DOMAIN: new URL(config.publicUrl).hostname,
        TOGETHER_UPSTREAM: `${config.host === '::1' ? '[::1]' : config.host}:${config.port}` } });
    children.push(caddy);
    caddy.on('error', error => { console.error(`Caddy 启动失败：${error.message}`); shutdown(); process.exitCode = 1; });
    caddy.on('exit', code => { if (code) { console.error('Caddy 已退出，请检查域名、端口和证书配置。'); shutdown(); } });
  }
  const server = spawn(process.execPath, ['build/server/index.js'], { stdio: 'inherit', cwd: root, windowsHide: true,
    env: { ...process.env, TOGETHER_OPEN: process.env.TOGETHER_OPEN ?? '1' } });
  children.push(server);
  server.on('error', error => { console.error(error.message); shutdown(); process.exitCode = 1; });
  server.on('exit', code => { shutdown(); process.exitCode = code || 0; });
} catch (error) { console.error(`\n启动未完成：${error.message}`); process.exitCode = 1; }
