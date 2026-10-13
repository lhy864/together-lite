import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { parseRange, MediaLibrary } from '../server/video.js';
import { positionAt } from '../server/rooms.js';
import type { ServerMessage, RoomSnapshot } from '../shared/protocol.js';

test('Range parsing handles open, suffix, bounded and unsatisfiable ranges', () => {
  assert.deepEqual(parseRange('bytes=10-', 100), { start: 10, end: 99 });
  assert.deepEqual(parseRange('bytes=-12', 100), { start: 88, end: 99 });
  assert.deepEqual(parseRange('bytes=20-200', 100), { start: 20, end: 99 });
  for (const header of ['bytes=100-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=9007199254740999-']) assert.equal(parseRange(header, 100), 'invalid');
  assert.equal(parseRange('bytes=0-1,5-8', 100), null);
  assert.equal(positionAt({ videoId: 'a', playing: true, position: 10, updatedAt: 1000, version: 1 }, 2500), 11.5);
});

test('Authenticated video and room lifecycle with independent WebSocket members', async (t) => {
  const runtime = path.resolve('.runtime'); await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'test-'));
  const mediaDir = path.join(root, 'media'); await mkdir(mediaDir);
  const fixture = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
  await writeFile(path.join(mediaDir, 'sample.mp4'), fixture);
  await writeFile(path.join(mediaDir, 'second.mp4'), Buffer.alloc(200, 7));
  await writeFile(path.join(mediaDir, 'sample.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');
  await writeFile(path.join(root, 'private.mp4'), Buffer.from('private'));
  const service = await createApp({ host: '127.0.0.1', port: 0, mediaDirectories: [mediaDir], publicUrl: '', trustProxy: false, maxMembers: 4, roomIdleMinutes: 120 }, root, 'test-host-token');
  const { app } = service;
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    // Only delete this test's freshly created directory, beneath .runtime.
    assert.equal(path.dirname(root), runtime); assert.ok(path.basename(root).startsWith('test-'));
    await rm(root, { recursive: true, force: true });
  });
  const request = (method: 'GET' | 'POST' | 'HEAD', url: string, payload?: unknown, cookie?: string, headers = {}) => app.inject({ method, url,
    payload: payload as object, headers: { host: new URL(origin).host, origin, ...(cookie ? { cookie } : {}), ...headers } });
  const sessionCookie = (response: Awaited<ReturnType<typeof request>>) => String(response.headers['set-cookie']).split(';')[0];
  let hostCookie = '', guestCookie = '', room!: RoomSnapshot, invitation = '';
  await t.test('No host capability, no media list; no valid Origin, no mutations', async () => {
    assert.equal((await request('GET', '/api/host/media')).statusCode, 401);
    assert.equal((await request('POST', '/api/host/session', { token: 'test-host-token' }, undefined, { origin: 'https://evil.example' })).statusCode, 403);
    assert.equal((await request('POST', '/api/host/session', { token: 'bad' })).statusCode, 401);
    const response = await request('POST', '/api/host/session', { token: 'test-host-token' });
    assert.equal(response.statusCode, 200); hostCookie = sessionCookie(response);
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
    const library = (await request('GET', '/api/host/media', undefined, hostCookie)).json();
    assert.equal(library.media.length, 2); assert.ok(!JSON.stringify(library.media).includes(mediaDir));
    const created = await request('POST', '/api/rooms', { mediaId: library.media.find((m: any) => m.name === 'sample').id, name: 'test room' }, hostCookie);
    assert.equal(created.statusCode, 201); room = created.json().room;
    invitation = new URL(created.json().inviteUrl).hash.slice('#invite='.length);
  });
  await t.test('Invites authorize joining; anonymous and wrong-room video are denied', async () => {
    const video = `/api/rooms/${room.id}/media/${room.media.id}`;
    assert.equal((await request('GET', video)).statusCode, 401);
    assert.equal((await request('POST', `/api/rooms/${room.id}/join`, { token: 'invalid', name: 'friend' })).statusCode, 403);
    const joined = await request('POST', `/api/rooms/${room.id}/join`, { token: invitation, name: 'friend' });
    assert.equal(joined.statusCode, 200); guestCookie = sessionCookie(joined);
    const another = await request('POST', '/api/rooms', { mediaId: room.media.id }, hostCookie);
    assert.equal((await request('GET', `/api/rooms/${another.json().room.id}/media/${room.media.id}`, undefined, guestCookie)).statusCode, 401);
    assert.equal((await request('GET', `/api/rooms/${room.id}/media/..%2Fprivate.mp4`, undefined, guestCookie)).statusCode, 404);
  });
  await t.test('Real byte responses, HEAD and subtitle require room membership', async () => {
    const url = `/api/rooms/${room.id}/media/${room.media.id}`;
    const partial = await request('GET', url, undefined, guestCookie, { range: 'bytes=128-255' });
    assert.equal(partial.statusCode, 206); assert.equal(partial.headers['content-range'], 'bytes 128-255/512'); assert.deepEqual(partial.rawPayload, fixture.subarray(128, 256));
    const suffix = await request('GET', url, undefined, guestCookie, { range: 'bytes=-10' }); assert.deepEqual(suffix.rawPayload, fixture.subarray(502));
    const invalid = await request('GET', url, undefined, guestCookie, { range: 'bytes=512-' }); assert.equal(invalid.statusCode, 416); assert.equal(invalid.headers['content-range'], 'bytes */512');
    const head = await request('HEAD', url, undefined, guestCookie); assert.equal(head.statusCode, 200); assert.equal(head.headers['content-length'], '512'); assert.equal(head.rawPayload.length, 0);
    const all = await request('GET', url, undefined, guestCookie); assert.deepEqual(all.rawPayload, fixture);
    assert.equal((await request('GET', `/api/rooms/${room.id}/subtitle/${room.media.id}`)).statusCode, 401);
    const subtitle = await request('GET', `/api/rooms/${room.id}/subtitle/${room.media.id}`, undefined, guestCookie); assert.equal(subtitle.statusCode, 200); assert.match(subtitle.body, /WEBVTT/);
  });
  function connection(cookie: string, overrideOrigin = origin) {
    const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/${room.id}`, { headers: { cookie, origin: overrideOrigin } });
    sockets.push(ws);
    const queue: ServerMessage[] = [];
    const waiters: (() => void)[] = [];
    ws.on('message', raw => { queue.push(JSON.parse(raw.toString())); waiters.splice(0).forEach(fn => fn()); });
    ws.on('error', () => {});
    const ready = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    async function next(type: ServerMessage['type']): Promise<any> {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        const index = queue.findIndex(m => m.type === type); if (index >= 0) return queue.splice(index, 1)[0];
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 25); waiters.push(() => { clearTimeout(timer); resolve(); }); });
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
    return { ws, ready, next, send: (m: object) => ws.send(JSON.stringify(m)) };
  }
  let owner!: ReturnType<typeof connection>, friend!: ReturnType<typeof connection>;
  await t.test('WebSockets reject cross-site and unauthorized upgrades', async () => {
    await assert.rejects(connection(guestCookie, 'https://evil.example').ready);
    await assert.rejects(connection('together_session=invalid').ready);
    owner = connection(hostCookie); friend = connection(guestCookie); await Promise.all([owner.ready, friend.ready]);
    assert.equal((await owner.next('snapshot')).room.id, room.id); assert.equal((await friend.next('snapshot')).room.members.length, 2);
  });
  await t.test('Play, pause, seek and stale-command rejection are authoritative', async () => {
    const command = (action: string, position: number, baseVersion: number, commandId: string) => ({ type: 'control', action, position, baseVersion, videoId: room.media.id, commandId });
    owner.send(command('play', 5, 1, 'play-1'));
    const state = (await friend.next('state')).state; assert.equal(state.playing, true); assert.equal(state.version, 2); assert.equal(state.position, 5); await owner.next('state');
    friend.send(command('pause', 8, 1, 'stale')); assert.equal((await friend.next('snapshot')).room.state.version, 2); assert.match((await friend.next('error')).message, /状态已更新/);
    friend.send(command('pause', 8, 2, 'pause-1')); assert.equal((await owner.next('state')).state.playing, false); await friend.next('state');
    owner.send(command('seek', 120, 3, 'seek-1')); assert.equal((await friend.next('state')).state.position, 120); await owner.next('state');
    owner.send(command('seek', 120, 3, 'seek-1')); assert.equal((await owner.next('snapshot')).room.state.version, 4);
    friend.send({ type: 'control', action: 'seek', position: -1, baseVersion: 4, videoId: room.media.id, commandId: 'bad' }); assert.match((await friend.next('error')).message, /无效/);
  });
  await t.test('Chat, status, host-only control and reconnect restore current state', async () => {
    friend.send({ type: 'chat', text: '<script>literal text</script>' }); assert.equal((await owner.next('chat')).message.text, '<script>literal text</script>');
    friend.send({ type: 'status', status: 'buffering' });
    const setting = await request('POST', `/api/rooms/${room.id}/settings`, { controlMode: 'host' }, hostCookie); assert.equal(setting.statusCode, 200); await friend.next('settings');
    friend.send({ type: 'control', action: 'play', position: 120, baseVersion: 4, videoId: room.media.id, commandId: 'forbidden' }); assert.match((await friend.next('error')).message, /仅房主/);
    friend.ws.close(); await new Promise<void>(resolve => friend.ws.once('close', () => resolve()));
    const again = connection(guestCookie); await again.ready; const restored = (await again.next('snapshot')).room;
    assert.equal(restored.state.version, 4); assert.equal(restored.state.position, 120); assert.equal(restored.messages.length, 1); friend = again;
  });
  await t.test('Capacity includes host, revoked invitations cannot create new sessions', async () => {
    for (const name of ['friend2', 'friend3']) assert.equal((await request('POST', `/api/rooms/${room.id}/join`, { name, token: invitation })).statusCode, 200);
    assert.equal((await request('POST', `/api/rooms/${room.id}/join`, { name: 'friend4', token: invitation })).statusCode, 409);
    assert.equal((await request('POST', `/api/rooms/${room.id}/invite`, {}, guestCookie)).statusCode, 401);
    assert.equal((await request('POST', `/api/rooms/${room.id}/invite`, {}, hostCookie)).statusCode, 200);
    assert.equal((await request('POST', `/api/rooms/${room.id}/preview`, { token: invitation })).statusCode, 404);
    assert.equal((await request('GET', `/api/rooms/${room.id}`, undefined, guestCookie)).statusCode, 200);
  });
  await t.test('Switching media resets playback, invalidates old resource, and rejects old commands', async () => {
    const originalId = room.media.id, originalVideo = `/api/rooms/${room.id}/media/${originalId}`;
    const media = service.library.list().find(m => m.name === 'second')!;
    assert.equal((await request('POST', `/api/rooms/${room.id}/media`, { mediaId: media.id }, hostCookie)).statusCode, 200);
    const changed = (await friend.next('state')).state; assert.equal(changed.videoId, media.id); assert.equal(changed.position, 0); assert.equal(changed.playing, false);
    assert.equal((await request('GET', originalVideo, undefined, guestCookie)).statusCode, 404);
    friend.send({ type: 'control', action: 'seek', position: 10, baseVersion: changed.version, videoId: originalId, commandId: 'old-film' });
    // Host-only mode rejects a guest before checking the old media identity.
    await friend.next('error');
    owner.send({ type: 'control', action: 'seek', position: 10, baseVersion: changed.version, videoId: originalId, commandId: 'old-film-owner' }); await owner.next('snapshot'); assert.match((await owner.next('error')).message, /状态已更新/);
    await writeFile(path.join(mediaDir, 'second.mp4'), Buffer.alloc(201, 8));
    assert.equal((await request('GET', `/api/rooms/${room.id}/media/${media.id}`, undefined, guestCookie)).statusCode, 404);
  });
  await t.test('Removal revokes cookies; closing notifies members and removes the room', async () => {
    const live = (await request('GET', `/api/rooms/${room.id}`, undefined, hostCookie)).json().room as RoomSnapshot;
    const guestId = live.members.find(m => m.name === 'friend')!.id;
    assert.equal((await request('POST', `/api/rooms/${room.id}/remove`, { memberId: guestId }, hostCookie)).statusCode, 200);
    assert.equal((await friend.next('closed')).reason, '你已被房主移出房间');
    assert.equal((await request('GET', `/api/rooms/${room.id}`, undefined, guestCookie)).statusCode, 401);
    assert.equal((await request('POST', `/api/rooms/${room.id}/close`, {}, hostCookie)).statusCode, 200);
    assert.equal((await owner.next('closed')).reason, '房主已结束本次观影');
    assert.equal((await request('GET', `/api/rooms/${room.id}`, undefined, hostCookie)).statusCode, 404);
  });
  await t.test('Rescan creates new identity for changed files and omits files outside configured roots', async () => {
    const library = new MediaLibrary([mediaDir]); await library.scan();
    assert.equal(library.list().length, 2); assert.ok(!library.list().some(m => m.name === 'private'));
  });
});
