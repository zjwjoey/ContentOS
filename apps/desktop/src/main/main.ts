import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DesktopRuntimeManager } from './runtime-manager.js';
import type { DesktopRuntimeSnapshot } from '../../../../packages/desktop-contract/src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged || process.env.CONTENTOS_DESKTOP_MODE === 'PACKAGED';
const appRoot = isPackaged ? app.getAppPath() : resolve(currentDir, '../../../../../');
const env: Record<string, string | undefined> = { ...process.env, CONTENTOS_APP_ROOT: appRoot, CONTENTOS_RUNTIME_MODE: isPackaged ? 'PACKAGED' : 'DEVELOPMENT', CONTENTOS_ELECTRON_RUNTIME: '1', CONTENTOS_RUNTIME_ROOT: process.env.CONTENTOS_RUNTIME_ROOT || resolve(app.getPath('userData'), 'runtime'), CONTENTOS_CONFIG_ROOT: process.env.CONTENTOS_CONFIG_ROOT || resolve(app.getPath('userData'), 'config'), STORAGE_ROOT: process.env.STORAGE_ROOT || resolve(app.getPath('userData'), 'storage', 'local') };
const runtime = new DesktopRuntimeManager(env);
let windowRef: BrowserWindow | undefined;

function registerIpc(): void {
  ipcMain.handle('desktop:runtime:snapshot', () => runtime.snapshot());
  ipcMain.handle('desktop:runtime:start', (_event, options: { safeMode?: boolean }) => runtime.start(options));
  ipcMain.handle('desktop:runtime:stop', () => runtime.stop());
  ipcMain.handle('desktop:runtime:restart', (_event, options: { safeMode?: boolean }) => runtime.restart(options));
  ipcMain.handle('desktop:runtime:restart-service', (_event, serviceId: string) => runtime.restartService(serviceId));
  ipcMain.handle('desktop:runtime:doctor', () => runtime.doctor());
  ipcMain.handle('desktop:runtime:logs', (_event, query: { serviceId?: string; limit?: number }) => runtime.logs(query));
  runtime.on('status', (snapshot: DesktopRuntimeSnapshot) => windowRef?.webContents.send('desktop:runtime:status', snapshot));
}

async function createWindow(): Promise<void> {
  windowRef = new BrowserWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 700, show: false, webPreferences: { preload: resolve(currentDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.webContents.setWindowOpenHandler(({ url }) => { if (url.startsWith('http://127.0.0.1:')) void shell.openExternal(url); return { action: 'deny' }; });
  const start = await runtime.start();
  if (start.ok) await windowRef.loadURL(runtime.webUrl()); else await windowRef.loadFile(resolve(currentDir, '../renderer/failure.html'));
  windowRef.once('ready-to-show', () => windowRef?.show());
  windowRef.on('closed', () => { windowRef = undefined; });
}

const acquired = app.requestSingleInstanceLock();
if (!acquired) app.quit();
else {
  app.on('second-instance', () => { if (windowRef) { if (windowRef.isMinimized()) windowRef.restore(); windowRef.focus(); } });
  app.whenReady().then(async () => { registerIpc(); await createWindow(); });
  app.on('before-quit', (event) => { if (runtime.snapshot().phase !== 'STOPPED') { event.preventDefault(); void runtime.shutdown().finally(() => app.exit(0)); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
