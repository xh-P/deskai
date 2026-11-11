import { contextBridge, ipcRenderer } from 'electron';

let traceSequence = 0;

contextBridge.exposeInMainWorld('deskai', Object.freeze({
  getRuntime: () => ipcRenderer.invoke('deskai:runtime'),
  getHostSnapshot: () => ipcRenderer.invoke('deskai:host-snapshot'),
  selectHost: (selection: unknown) => ipcRenderer.invoke('deskai:host-select', selection),
  workCommand: (command: unknown) => ipcRenderer.invoke('deskai:work-command', command),
  workDiff: (attemptId: string) => ipcRenderer.invoke('deskai:work-diff', attemptId),
  workTracePage: (taskId: string, before: string) => ipcRenderer.invoke('deskai:work-trace-page', taskId, before),
  watchWorkTrace: (taskId: string, callback: (update: unknown) => void) => {
    const id = ++traceSequence;
    let active = true;
    const listener = (_: unknown, subscription: number, update: unknown) => { if (subscription === id) callback(update); };
    ipcRenderer.on('deskai:work-trace', listener);
    void ipcRenderer.invoke('deskai:work-trace-watch', taskId, id).catch(() => {
      if (active) callback({ type: 'disconnected', taskId });
    });
    return () => {
      active = false;
      ipcRenderer.removeListener('deskai:work-trace', listener);
      void ipcRenderer.invoke('deskai:work-trace-unwatch', id).catch(() => {});
    };
  },
  openArtifact: (id: string, interact: boolean) => ipcRenderer.invoke('deskai:artifact-open', id, interact),
  exportArtifact: (id: string) => ipcRenderer.invoke('deskai:artifact-export', id),
  appAction: (input: unknown) => ipcRenderer.invoke('deskai:app-action', input),
  setAppMode: (id: string, mode: string) => ipcRenderer.invoke('deskai:app-mode', id, mode),
  closeApp: (id: string) => ipcRenderer.invoke('deskai:app-close', id),
  onHostSnapshot: (callback: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('deskai:host-snapshot', listener);
    return () => ipcRenderer.removeListener('deskai:host-snapshot', listener);
  },
  openWork: () => ipcRenderer.invoke('deskai:work-open'),
  startSession: () => ipcRenderer.invoke('deskai:start'),
  openConversation: (id?: string) => ipcRenderer.invoke('deskai:open-conversation', id),
  listConversations: () => ipcRenderer.invoke('deskai:conversations'),
  getCharacter: (id: string) => ipcRenderer.invoke('deskai:character', id),
  saveCharacter: (draft: unknown) => ipcRenderer.invoke('deskai:character-save', draft),
  sendText: (input: unknown) => ipcRenderer.invoke('deskai:send-text', input),
  selectReference: (selection: unknown) => ipcRenderer.invoke('deskai:reference-select', selection),
  dismissReference: (id: string) => ipcRenderer.invoke('deskai:reference-dismiss', id),
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
