import { app, BrowserWindow, ipcMain, dialog, clipboard, session } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { DesktopController } from './controller.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.TOGETHER_DATA_DIR) { const data = path.resolve(process.env.TOGETHER_DATA_DIR); mkdirSync(data, { recursive: true }); app.setPath('userData', data); }
app.setAppUserModelId('com.togetherlite.desktop');
const locked = app.requestSingleInstanceLock();
let mainWindow, controller, quitting = false, closePrompt = false;
const roomWindows = new Map();
const homeFile = path.join(root, 'desktop-dist/index.html'), homeUrl = pathToFileURL(homeFile).href;
if (!locked) app.quit();
else app.whenReady().then(async () => {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  const resources = app.isPackaged ? process.resourcesPath : root;
  controller = new DesktopController({ root, dataDir: app.getPath('userData'),
    demoFile: path.join(resources, app.isPackaged ? 'demo' : 'media', 'Together 测试影片.mp4'),
    caddyPath: path.join(resources, 'tools/caddy.exe'),
    onChange: snapshot => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('together:snapshot', snapshot); } });
  try { await controller.init(); } catch (e) { dialog.showErrorBox('Together Lite 未能打开', `无法读取软件设置：${e.message}`); app.exit(1); }
  mainWindow = new BrowserWindow({ width: 1280, height: 870, minWidth: 950, minHeight: 650,
    title: 'Together Lite · 今晚一起看', backgroundColor: '#f6f5ef', autoHideMenuBar: true, show: false,
    icon: path.join(root, 'desktop/assets/icon.ico'),
    webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (url.split(/[?#]/)[0] !== homeUrl) event.preventDefault(); });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', async event => {
    if (!quitting && controller.service?.rooms.size) {
      event.preventDefault(); if (closePrompt) return; closePrompt = true;
      const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: '结束观影并退出？',
        message: '退出软件会停止观影服务，朋友也会离开房间。', buttons: ['退出软件', '继续观看'], defaultId: 1, cancelId: 1 });
      closePrompt = false; if (answer.response === 0) app.quit();
    }
  });
  mainWindow.on('closed', () => { mainWindow = undefined; });
  const trusted = event => event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.split(/[?#]/)[0] === homeUrl;
  function handle(name, callback, serial = true) {
    ipcMain.handle(`together:${name}`, async (event, ...args) => {
      if (!trusted(event)) throw new Error('这个页面没有本机管理权限。');
      const task = () => callback(...args);
      try { return await (serial ? controller.run(task) : task()); }
      catch (e) { throw new Error(e.message || '操作未完成，请重试。'); }
    });
  }
  async function openRoom(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('房间编号无效。');
    const url = await controller.openRoom(id);
    const cookie = controller.cookie.slice('together_session='.length);
    await session.defaultSession.cookies.set({ url: controller.origin, name: 'together_session', value: cookie, httpOnly: true, sameSite: 'strict', path: '/' });
    const existing = roomWindows.get(id);
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
    const win = new BrowserWindow({ width: 1320, height: 930, minWidth: 850, minHeight: 600, title: 'Together Lite · 观影室',
      backgroundColor: '#121b18', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    roomWindows.set(id, win);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== controller.origin) event.preventDefault(); });
    win.webContents.on('did-navigate-in-page', (_event, target) => {
      if (new URL(target).pathname === '/host' || new URL(target).pathname === '/') { win.close(); mainWindow?.show(); mainWindow?.focus(); }
    });
    win.on('closed', () => { roomWindows.delete(id); controller.changed(); });
    await win.loadURL(url);
  }
  handle('snapshot', () => controller.snapshot(), false);
  handle('start', () => controller.start());
  handle('stop', async () => {
    if (controller.service?.rooms.size) {
      const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: '停止观影服务？',
        message: '停止后，正在开放的房间会结束。', buttons: ['停止服务', '继续观看'], defaultId: 1, cancelId: 1 });
      if (answer.response !== 0) return controller.snapshot();
    }
    for (const win of roomWindows.values()) win.close(); return controller.stop();
  });
  handle('settings', input => controller.updateSettings(input));
  handle('pick-files', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择今晚的影片', buttonLabel: '添加影片',
      filters: [{ name: 'MP4 影片', extensions: ['mp4'] }], properties: ['openFile', 'multiSelections'] });
    return result.canceled ? controller.snapshot() : controller.addFiles(result.filePaths);
  });
  handle('import-files', paths => controller.addFiles(paths));
  handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择影片文件夹', buttonLabel: '添加文件夹', properties: ['openDirectory'] });
    return result.canceled ? controller.snapshot() : controller.addDirectory(result.filePaths[0]);
  });
  handle('remove-directory', directory => controller.removeDirectory(directory));
  handle('remove-media', id => controller.removeMedia(id));
  handle('subtitle', async id => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择这部影片的字幕', buttonLabel: '添加字幕',
      filters: [{ name: 'WebVTT 字幕', extensions: ['vtt'] }], properties: ['openFile'] });
    return result.canceled ? controller.snapshot() : controller.attachSubtitle(id, result.filePaths[0]);
  });
  handle('scan', () => controller.scan());
  handle('create-room', (mediaId, name) => controller.createRoom(mediaId, name));
  handle('open-room', id => openRoom(id));
  handle('invite', (id, origin, renew) => controller.roomInvite(id, origin, renew));
  handle('copy-invite', async (id, origin) => { clipboard.writeText(await controller.roomInvite(id, origin)); return true; });
  handle('end-room', async id => { await controller.endRoom(id); roomWindows.get(id)?.close(); return controller.snapshot(); });
  handle('diagnose', () => controller.diagnose(), false);
  await mainWindow.loadFile(homeFile);
  if (controller.prefs.autoStart && process.env.TOGETHER_AUTOSTART !== '0') controller.run(() => controller.start()).catch(() => {});
  const refresh = setInterval(() => controller.changed(), 3000); refresh.unref();
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault(); quitting = true; clearInterval(refresh);
    controller.run(() => controller.stop()).finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
}).catch(error => { console.error('Together Lite desktop:', error); dialog.showErrorBox('软件未能打开', error.message); app.exit(1); });
