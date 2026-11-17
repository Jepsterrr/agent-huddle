const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  onState: (fn) => ipcRenderer.on('state', (_e, state) => fn(state)),
  onShown: (fn) => ipcRenderer.on('shown', () => fn()),
  ready: () => ipcRenderer.send('ready'),
  setHit: (hit) => ipcRenderer.send('hit', !!hit),
  answer: (pendingId, resp) => ipcRenderer.send('answer', pendingId, resp),
  keyboard: (want) => ipcRenderer.send('keyboard', !!want),
  focus: (sessionId) => ipcRenderer.send('focus', sessionId),
  dismiss: (sessionId) => ipcRenderer.send('dismiss', sessionId),
  hide: () => ipcRenderer.send('hide'),
  set: (key, value) => ipcRenderer.send('set-setting', key, !!value),
  settingsOpen: (open) => ipcRenderer.send('settings-open', !!open),
  onOpenSettings: (fn) => ipcRenderer.on('open-settings', () => fn()),
  resetPosition: () => ipcRenderer.send('reset-position'),
  quit: () => ipcRenderer.send('quit'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
