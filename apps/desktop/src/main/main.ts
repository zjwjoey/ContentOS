import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { DesktopRuntimeManager } from './runtime-manager.js';
import type { DesktopRuntimeSnapshot } from '../../../../packages/desktop-contract/src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const isPackaged = app.isPackaged || process.env.CONTENTOS_DESKTOP_MODE === 'PACKAGED';
const appRoot = isPackaged ? app.getAppPath() : resolve(currentDir, '../../../../../');
const configuredUserDataRoot = process.env.CONTENTOS_USER_DATA_ROOT?.trim();
if (configuredUserDataRoot) app.setPath('userData', configuredUserDataRoot);
const userDataRoot = configuredUserDataRoot || app.getPath('userData');
const databasePassword = createHash('sha256').update(userDataRoot).digest('hex').slice(0, 32);
const resourcesRoot = process.env.CONTENTOS_RESOURCES_ROOT || (isPackaged ? resolve(process.resourcesPath, 'resources') : resolve(appRoot, 'apps', 'desktop', 'resources'));
const bundledFfmpegPath = resolve(resourcesRoot, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const bundledFfprobePath = resolve(resourcesRoot, 'ffmpeg', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const resourceManifest = (() => { try { const value: unknown = JSON.parse(readFileSync(resolve(resourcesRoot, 'runtime-manifest.json'), 'utf8')); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; } catch { return {}; } })();
const manifestValue = (section: string, key: string): string | undefined => { const value = resourceManifest[section]; if (!value || typeof value !== 'object') return undefined; const item = (value as Record<string, unknown>)[key]; return typeof item === 'string' && item.trim() ? item : undefined; };
const manifestString = (key: string): string | undefined => { const value = resourceManifest[key]; return typeof value === 'string' && value.trim() ? value : undefined; };
const env: Record<string, string | undefined> = {
  ...process.env,
  CONTENTOS_APP_ROOT: appRoot,
  CONTENTOS_RUNTIME_MODE: isPackaged ? 'PACKAGED' : 'DEVELOPMENT',
  CONTENTOS_ELECTRON_RUNTIME: '1',
  CONTENTOS_USER_DATA_ROOT: userDataRoot,
  CONTENTOS_RUNTIME_ROOT: process.env.CONTENTOS_RUNTIME_ROOT || resolve(userDataRoot, 'runtime'),
  CONTENTOS_CONFIG_ROOT: process.env.CONTENTOS_CONFIG_ROOT || resolve(userDataRoot, 'config'),
  CONTENTOS_DATABASE_ROOT: process.env.CONTENTOS_DATABASE_ROOT || resolve(userDataRoot, 'data', 'postgres'),
  CONTENTOS_CACHE_ROOT: process.env.CONTENTOS_CACHE_ROOT || resolve(userDataRoot, 'cache'),
  CONTENTOS_TEMP_ROOT: process.env.CONTENTOS_TEMP_ROOT || resolve(userDataRoot, 'temp'),
  CONTENTOS_LOGS_ROOT: process.env.CONTENTOS_LOGS_ROOT || resolve(userDataRoot, 'logs'),
  CONTENTOS_RESOURCES_ROOT: resourcesRoot,
  STORAGE_ROOT: process.env.STORAGE_ROOT || resolve(userDataRoot, 'storage'),
  CONTENTOS_DATABASE_MODE: isPackaged ? 'EMBEDDED' : (process.env.CONTENTOS_DATABASE_MODE || 'EXTERNAL'),
  CONTENTOS_DATABASE_USER: 'contentos',
  CONTENTOS_DATABASE_PASSWORD: databasePassword,
  CONTENTOS_DATABASE_NAME: 'contentos',
  CONTENTOS_RUNTIME_VERSION: process.env.CONTENTOS_RUNTIME_VERSION || app.getVersion(),
  CONTENTOS_COMMIT_SHA: process.env.CONTENTOS_COMMIT_SHA || manifestString('commitSha'),
  CONTENTOS_BUILD_TIMESTAMP: process.env.CONTENTOS_BUILD_TIMESTAMP || manifestString('generatedAt'),
  CONTENTOS_FFMPEG_VERSION: process.env.CONTENTOS_FFMPEG_VERSION || manifestValue('ffmpeg', 'version'),
  CONTENTOS_POSTGRES_VERSION: process.env.CONTENTOS_POSTGRES_VERSION || manifestValue('postgres', 'version'),
  FFMPEG_PATH: isPackaged ? bundledFfmpegPath : (process.env.FFMPEG_PATH || (process.platform === 'win32' ? resolve(appRoot, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe') : 'ffmpeg')),
  FFPROBE_PATH: isPackaged ? bundledFfprobePath : (process.env.FFPROBE_PATH || (process.platform === 'win32' ? resolve(appRoot, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe') : 'ffprobe')),
};
const runtime = new DesktopRuntimeManager(env);
let windowRef: BrowserWindow | undefined;

function registerIpc(): void {
  ipcMain.handle('desktop:runtime:snapshot', () => runtime.snapshot());
  ipcMain.handle('desktop:runtime:start', (_event, options: { safeMode?: boolean }) => runtime.start({ safeMode: options?.safeMode === true }));
  ipcMain.handle('desktop:runtime:stop', () => runtime.stop());
  ipcMain.handle('desktop:runtime:restart', (_event, options: { safeMode?: boolean }) => runtime.restart(options));
  ipcMain.handle('desktop:runtime:restart-service', (_event, serviceId: string) => { if (typeof serviceId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(serviceId)) throw new Error('INVALID_SERVICE_ID'); return runtime.restartService(serviceId); });
  ipcMain.handle('desktop:runtime:doctor', () => runtime.doctor());
  ipcMain.handle('desktop:runtime:logs', (_event, query: { serviceId?: string; limit?: number }) => { const serviceId = query?.serviceId; const limit = query?.limit; if (serviceId !== undefined && (typeof serviceId !== 'string' || !/^[a-z0-9-]{1,80}$/u.test(serviceId))) throw new Error('INVALID_SERVICE_ID'); if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error('INVALID_LOG_LIMIT'); return runtime.logs({ ...(serviceId === undefined ? {} : { serviceId }), ...(limit === undefined ? {} : { limit }) }); });
  runtime.on('status', (snapshot: DesktopRuntimeSnapshot) => windowRef?.webContents.send('desktop:runtime:status', snapshot));
}

async function createWindow(): Promise<void> {
  windowRef = new BrowserWindow({ width: 1440, height: 900, minWidth: 1024, minHeight: 700, show: false, webPreferences: { preload: resolve(currentDir, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windowRef.webContents.setWindowOpenHandler(({ url }) => { try { const target = new URL(url); if (target.protocol === 'http:' || target.protocol === 'https:') { const local = target.hostname === '127.0.0.1' || target.hostname === 'localhost'; if (!local) void shell.openExternal(target.toString()); } } catch { /* deny malformed or unsupported URLs */ } return { action: 'deny' }; });
  await windowRef.loadFile(resolve(currentDir, '../renderer/startup.html'));
  windowRef.once('ready-to-show', () => windowRef?.show());
  const start = await runtime.start();
  if (start.ok) await windowRef.loadURL(runtime.webUrl()); else await windowRef.loadFile(resolve(currentDir, '../renderer/failure.html'));
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
