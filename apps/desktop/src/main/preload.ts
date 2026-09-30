import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, DesktopRuntimeResult, DesktopRuntimeSnapshot } from '../../../../packages/desktop-contract/src/index.js';

const api: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('desktop:runtime:snapshot') as Promise<DesktopRuntimeSnapshot>,
  start: (options = {}) => ipcRenderer.invoke('desktop:runtime:start', options) as Promise<DesktopRuntimeResult>,
  stop: () => ipcRenderer.invoke('desktop:runtime:stop') as Promise<DesktopRuntimeResult>,
  restart: (options = {}) => ipcRenderer.invoke('desktop:runtime:restart', options) as Promise<DesktopRuntimeResult>,
  restartService: (serviceId) => ipcRenderer.invoke('desktop:runtime:restart-service', serviceId) as Promise<DesktopRuntimeResult>,
  doctor: () => ipcRenderer.invoke('desktop:runtime:doctor') as Promise<DesktopRuntimeResult>,
  logs: (query = {}) => ipcRenderer.invoke('desktop:runtime:logs', query) as Promise<DesktopRuntimeResult>,
  onStatus: (listener) => { const callback = (_event: Electron.IpcRendererEvent, snapshot: DesktopRuntimeSnapshot) => listener(snapshot); ipcRenderer.on('desktop:runtime:status', callback); return () => ipcRenderer.removeListener('desktop:runtime:status', callback); },
};
contextBridge.exposeInMainWorld('contentosDesktop', api);
