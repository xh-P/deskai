const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioM0', Object.freeze({
  getRuntime: () => ipcRenderer.invoke('audio-m0:get-runtime'),
  saveReport: (report) => ipcRenderer.invoke('audio-m0:save-report', report),
  finishSmoke: (payload) => ipcRenderer.invoke('audio-m0:finish-smoke', payload)
}));
