import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deskai', Object.freeze({
  getRuntime: () => ipcRenderer.invoke('deskai:runtime'),
  startSession: () => ipcRenderer.invoke('deskai:start'),
  openConversation: () => ipcRenderer.invoke('deskai:open-conversation'),
  sendText: (input: unknown) => ipcRenderer.invoke('deskai:send-text', input),
  updatePreferences: (preferences: unknown) => ipcRenderer.invoke('deskai:preferences', preferences),
  cancelTurn: () => ipcRenderer.invoke('deskai:cancel-turn'),
  retryTurn: () => ipcRenderer.invoke('deskai:retry-turn'),
  acknowledgeDisplay: (report: unknown) => ipcRenderer.send('deskai:displayed', report),
  finishDialogueSmoke: (report: unknown) => ipcRenderer.send('deskai:finish-dialogue-smoke', report),
  stopSession: () => ipcRenderer.invoke('deskai:stop'),
  sendFrame: (frame: unknown) => ipcRenderer.send('deskai:frame', frame),
  playbackState: (state: unknown) => ipcRenderer.send('deskai:playback', state),
  loadPlaybackFixture: () => ipcRenderer.invoke('deskai:playback-fixture'),
  finishSmoke: (report: unknown) => ipcRenderer.send('deskai:finish-smoke', report),
  onEvent: (callback: (event: unknown) => void) => {
    const listener = (_: unknown, event: unknown) => callback(event);
    ipcRenderer.on('deskai:event', listener);
    return () => ipcRenderer.removeListener('deskai:event', listener);
  }
}));
