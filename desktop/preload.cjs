const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (method, ...args) => ipcRenderer.invoke(`together:${method}`, ...args);
contextBridge.exposeInMainWorld('togetherDesktop', {
  snapshot: () => invoke('snapshot'), start: () => invoke('start'), stop: () => invoke('stop'),
  settings: value => invoke('settings', value), pickFiles: () => invoke('pick-files'),
  importFiles: files => invoke('import-files', Array.from(files).map(file => webUtils.getPathForFile(file))),
  pickDirectory: () => invoke('pick-directory'), removeDirectory: directory => invoke('remove-directory', directory),
  removeMedia: id => invoke('remove-media', id), subtitle: id => invoke('subtitle', id), scan: () => invoke('scan'),
  createRoom: (id, name) => invoke('create-room', id, name), openRoom: id => invoke('open-room', id),
  invite: (id, origin, renew) => invoke('invite', id, origin, renew), copyInvite: (id, origin) => invoke('copy-invite', id, origin),
  endRoom: id => invoke('end-room', id), diagnose: () => invoke('diagnose'),
  onSnapshot: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('together:snapshot', listener);
    return () => ipcRenderer.removeListener('together:snapshot', listener); },
});
