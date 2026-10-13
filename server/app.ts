import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { Config } from './config.js';
import { MediaLibrary, parseRange, summary } from './video.js';
import { addMember, broadcast, closeRoom, createRoom, findMember, publicMembers, snapshot, token } from './rooms.js';
import type { Room, Session } from './rooms.js';
import { installSync } from './sync.js';

export async function createApp(config: Config, root: string, hostToken = token(),
  desktop: { selectedFiles?: string[]; subtitles?: Record<string, string>; previewToken?: string; instanceId?: string } = {}) {
  const isLoopback = (ip: string | undefined) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip || '');
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, exposeHeadRoutes: false,
    trustProxy: config.trustProxy ? (address) => isLoopback(address) : false });
  const library = new MediaLibrary(config.mediaDirectories, desktop.selectedFiles, desktop.subtitles);
  await library.scan();
  const rooms = new Map<string, Room>();
  const sessions = new Map<string, Session>();
  const rates = new Map<string, { count: number; until: number }>();
  await app.register(cookie);
  function validSession(id: string | undefined) {
    const session = id && sessions.get(id);
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return session;
  }
  function requestSession(request: FastifyRequest) { return validSession(request.cookies.together_session); }
  function rawSession(request: IncomingMessage) {
    try { return validSession(app.parseCookie(request.headers.cookie || '').together_session); }
    catch { return undefined; }
  }
  function rawOriginAllowed(origin: string | undefined, request: IncomingMessage) {
    if (!origin || origin === 'null') return false;
    const protocol = config.trustProxy && isLoopback(request.socket.remoteAddress) &&
      request.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    return origin === `${protocol}://${request.headers.host}` || (!!config.publicUrl && origin === config.publicUrl);
  }
  function rateLimit(key: string, max: number) {
    const now = Date.now();
    let value = rates.get(key);
    if (!value || value.until <= now) { value = { count: 0, until: now + 60_000 }; rates.set(key, value); }
    if (++value.count > max) throw Object.assign(new Error('操作太频繁，请稍后重试'), { statusCode: 429 });
  }
  const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
  function requireHost(request: FastifyRequest) {
    const session = requestSession(request);
    if (session?.role !== 'host') fail('请使用本机专用的房主入口', 401);
    return session!;
  }
  function requireRoom(request: FastifyRequest) {
    const id = (request.params as { id: string }).id;
    const room = rooms.get(id);
    const session = requestSession(request);
    if (!room || room.closed) fail('房间已关闭或不存在', 404);
    if (!session || (session.role !== 'host' && session.roomId !== id)) fail('请通过邀请链接加入房间', 401);
    const member = findMember(room!, session!);
    if (!member) fail('你尚未加入，或已被房主移出房间', 403);
    return { room: room!, session: session!, member: member! };
  }
  function body(request: FastifyRequest): Record<string, unknown> {
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) fail('请求内容无效');
    return request.body as Record<string, unknown>;
  }
  function nameOf(value: unknown, fallback: string, max = 30) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`名称须为 1～${max} 字`);
    return (value as string).trim();
  }
  function equalSecret(a: unknown, b: string) {
    return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }
  function setSession(reply: FastifyReply, session: Session, request: FastifyRequest) {
    sessions.set(session.id, session);
    reply.setCookie('together_session', session.id, { path: '/', httpOnly: true, sameSite: 'strict',
      secure: request.protocol === 'https' || (config.publicUrl.startsWith('https://') && request.headers.origin === config.publicUrl),
      maxAge: Math.floor((session.expiresAt - Date.now()) / 1000) });
  }
  function inviteUrl(room: Room, request: FastifyRequest) {
    const origin = config.publicUrl || `${request.protocol}://${request.headers.host}`;
    return `${origin}/room/${room.id}#invite=${room.invite}`;
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!['GET', 'HEAD'].includes(request.method)) {
        if (!rawOriginAllowed(request.headers.origin, request.raw)) fail('请求来源无效，请从观影页面操作', 403);
        rateLimit(`${request.ip}:api`, 120);
      }
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as Error & { statusCode?: number };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status === 500) console.error('[Together Lite]', e.message);
    reply.code(status).send({ error: status === 500 ? '服务暂时出错，请查看本机终端' : e.message });
  });
  app.get('/api/health', async () => ({ ok: true, version: '0.2.1', instanceId: desktop.instanceId, publicUrl: config.publicUrl, maxMembers: config.maxMembers }));
  // Only the local desktop controller receives this independent preview capability.
  if (desktop.previewToken) app.route({ method: ['GET', 'HEAD'], url: '/api/desktop/media/:mediaId', handler: async (request, reply) => {
    if (!equalSecret((request.query as { key?: string }).key, desktop.previewToken!)) fail('没有影片预览权限', 401);
    let file;
    try { file = await library.open((request.params as { mediaId: string }).mediaId); } catch (e) { fail((e as Error).message, 404); }
    const { handle, size } = file!;
    reply.header('Access-Control-Allow-Origin', 'null').header('Accept-Ranges', 'bytes').type('video/mp4');
    const range = parseRange(request.headers.range, size);
    if (range === 'invalid') { await handle.close(); return reply.code(416).header('Content-Range', `bytes */${size}`).send(); }
    const start = range ? range.start : 0, end = range ? range.end : size - 1;
    if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    if (request.method === 'HEAD') { await handle.close(); return reply.send(); }
    return reply.send(handle.createReadStream({ start, end, autoClose: true }));
  } });
  app.get('/api/me', async (request) => ({ host: requestSession(request)?.role === 'host' }));
  app.post('/api/host/session', async (request, reply) => {
    rateLimit(`${request.ip}:host`, 10);
    const b = body(request);
    if (!equalSecret(b.token, hostToken)) fail('房主入口已失效，请使用本次启动生成的入口', 401);
    const current = requestSession(request);
    const session: Session = current?.role === 'host' ? current :
      { id: token(), role: 'host', name: '房主', expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    setSession(reply, session, request);
    return { ok: true };
  });
  app.get('/api/host/media', async (request) => { requireHost(request); return { media: library.list(), warnings: library.warnings }; });
  app.get('/api/host/network', async (request) => {
    requireHost(request);
    let origins = [{ label: '当前页面地址', url: `${request.protocol}://${request.headers.host}` }];
    if (config.publicUrl) origins.unshift({ label: '配置的公网入口', url: config.publicUrl });
    else if (!['127.0.0.1', '::1'].includes(config.host)) {
      const lan: { label: string; url: string; virtual: boolean }[] = [];
      for (const [label, addresses] of Object.entries(networkInterfaces())) for (const a of addresses || [])
        if (!a.internal && a.family === 'IPv4' && !a.address.startsWith('169.254.'))
          lan.push({ label: `局域网 · ${label} · ${a.address}`, url: `http://${a.address}:${config.port}`,
            virtual: /vethernet|vmware|virtual|wsl|tap|tun|clash|docker|vmnet/i.test(label) || a.address.startsWith('198.18.') });
      lan.sort((a, b) => Number(a.virtual) - Number(b.virtual));
      origins = [...lan.map(({ label, url }) => ({ label, url })), ...origins];
    }
    return { origins: origins.filter((o, i) => origins.findIndex((p) => p.url === o.url) === i), publicConfigured: !!config.publicUrl };
  });
  app.post('/api/host/media/scan', async (request) => { requireHost(request); await library.scan(); return { media: library.list(), warnings: library.warnings }; });
  app.get('/api/host/rooms', async (request) => {
    requireHost(request);
    return { rooms: [...rooms.values()].filter((r) => !r.closed).map((r) => ({ id: r.id, name: r.name,
      media: summary(r.media), members: publicMembers(r), inviteUrl: inviteUrl(r, request) })) };
  });
  app.post('/api/rooms', async (request, reply) => {
    const session = requireHost(request), b = body(request);
    if (rooms.size >= 10) fail('最多同时开启 10 个房间，请先关闭闲置房间');
    const media = typeof b.mediaId === 'string' ? library.items.get(b.mediaId) : undefined;
    if (!media) fail('请选择片库中的影片');
    const room = createRoom(nameOf(b.name, '今晚一起看', 50), media!);
    const member = addMember(room, session, nameOf(b.nickname, '房主'), config.maxMembers);
    rooms.set(room.id, room);
    reply.code(201);
    return { room: snapshot(room, member), inviteUrl: inviteUrl(room, request) };
  });
  app.post('/api/rooms/:id/preview', async (request) => {
    rateLimit(`${request.ip}:invite`, 30);
    const room = rooms.get((request.params as { id: string }).id);
    if (!room || room.closed || !equalSecret(body(request).token, room.invite)) fail('邀请已失效，请向房主获取新链接', 404);
    return { name: room!.name, mediaName: room!.media.name, maxMembers: config.maxMembers };
  });
  app.post('/api/rooms/:id/join', async (request, reply) => {
    rateLimit(`${request.ip}:join`, 30);
    const room = rooms.get((request.params as { id: string }).id), b = body(request);
    if (!room || room.closed) fail('房间已关闭或不存在', 404);
    let session = requestSession(request);
    const alreadyJoined = session && findMember(room!, session);
    if (session?.role !== 'host' && !alreadyJoined && !equalSecret(b.token, room!.invite)) fail('邀请已失效，请向房主获取新链接', 403);
    const name = nameOf(b.name, session?.role === 'host' ? '房主' : '朋友');
    const fresh = !session || (session.role !== 'host' && session.roomId !== room!.id);
    if (fresh) session = { id: token(), role: 'guest', name, roomId: room!.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 };
    let member;
    try { member = addMember(room!, session!, name, config.maxMembers); }
    catch (e) { fail((e as Error).message, 409); }
    if (fresh) {
      const old = requestSession(request);
      if (old?.role === 'guest') {
        sessions.delete(old.id);
        for (const r of rooms.values()) {
          const oldMember = findMember(r, old);
          if (oldMember) {
            for (const ws of oldMember.sockets) ws.close(1008, 'Joined another room');
            r.members.delete(oldMember.id);
            broadcast(r, { type: 'members', members: publicMembers(r) });
          }
        }
      }
      setSession(reply, session!, request);
    }
    broadcast(room!, { type: 'members', members: publicMembers(room!) });
    return { room: snapshot(room!, member!) };
  });
  app.get('/api/rooms/:id', async (request) => { const { room, member } = requireRoom(request); return { room: snapshot(room, member) }; });
  app.post('/api/rooms/:id/settings', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request), b = body(request);
    if (!['everyone', 'host'].includes(b.controlMode as string)) fail('控制模式无效');
    room.controlMode = b.controlMode as Room['controlMode'];
    broadcast(room, { type: 'settings', controlMode: room.controlMode });
    return { ok: true };
  });
  app.post('/api/rooms/:id/media', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request), b = body(request);
    const media = typeof b.mediaId === 'string' ? library.items.get(b.mediaId) : undefined;
    if (!media) fail('影片不存在，请刷新片库');
    room.media = media!;
    room.state = { videoId: room.media.id, playing: false, position: 0, updatedAt: Date.now(), version: room.state.version + 1 };
    for (const m of room.members.values()) m.status = 'unready';
    broadcast(room, { type: 'state', state: { ...room.state }, serverTime: Date.now(), media: summary(room.media) });
    broadcast(room, { type: 'members', members: publicMembers(room) });
    return { ok: true };
  });
  app.post('/api/rooms/:id/invite', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request);
    room.invite = token();
    return { inviteUrl: inviteUrl(room, request) };
  });
  app.get('/api/rooms/:id/invite', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request);
    return { inviteUrl: inviteUrl(room, request) };
  });
  app.post('/api/rooms/:id/remove', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request), b = body(request);
    const member = typeof b.memberId === 'string' ? room.members.get(b.memberId) : undefined;
    if (!member || member.role === 'host') fail('请选择要移出的访客');
    sessions.delete((member as NonNullable<typeof member>).sessionId);
    for (const ws of (member as NonNullable<typeof member>).sockets) {
      ws.send(JSON.stringify({ type: 'closed', reason: '你已被房主移出房间' })); ws.close(1000, 'Removed');
    }
    room.members.delete((member as NonNullable<typeof member>).id);
    broadcast(room, { type: 'members', members: publicMembers(room) });
    return { ok: true };
  });
  app.post('/api/rooms/:id/leave', async (request, reply) => {
    const { room, member, session } = requireRoom(request);
    for (const ws of member.sockets) ws.close(1000, 'Left');
    if (member.role === 'guest') {
      room.members.delete(member.id); sessions.delete(session.id);
      reply.clearCookie('together_session', { path: '/' });
    }
    broadcast(room, { type: 'members', members: publicMembers(room) });
    return { ok: true };
  });
  app.post('/api/rooms/:id/close', async (request) => {
    requireHost(request);
    const { room } = requireRoom(request);
    closeRoom(room, '房主已结束本次观影'); rooms.delete(room.id);
    for (const [id, s] of sessions) if (s.roomId === room.id) sessions.delete(id);
    return { ok: true };
  });
  app.route({ method: ['GET', 'HEAD'], url: '/api/rooms/:id/media/:mediaId', handler: async (request, reply) => {
    const { room } = requireRoom(request);
    if ((request.params as { mediaId: string }).mediaId !== room.media.id) fail('影片已切换，请重新同步', 404);
    let file;
    try { file = await library.open(room.media.id); } catch (e) { fail((e as Error).message, 404); }
    const { handle, size } = file!;
    const range = parseRange(request.headers.range, size);
    reply.header('Accept-Ranges', 'bytes').header('Content-Type', 'video/mp4');
    if (range === 'invalid') { await handle.close(); return reply.code(416).header('Content-Range', `bytes */${size}`).send(); }
    const start = range ? range.start : 0, end = range ? range.end : size - 1;
    if (range) reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`);
    reply.header('Content-Length', end - start + 1);
    if (request.method === 'HEAD') { await handle.close(); return reply.send(); }
    return reply.send(handle.createReadStream({ start, end, autoClose: true }));
  } });
  app.get('/api/rooms/:id/subtitle/:mediaId', async (request, reply) => {
    const { room } = requireRoom(request);
    if ((request.params as { mediaId: string }).mediaId !== room.media.id) fail('字幕已切换', 404);
    let file;
    try { file = await library.open(room.media.id, true); } catch (e) { fail((e as Error).message, 404); }
    return reply.type('text/vtt; charset=utf-8').header('Content-Length', file!.size).send(file!.handle.createReadStream());
  });
  const wss = installSync(app, config, rooms, rawSession, rawOriginAllowed);
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of rooms) if (![...r.members.values()].some((m) => m.sockets.size) && now - r.touchedAt > config.roomIdleMinutes * 60_000) {
      closeRoom(r, '闲置房间已关闭'); rooms.delete(id);
    }
    for (const [id, s] of sessions) if (s.expiresAt < now) {
      sessions.delete(id);
      for (const room of rooms.values()) {
        const member = findMember(room, s);
        if (member) { for (const ws of member.sockets) ws.close(1008, 'Session expired'); room.members.delete(member.id); broadcast(room, { type: 'members', members: publicMembers(room) }); }
      }
    }
    for (const [id, r] of rates) if (r.until < now) rates.delete(id);
  }, 60_000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); });
  if (existsSync(path.join(root, 'dist/index.html'))) {
    await app.register(fastifyStatic, { root: path.join(root, 'dist'), prefix: '/', index: 'index.html' });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && /^\/(?:host|room\/[A-Za-z0-9_-]+)?$/.test(request.url.split('?')[0])) return reply.sendFile('index.html');
      return reply.code(404).send({ error: '页面或资源不存在' });
    });
  }
  return { app, config, rooms, sessions, library, wss, hostToken };
}
