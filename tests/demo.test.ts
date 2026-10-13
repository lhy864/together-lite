import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { DesktopController } from '../desktop/controller.mjs';
test('Bundled demo follows each application location without persisting extraction paths', async () => {
  const runtime = path.resolve('.runtime'); await mkdir(runtime, { recursive: true });
  const root = await mkdtemp(path.join(runtime, 'demo-test-'));
  try {
    const dataDir = path.join(root, 'profile');
    const demoA = path.join(root, 'bundle-a', 'demo.mp4'), demoB = path.join(root, 'bundle-b', 'demo.mp4');
    await mkdir(path.dirname(demoA), { recursive: true }); await mkdir(path.dirname(demoB), { recursive: true });
    await writeFile(demoA, Buffer.alloc(100, 1)); await writeFile(demoB, Buffer.alloc(100, 1));
    const first = new DesktopController({ root: process.cwd(), dataDir, demoFile: demoA }); await first.init();
    assert.equal(first.snapshot().media[0].demo, true);
    const saved = JSON.parse(await readFile(path.join(dataDir, 'preferences.json'), 'utf8'));
    assert.equal(saved.demoEnabled, true); assert.deepEqual(saved.mediaFiles, []); assert.ok(!JSON.stringify(saved).includes('bundle-a'));
    const updated = new DesktopController({ root: process.cwd(), dataDir, demoFile: demoB }); await updated.init();
    assert.equal(updated.snapshot().media[0].demo, true); assert.notEqual(updated.snapshot().media[0].id, first.snapshot().media[0].id);
    await updated.removeMedia(updated.snapshot().media[0].id);
    const reopened = new DesktopController({ root: process.cwd(), dataDir, demoFile: demoA }); await reopened.init(); assert.equal(reopened.snapshot().media.length, 0);
  } finally { assert.equal(path.dirname(root), runtime); assert.ok(path.basename(root).startsWith('demo-test-')); await rm(root, { recursive: true, force: true }); }
});
