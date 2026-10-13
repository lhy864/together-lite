import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { DesktopController, validateSettings } from '../desktop/controller.mjs';

async function freePort() {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
test('Desktop settings validate domain, nickname, seat count and port', () => {
  const original = { nickname: '房主', port: 3000, maxMembers: 4, publicUrl: '', autoStart: true };
  assert.equal(validateSettings({ publicUrl: 'watch.example.com' }, original).publicUrl, 'https://watch.example.com');
  for (const input of [{ publicUrl: 'http://example.com' }, { publicUrl: 'https://example.com/path' }, { publicUrl: 'https://a.example.com:3000' }, { port: 80 }, { maxMembers: 5 }, { nickname: '' }]) assert.throws(() => validateSettings(input, original));
  assert.equal(original.publicUrl, '');
});
test('Desktop manages chosen files, settings, previews and service lifecycle', async (t) => {
  const runtime = path.resolve('.runtime'); await mkdir(runtime, { recursive: true });
  const temporary = await mkdtemp(path.join(runtime, 'desktop-test-'));
  const films = path.join(temporary, 'films'), captions = path.join(temporary, 'captions');
  await mkdir(films); await mkdir(captions);
  const file = path.join(films, 'chosen.mp4'); await writeFile(file, Buffer.alloc(256, 7));
  await writeFile(path.join(films, 'unselected.mp4'), Buffer.alloc(128, 8));
  const caption = path.join(captions, 'external.vtt'); await writeFile(caption, 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');
  const dataDir = path.join(temporary, 'profile');
  const controller = new DesktopController({ root: process.cwd(), dataDir, demoFile: undefined, caddyPath: '' });
  t.after(async () => { await controller.stop(); assert.equal(path.dirname(temporary), runtime); assert.ok(path.basename(temporary).startsWith('desktop-test-')); await rm(temporary, { recursive: true, force: true }); });
  await controller.init();
  await controller.updateSettings({ port: await freePort(), nickname: '测试房主', autoStart: false });
  let snapshot = await controller.addFiles([file]); assert.equal(snapshot.media.length, 1); assert.equal(snapshot.media[0].name, 'chosen');
  await assert.rejects(controller.addFiles([path.join(films, 'chosen.mkv')]));
  snapshot = await controller.attachSubtitle(snapshot.media[0].id, caption); assert.equal(snapshot.media[0].subtitle, true);
  await controller.start(); assert.equal(controller.snapshot().status, 'running');
  const media = controller.snapshot().media[0];
  assert.equal((await fetch(media.previewUrl)).status, 200);
  assert.equal((await fetch(media.previewUrl.replace(/key=.*/, 'key=invalid'))).status, 401);
  assert.equal((await fetch(`${controller.origin}/api/host/media`)).status, 401);
  const created = await controller.createRoom(media.id, '测试观影');
  const roomId = created.room.id;
  assert.equal(controller.snapshot().rooms.length, 1);
  await assert.rejects(controller.updateSettings({ port: await freePort() }), /先结束观影/);
  await assert.rejects(controller.removeMedia(media.id), /正在观影室/);
  await assert.rejects(controller.roomInvite(roomId, 'https://evil.example'), /列表/);
  const localInvite = await controller.roomInvite(roomId, controller.origin); assert.ok(localInvite.startsWith(controller.origin));
  const newInvite = await controller.roomInvite(roomId, controller.origin, true); assert.notEqual(newInvite, localInvite);
  const diagnosis = await controller.diagnose(); assert.equal(diagnosis.local, true); assert.equal(diagnosis.externalVerified, false);
  await controller.endRoom(roomId); assert.equal(controller.snapshot().rooms.length, 0);
  await controller.stop(); assert.equal(controller.snapshot().status, 'stopped');
  await controller.start(); assert.equal(controller.snapshot().status, 'running'); await controller.stop();
  const reopened = new DesktopController({ root: process.cwd(), dataDir, caddyPath: '' }); await reopened.init();
  assert.equal(reopened.snapshot().media.length, 1); assert.equal(reopened.snapshot().settings.nickname, '测试房主');
  assert.ok((await readFile(path.join(dataDir, 'preferences.json'), 'utf8')).includes('测试房主'));
  await controller.removeMedia(media.id); assert.equal(controller.snapshot().media.length, 0); assert.equal((await readFile(file)).length, 256);
});
