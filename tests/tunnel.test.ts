import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { DesktopController, validateSettings } from '../desktop/controller.mjs';

const base = { nickname: '房主', port: 3001, maxMembers: 4, publicUrl: '', autoStart: false };
async function listen(server: net.Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}
async function fixture(t: any) {
  const runtime = path.resolve('.runtime'); await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'tunnel-test-'));
  const controller = new DesktopController({ root: process.cwd(), dataDir: path.join(root, 'profile'), caddyPath: '' });
  await controller.init();
  const movie = path.join(root, 'movie.mp4'); await writeFile(movie, Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256)));
  await controller.addFiles([movie]);
  t.after(async () => { await controller.stop(); assert.equal(path.dirname(root), runtime); assert.ok(path.basename(root).startsWith('tunnel-test-')); await rm(root, { recursive: true, force: true }); });
  return controller;
}

test('Tunnel settings accept remote ports, preserve legacy direct mode and reject ambiguous addresses', () => {
  assert.equal(validateSettings({}, base).connectionMode, 'direct');
  const tunnel = validateSettings({ connectionMode: 'tunnel', publicUrl: 'www-video.example.nyat.app:48732' }, base);
  assert.equal(tunnel.publicUrl, 'https://www-video.example.nyat.app:48732');
  assert.equal(validateSettings({ publicUrl: 'http://203.0.113.10:48732' }, tunnel).publicUrl, 'http://203.0.113.10:48732');
  for (const publicUrl of ['ftp://example.com:48732', 'https://user:pass@example.com', 'https://example.com/room/a#invite=secret', 'https://example.com?token=x'])
    assert.throws(() => validateSettings({ connectionMode: 'tunnel', publicUrl }, base));
  assert.throws(() => validateSettings({ connectionMode: 'direct' }, tunnel));
  assert.throws(() => validateSettings({ connectionMode: 'invalid' }, base));
});

test('Existing loopback service is detected before a misleading dual-stack startup', async t => {
  const controller = await fixture(t);
  const occupied = net.createServer(); const port = await listen(occupied);
  t.after(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  await controller.updateSettings({ port });
  await assert.rejects(controller.start(), /端口.*其他程序/);
  assert.equal(controller.snapshot().status, 'error'); assert.equal(controller.service, undefined);
});

test('Tunnel mode forwards authenticated Range video and WebSocket state without requiring IPv6 or Caddy', async t => {
  const controller = await fixture(t);
  const probe = net.createServer(); const localPort = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve()));
  const forwarder = net.createServer(socket => {
    const upstream = net.connect(localPort, '127.0.0.1'); socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  const remotePort = await listen(forwarder), publicUrl = `http://127.0.0.1:${remotePort}`;
  t.after(() => new Promise<void>(resolve => forwarder.close(() => resolve())));
  await controller.updateSettings({ connectionMode: 'tunnel', port: localPort, publicUrl });
  await controller.start();
  assert.equal(controller.service.app.server.address().address, '127.0.0.1');
  assert.equal(controller.snapshot().caddy, 'unused');
  const room = (await controller.createRoom(controller.snapshot().media[0].id, '穿透测试')).room;
  const invite = new URL(await controller.roomInvite(room.id, publicUrl));
  assert.equal(invite.origin, publicUrl); const token = invite.hash.slice('#invite='.length);
  const joined = await fetch(`${publicUrl}/api/rooms/${room.id}/join`, { method: 'POST', headers: { origin: publicUrl, 'content-type': 'application/json' }, body: JSON.stringify({ token, name: '远方朋友' }) });
  assert.equal(joined.status, 200); const guest = await joined.json();
  const cookie = joined.headers.get('set-cookie')!.split(';')[0];
  const video = `${publicUrl}/api/rooms/${room.id}/media/${guest.room.media.id}`;
  assert.equal((await fetch(video)).status, 401);
  const fragment = await fetch(video, { headers: { cookie, range: 'bytes=100-119' } });
  assert.equal(fragment.status, 206); assert.equal(fragment.headers.get('content-range'), 'bytes 100-119/512');
  assert.deepEqual([...new Uint8Array(await fragment.arrayBuffer())], Array.from({ length: 20 }, (_, i) => i + 100));
  const socket = new WebSocket(`${publicUrl.replace('http:', 'ws:')}/ws/${room.id}`, { headers: { cookie, origin: publicUrl } });
  t.after(() => socket.terminate());
  const snapshot = await new Promise<any>((resolve, reject) => { socket.once('message', message => resolve(JSON.parse(message.toString()))); socket.once('error', reject); });
  assert.equal(snapshot.type, 'snapshot');
  const changed = new Promise<any>(resolve => socket.once('message', message => resolve(JSON.parse(message.toString()))));
  socket.send(JSON.stringify({ type: 'control', action: 'seek', position: 42, videoId: guest.room.media.id, baseVersion: guest.room.state.version, commandId: 'tunnel-seek' }));
  assert.equal((await changed).state.position, 42);
  const diagnosis = await controller.diagnose(); assert.equal(diagnosis.local, true); assert.equal(diagnosis.endpoint, true);
  assert.equal(diagnosis.externalVerified, false); assert.deepEqual(diagnosis.dnsRecords, []);
  assert.ok(!diagnosis.notes.some((note: string) => /AAAA|未检测到全球/.test(note)));
  const reopened = new DesktopController({ root: process.cwd(), dataDir: controller.dataDir, caddyPath: '' }); await reopened.init();
  assert.equal(reopened.snapshot().settings.connectionMode, 'tunnel'); assert.equal(reopened.snapshot().settings.publicUrl, publicUrl);
  socket.terminate(); await controller.stop();
});

test('HTTPS tunnel cookies stay Secure even when frpc omits forwarded protocol', async t => {
  const controller = await fixture(t);
  const probe = net.createServer(); const port = await listen(probe); await new Promise<void>(resolve => probe.close(() => resolve()));
  const publicUrl = 'https://watch.example.nyat.app:48732';
  await controller.updateSettings({ connectionMode: 'tunnel', port, publicUrl }); await controller.start();
  const created = await controller.createRoom(controller.snapshot().media[0].id, 'HTTPS');
  const token = new URL(created.inviteUrl).hash.slice('#invite='.length);
  const response = await controller.service.app.inject({ method: 'POST', url: `/api/rooms/${created.room.id}/join`, headers: { origin: publicUrl, host: new URL(publicUrl).host }, payload: { token, name: 'HTTPS 朋友' } });
  assert.equal(response.statusCode, 200); assert.match(String(response.headers['set-cookie']), /; Secure/);
  assert.ok(!controller.cookie.includes('Secure'));
});
