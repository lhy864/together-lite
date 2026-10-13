import { mkdir, readFile, writeFile, rename, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { Resolver } from 'node:dns/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { createApp } from '../build/server/app.js';
import { MediaLibrary, summary } from '../build/server/video.js';
import { broadcast, closeRoom } from '../build/server/rooms.js';

const secret = () => randomBytes(32).toString('base64url');
export function validateSettings(input, previous) {
  if (!input || typeof input !== 'object') throw new Error('设置内容无法识别，请重新填写。');
  const next = { ...previous };
  next.connectionMode = previous.connectionMode || 'direct';
  if ('connectionMode' in input) {
    if (!['direct', 'tunnel'].includes(input.connectionMode)) throw new Error('请选择 IPv6 直连或内网穿透。');
    next.connectionMode = input.connectionMode;
  }
  if ('nickname' in input) {
    if (typeof input.nickname !== 'string' || !input.nickname.trim() || input.nickname.trim().length > 30) throw new Error('昵称请填写 1～30 个字。');
    next.nickname = input.nickname.trim();
  }
  if ('port' in input) {
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) throw new Error('服务端口请填写 1024～65535 之间的整数。');
    next.port = input.port;
  }
  if ('maxMembers' in input) {
    if (![2, 3, 4].includes(input.maxMembers)) throw new Error('房间人数可以选择 2～4 人。');
    next.maxMembers = input.maxMembers;
  }
  if ('autoStart' in input) {
    if (typeof input.autoStart !== 'boolean') throw new Error('自动启动选项无效。');
    next.autoStart = input.autoStart;
  }
  if ('publicUrl' in input) {
    if (typeof input.publicUrl !== 'string') throw new Error('请填写外网地址。');
    const value = input.publicUrl.trim();
    if (!value) next.publicUrl = '';
    else {
      let url;
      try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new Error('域名格式不正确，例如 watch.example.com。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[\u0000-\u001f]/.test(value))
        throw new Error('请填写完整外网地址，例如 https://watch.example.nyat.app:12345，不要附加房间路径或参数。');
      next.publicUrl = url.origin;
    }
  }
  if (next.publicUrl && next.connectionMode === 'direct') {
    const url = new URL(next.publicUrl);
    if (url.protocol !== 'https:' || url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname))
      throw new Error('IPv6 直连请填写 HTTPS 域名，不附加端口。SakuraFrp 的地址请选择「内网穿透」方式。');
  }
  return next;
}
async function checkLoopbackPort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(error => error ? reject(error) : resolve()));
  });
}
export class DesktopController {
  constructor({ root, dataDir, demoFile, caddyPath, onChange = () => {} }) {
    this.root = root; this.dataDir = dataDir; this.demoFile = demoFile; this.caddyPath = caddyPath; this.onChange = onChange;
    this.status = 'stopped'; this.message = ''; this.media = []; this.warnings = []; this.logs = []; this.queue = Promise.resolve();
    this.prefs = { nickname: '房主', port: 3001, maxMembers: 4, publicUrl: '', connectionMode: 'direct', autoStart: true, mediaFiles: [], mediaDirectories: [], subtitles: {}, demoEnabled: true };
  }
  run(task) { const result = this.queue.then(task); this.queue = result.catch(() => {}); return result; }
  async init() {
    await mkdir(this.dataDir, { recursive: true });
    if (this.demoFile && existsSync(this.demoFile)) this.demoFile = await realpath(this.demoFile);
    try {
      const saved = JSON.parse(await readFile(path.join(this.dataDir, 'preferences.json'), 'utf8'));
      this.prefs = validateSettings(saved, this.prefs);
      this.prefs.mediaFiles = Array.isArray(saved.mediaFiles) ? saved.mediaFiles.filter(v => typeof v === 'string' && path.isAbsolute(v)).slice(0, 500) : [];
      const isBundledDemo = file => file === this.demoFile || /[\\/]resources[\\/]demo[\\/]Together 测试影片\.mp4$/i.test(file);
      this.prefs.demoEnabled = typeof saved.demoEnabled === 'boolean' ? saved.demoEnabled : !this.prefs.mediaFiles.length || this.prefs.mediaFiles.some(isBundledDemo);
      this.prefs.mediaFiles = this.prefs.mediaFiles.filter(file => !isBundledDemo(file));
      this.prefs.mediaDirectories = Array.isArray(saved.mediaDirectories) ? saved.mediaDirectories.filter(v => typeof v === 'string' && path.isAbsolute(v)).slice(0, 30) : [];
      this.prefs.subtitles = saved.subtitles && typeof saved.subtitles === 'object' && !Array.isArray(saved.subtitles) ?
        Object.fromEntries(Object.entries(saved.subtitles).filter(([k, v]) => path.isAbsolute(k) && typeof v === 'string' && path.isAbsolute(v))) : {};
    } catch (e) { if (e.code !== 'ENOENT') this.message = '上次的设置未能读取，已使用默认设置。'; }
    await this.save();
    await this.scan();
    return this.snapshot();
  }
  async save() {
    const file = path.join(this.dataDir, 'preferences.json');
    await writeFile(`${file}.tmp`, JSON.stringify(this.prefs, null, 2)); await rename(`${file}.tmp`, file);
  }
  log(text) { this.logs.push(String(text).slice(0, 500)); if (this.logs.length > 100) this.logs.shift(); }
  sources() { return [...this.prefs.mediaFiles, ...(this.prefs.demoEnabled && this.demoFile && existsSync(this.demoFile) ? [this.demoFile] : [])]; }
  async scan() {
    const library = this.service?.library || new MediaLibrary(this.prefs.mediaDirectories, this.sources(), this.prefs.subtitles);
    library.setSources(this.prefs.mediaDirectories, this.sources(), this.prefs.subtitles);
    this.media = await library.scan(); this.warnings = library.warnings;
    this.library = library;
    if (this.service) for (const room of this.service.rooms.values()) {
      const current = library.items.get(room.media.id);
      if (current && current.subtitleFile !== room.media.subtitleFile) {
        room.media = current; room.state = { ...room.state, version: room.state.version + 1 };
        broadcast(room, { type: 'state', state: { ...room.state }, serverTime: Date.now(), media: summary(current) });
      }
    }
    this.changed(); return this.snapshot();
  }
  changed() { this.onChange(this.snapshot()); }
  snapshot() {
    const network = this.network();
    return { status: this.status, message: this.message, warnings: this.warnings, settings: { nickname: this.prefs.nickname,
      port: this.prefs.port, maxMembers: this.prefs.maxMembers, publicUrl: this.prefs.publicUrl, connectionMode: this.prefs.connectionMode, autoStart: this.prefs.autoStart },
      media: this.media.map(m => ({ ...m, previewUrl: this.service ? `${this.origin}/api/desktop/media/${m.id}?key=${this.previewKey}` : '',
        removable: this.sources().includes(this.library?.items.get(m.id)?.file), demo: this.library?.items.get(m.id)?.file === this.demoFile })),
      directories: this.prefs.mediaDirectories, network,
      rooms: this.service ? [...this.service.rooms.values()].filter(r => !r.closed).map(r => ({ id: r.id, name: r.name,
        media: summary(r.media), members: [...r.members.values()].filter(m => m.sockets.size).length, inviteUrl: this.invite(r) })) : [],
      caddy: this.caddy ? 'running' : this.prefs.publicUrl && this.prefs.connectionMode === 'direct' ? 'stopped' : 'unused' };
  }
  network() {
    const lan = [], ipv6 = [];
    for (const [name, addresses] of Object.entries(networkInterfaces())) for (const a of addresses || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' && !a.address.startsWith('169.254.')) lan.push({ name, address: a.address,
        url: `http://${a.address}:${this.prefs.port}`, virtual: /vethernet|vmware|virtual|wsl|tap|tun|clash|docker|vmnet/i.test(name) || a.address.startsWith('198.18.') });
      if (a.family === 'IPv6' && /^[23][0-9a-f]{3}:/i.test(a.address)) ipv6.push({ name, address: a.address });
    }
    lan.sort((a, b) => Number(a.virtual) - Number(b.virtual));
    return { lan, ipv6, localUrl: this.origin || `http://127.0.0.1:${this.prefs.port}`,
      publicUrl: this.prefs.publicUrl, publicVerified: false };
  }
  invite(room, origin) {
    return `${origin || this.prefs.publicUrl || (this.prefs.connectionMode === 'tunnel' ? this.origin : this.network().lan[0]?.url) || this.origin}/room/${room.id}#invite=${room.invite}`;
  }
  async start() {
    if (this.service) return this.snapshot();
    this.status = 'starting'; this.message = ''; this.changed();
    try {
      this.previewKey = secret(); this.hostKey = secret(); this.instanceId = secret();
      await checkLoopbackPort(this.prefs.port);
      const proxied = this.prefs.connectionMode === 'tunnel' || !!this.prefs.publicUrl;
      const config = { host: proxied ? '127.0.0.1' : '::', port: this.prefs.port, mediaDirectories: this.prefs.mediaDirectories,
        publicUrl: this.prefs.publicUrl, trustProxy: !!this.prefs.publicUrl, maxMembers: this.prefs.maxMembers, roomIdleMinutes: 120 };
      this.service = await createApp(config, this.root, this.hostKey,
        { selectedFiles: this.sources(), subtitles: this.prefs.subtitles, previewToken: this.previewKey, instanceId: this.instanceId });
      try { await this.service.app.listen({ host: config.host, port: config.port }); }
      catch (e) {
        if (!proxied && e.code === 'EAFNOSUPPORT') await this.service.app.listen({ host: '0.0.0.0', port: config.port }); else throw e;
      }
      this.origin = `http://127.0.0.1:${this.prefs.port}`;
      const health = await fetch(`${this.origin}/api/health`, { signal: AbortSignal.timeout(2500) });
      if (!health.ok || (await health.json()).instanceId !== this.instanceId)
        throw Object.assign(new Error('本机端口连接到了其他程序'), { code: 'EADDRINUSE' });
      const result = await this.service.app.inject({ method: 'POST', url: '/api/host/session', payload: { token: this.hostKey }, headers: { host: `127.0.0.1:${this.prefs.port}`, origin: this.origin } });
      if (result.statusCode !== 200) throw new Error('房主身份初始化失败，请重新启动服务。');
      this.cookie = String(result.headers['set-cookie']).split(';')[0];
      if (this.prefs.publicUrl && this.prefs.connectionMode === 'direct') await this.startCaddy();
      this.status = 'running'; await this.scan(); this.changed(); return this.snapshot();
    } catch (e) {
      this.message = e.code === 'EADDRINUSE' ? `端口 ${this.prefs.port} 正被其他程序使用。请在设置里换一个端口，再点击启动。` :
        e.code === 'EACCES' ? '系统阻止了服务启动，请检查安全软件或换一个端口。' : e.message;
      await this.stop(false); this.status = 'error'; this.changed(); throw new Error(this.message);
    }
  }
  async startCaddy() {
    if (!this.caddyPath || !existsSync(this.caddyPath)) throw new Error('HTTPS 程序缺失，请重新安装 Together Lite。');
    const hostname = new URL(this.prefs.publicUrl).hostname;
    const file = path.join(this.dataDir, 'Caddyfile');
    await writeFile(file, `${hostname} {\n  reverse_proxy 127.0.0.1:${this.prefs.port}\n}\n`);
    const child = spawn(this.caddyPath, ['run', '--config', file], { cwd: this.dataDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, XDG_DATA_HOME: path.join(this.dataDir, 'caddy-data'), XDG_CONFIG_HOME: path.join(this.dataDir, 'caddy-config') } });
    this.caddy = child;
    child.stdout.on('data', b => this.log(b.toString())); child.stderr.on('data', b => this.log(b.toString()));
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve); child.once('error', reject);
    });
    child.on('error', e => { this.log(e.message); this.message = 'HTTPS 入口未能启动，请检查网络设置。'; this.changed(); });
    child.on('exit', code => { if (this.caddy === child) { this.caddy = undefined; this.message = `HTTPS 入口已停止${code ? `（${code}）` : ''}，请查看连接检查。`; this.changed(); } });
  }
  async stop(clearMessage = true) {
    this.status = 'stopping'; this.changed();
    const service = this.service; this.service = undefined;
    if (this.caddy) { const child = this.caddy; this.caddy = undefined; child.kill(); }
    if (service) { for (const room of service.rooms.values()) closeRoom(room, '房主已停止观影服务'); await service.app.close(); }
    this.cookie = ''; this.previewKey = ''; this.instanceId = ''; this.status = 'stopped'; if (clearMessage) this.message = '';
    await this.scan(); this.changed(); return this.snapshot();
  }
  async updateSettings(input) {
    const next = validateSettings(input, this.prefs);
    const connectionChanged = ['port', 'maxMembers', 'publicUrl', 'connectionMode'].some(k => next[k] !== this.prefs[k]);
    if (connectionChanged && this.service?.rooms.size) throw new Error('还有观影室正在开放。请先结束观影或停止服务，再修改连接设置。');
    const restart = connectionChanged && !!this.service;
    if (restart) await this.stop();
    this.prefs = next; await this.save();
    if (restart) await this.start();
    this.changed(); return this.snapshot();
  }
  async addFiles(paths) {
    if (!Array.isArray(paths) || paths.length > 100) throw new Error('一次最多添加 100 部影片。');
    const accepted = [];
    for (const file of paths) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.mp4') throw new Error('请选择 MP4 影片；其他格式需要先转换。');
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || !s.size) throw new Error('这个文件无法作为影片读取，请重新选择。');
      accepted.push(await realpath(file));
    }
    if (accepted.includes(this.demoFile)) this.prefs.demoEnabled = true;
    this.prefs.mediaFiles = [...new Set([...this.prefs.mediaFiles, ...accepted.filter(file => file !== this.demoFile)])].slice(0, 500);
    await this.save(); await this.scan(); return this.snapshot();
  }
  async addDirectory(directory) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || !(await lstat(directory)).isDirectory()) throw new Error('请选择影片所在的文件夹。');
    this.prefs.mediaDirectories = [...new Set([...this.prefs.mediaDirectories, await realpath(directory)])].slice(0, 30);
    await this.save(); return this.scan();
  }
  async removeDirectory(directory) {
    if (this.service?.rooms.size) throw new Error('还有观影室正在开放，请结束房间后再移除影片文件夹。');
    this.prefs.mediaDirectories = this.prefs.mediaDirectories.filter(v => v !== directory); await this.save(); return this.scan();
  }
  async removeMedia(id) {
    const movie = this.library.items.get(id); if (!movie) return this.snapshot();
    if (this.service && [...this.service.rooms.values()].some(r => r.media.id === id)) throw new Error('这部影片正在观影室使用，请先结束该房间。');
    this.prefs.mediaFiles = this.prefs.mediaFiles.filter(file => file !== movie.file); delete this.prefs.subtitles[movie.file];
    if (movie.file === this.demoFile) this.prefs.demoEnabled = false;
    await this.save(); return this.scan();
  }
  async attachSubtitle(id, file) {
    const movie = this.library.items.get(id); if (!movie) throw new Error('请先选择影片。');
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.vtt') throw new Error('请使用 WebVTT（.vtt）字幕文件。');
    const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.size > 2 * 1024 * 1024) throw new Error('字幕文件无法读取或超过 2 MB。');
    const content = await readFile(file, 'utf8'); if (!content.replace(/^\uFEFF/, '').startsWith('WEBVTT')) throw new Error('这不是有效的 WebVTT 字幕，请先转换字幕格式。');
    this.prefs.subtitles[movie.file] = await realpath(file); await this.save(); return this.scan();
  }
  async api(method, route, payload) {
    if (!this.service) throw new Error('请先启动观影服务。');
    const result = await this.service.app.inject({ method, url: route, payload,
      headers: { host: `127.0.0.1:${this.prefs.port}`, origin: this.origin, cookie: this.cookie } });
    const data = result.json(); if (result.statusCode >= 400) throw new Error(data.error || '操作未完成，请重试。'); return data;
  }
  async createRoom(mediaId, name) {
    if (!this.service) await this.start();
    const data = await this.api('POST', '/api/rooms', { mediaId, name, nickname: this.prefs.nickname });
    this.changed(); return { ...data, inviteUrl: this.invite(this.service.rooms.get(data.room.id)) };
  }
  async openRoom(id) { await this.api('POST', `/api/rooms/${encodeURIComponent(id)}/join`, { name: this.prefs.nickname }); return `${this.origin}/room/${encodeURIComponent(id)}`; }
  async roomInvite(id, origin, renew = false) {
    if (renew) await this.api('POST', `/api/rooms/${encodeURIComponent(id)}/invite`, {});
    const room = this.service?.rooms.get(id); if (!room) throw new Error('房间已结束。');
    const allowed = [this.prefs.publicUrl, this.origin, ...this.network().lan.map(a => a.url)];
    if (origin && !allowed.includes(origin)) throw new Error('请选择列表中的邀请入口。');
    return this.invite(room, origin);
  }
  async endRoom(id) { await this.api('POST', `/api/rooms/${encodeURIComponent(id)}/close`, {}); this.changed(); return this.snapshot(); }
  async diagnose() {
    const network = this.network();
    const tunnel = this.prefs.connectionMode === 'tunnel';
    let local = false, endpoint = false; const notes = []; let records = [], https = false;
    const checkHealth = async (origin, timeout) => {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
      const data = await response.json();
      return response.ok && data.ok === true && data.instanceId === this.instanceId;
    };
    if (this.service) try { local = await checkHealth(this.origin, 2500); } catch {}
    if (this.prefs.publicUrl) {
      if (!tunnel) {
        try { const resolver = new Resolver({ timeout: 2000, tries: 1 }); records = await resolver.resolve6(new URL(this.prefs.publicUrl).hostname); }
        catch { notes.push('域名还没有可读取的 IPv6（AAAA）记录。请检查域名服务商或 DDNS 设置。'); }
        if (records.length && !records.some(address => network.ipv6.some(a => a.address.toLowerCase() === address.toLowerCase()))) notes.push('域名记录与本机检测到的 IPv6 地址不一致。可能需要更新 DDNS。');
      }
      if (this.service && (tunnel || this.caddy)) try {
        endpoint = await checkHealth(this.prefs.publicUrl, 8000);
        if (!endpoint) notes.push('外网地址没有连接到当前观影服务。请检查隧道的本地地址和端口。');
      } catch (e) {
        const code = e.cause?.code || e.code || '';
        if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) notes.push('HTTPS 证书未通过验证。SakuraFrp 请绑定 nyat.app 子域名并开启自动 HTTPS，等待证书加载后重启隧道。');
        else notes.push(tunnel ? '穿透入口尚未连接到这台电脑。请启动 SakuraFrp 隧道，并核对本地端口与外网地址。' : '本机尚未访问到 HTTPS 入口。请检查域名、证书以及 80/443 端口。');
      }
      https = endpoint && this.prefs.publicUrl.startsWith('https://');
      if (tunnel && this.prefs.publicUrl.startsWith('http://')) notes.push('当前入口使用 HTTP。SakuraFrp 建议使用自动 HTTPS 和子域绑定提供的证书。');
    } else if (tunnel) {
      notes.push(`本地服务地址为 127.0.0.1:${this.prefs.port}。请先在 SakuraFrp 创建 TCP 隧道，再把 HTTPS 连接地址填入软件设置。`);
    }
    if (!tunnel && !network.ipv6.length) notes.push('未检测到全球 IPv6 地址。纯 IPv6 外网分享需要宽带与路由器提供 IPv6。');
    return { local, dnsRecords: records, https, endpoint, connectionMode: this.prefs.connectionMode, ipv6: network.ipv6, notes, externalVerified: false,
      externalMessage: endpoint ? `${tunnel ? '穿透入口' : '本机 HTTPS'}检查通过；请让朋友用手机流量打开邀请并播放，确认外网可用。` : '外网访问仍待实测。' };
  }
}
