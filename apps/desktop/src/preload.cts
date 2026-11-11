import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deskai', Object.freeze({
  getRuntime: () => ipcRenderer.invoke('deskai:runtime'),
  getHostSnapshot: () => ipcRenderer.invoke('deskai:host-snapshot'),
  selectHost: (selection: unknown) => ipcRenderer.invoke('deskai:host-select', selection),
  workCommand: (command: unknown) => ipcRenderer.invoke('deskai:work-command', command),
  workDiff: (attemptId: string) => ipcRenderer.invoke('deskai:work-diff', attemptId),
  openArtifact: (id: string, interact: boolean) => ipcRenderer.invoke('deskai:artifact-open', id, interact),
  exportArtifact: (id: string) => ipcRenderer.invoke('deskai:artifact-export', id),
  appAction: (input: unknown) => ipcRenderer.invoke('deskai:app-action', input),
  closeApp: (id: string) => ipcRenderer.invoke('deskai:app-close', id),
  onHostSnapshot: (callback: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('deskai:host-snapshot', listener);
    return () => ipcRenderer.removeListener('deskai:host-snapshot', listener);
  },
  openWork: () => ipcRenderer.invoke('deskai:work-open'),
  getWorkStatus: () => ipcRenderer.invoke('deskai:work-status'),
  onWorkStatus: (callback: (status: unknown) => void) => {
    const listener = (_: unknown, status: unknown) => callback(status);
    ipcRenderer.on('deskai:work-status', listener);
    return () => ipcRenderer.removeListener('deskai:work-status', listener);
  },
  startSession: () => ipcRenderer.invoke('deskai:start'),
  openConversation: () => ipcRenderer.invoke('deskai:open-conversation'),
  sendText: (input: unknown) => ipcRenderer.invoke('deskai:send-text', input),
  updatePreferences: (preferences: unknown) => ipcRenderer.invoke('deskai:preferences', preferences),
  getPetSnapshot: () => ipcRenderer.invoke('deskai:pet-snapshot'),
  updatePetPreferences: (preferences: unknown) => ipcRenderer.invoke('deskai:pet-preferences', preferences),
  onPetSnapshot: (callback: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('deskai:pet-snapshot', listener);
    return () => ipcRenderer.removeListener('deskai:pet-snapshot', listener);
  },
  cancelTurn: () => ipcRenderer.invoke('deskai:cancel-turn'),
  retryTurn: () => ipcRenderer.invoke('deskai:retry-turn'),
  acknowledgeDisplay: (report: unknown) => ipcRenderer.send('deskai:displayed', report),
  finishDialogueSmoke: (report: unknown) => ipcRenderer.send('deskai:finish-dialogue-smoke', report),
  stopSession: () => ipcRenderer.invoke('deskai:stop'),
  pauseCapture: () => ipcRenderer.invoke('deskai:pause-capture'),
  retrySpeech: () => ipcRenderer.invoke('deskai:retry-speech'),
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
