import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deskPet', Object.freeze({
  getSnapshot: () => ipcRenderer.invoke('pet:get-snapshot'),
  onSnapshot: (callback: (snapshot: unknown) => void) => {
    const listener = (_: unknown, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on('pet:snapshot', listener);
    return () => ipcRenderer.removeListener('pet:snapshot', listener);
  },
  onMouth: (callback: (frame: unknown) => void) => {
    const listener = (_: unknown, frame: unknown) => callback(frame);
    ipcRenderer.on('pet:mouth', listener);
    return () => ipcRenderer.removeListener('pet:mouth', listener);
  },
  setOpaqueHit: (opaque: boolean) => ipcRenderer.send('pet:opaque-hit', opaque),
  drag: (phase: 'start' | 'move' | 'end', pointerId: number) => ipcRenderer.send('pet:drag', phase, pointerId),
  showContextMenu: () => ipcRenderer.send('pet:context-menu'),
  reportGeometry: (geometry: unknown) => ipcRenderer.send('pet:geometry', geometry),
}));
