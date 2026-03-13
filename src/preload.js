const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stremini', {
  resize:           (h)     => ipcRenderer.send('resize', { height: h }),
  hide:             ()      => ipcRenderer.send('hide'),
  readClipboard:    ()      => ipcRenderer.invoke('read-clipboard'),
  writeClipboard:   (t)     => ipcRenderer.invoke('write-clipboard', t),
  captureScreen:    ()      => ipcRenderer.invoke('capture-screen'),
  runAutomation:    (task)  => ipcRenderer.invoke('run-automation', { task }),
  stopAutomation:   ()      => ipcRenderer.invoke('stop-automation'),
  securityScan:     (c, t)  => ipcRenderer.invoke('security-scan', { content: c, scanType: t }),

  onShow:           (cb) => ipcRenderer.on('show',            () => cb()),
  onHide:           (cb) => ipcRenderer.on('hide-anim',       () => cb()),
  onAutoStep:       (cb) => ipcRenderer.on('auto-step',       (_, d) => cb(d)),
  onAutoDone:       (cb) => ipcRenderer.on('auto-done',       (_, d) => cb(d)),
  onAutoError:      (cb) => ipcRenderer.on('auto-error',      (_, d) => cb(d)),
  onScreenCaptured: (cb) => ipcRenderer.on('screen-captured', (_, d) => cb(d)),
});
