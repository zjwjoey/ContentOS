import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';

const execFileAsync = promisify(execFile);
type RuntimeState = { state: string; controlPort: number; controlToken: string };
type RuntimeService = { id: string; state: string; port?: number; required?: boolean; capability?: Record<string, unknown> };
type RuntimeStatus = { state: string; services: RuntimeService[]; databaseMode?: string; launchMode?: string; postgresVersion?: string; ffmpegVersion?: string; runtimeVersion?: string };
type ApiJob = { id: string; state: string; result?: Record<string, unknown> | null; error?: Record<string, unknown> | null };
type AcceptanceResult = { projectId: string; sourceAssetId: string; firstOutputAssetId: string; secondOutputAssetId: string; apiPort: number; webPort: number; controlPort: number; databasePort: number; postgresVersion?: string; ffmpegVersion?: string; outputBytes: number; outputDuration: string };

if (process.platform !== 'win32') throw new Error('clean Windows acceptance requires win32-x64');

const root = await mkdtemp(join(tmpdir(), 'contentos-desktop-clean-acceptance-'));
const installRoot = join(root, 'install');
const userDataRoot = join(root, 'user-data');
const installer = resolve(process.env.CONTENTOS_ACCEPTANCE_INSTALLER || 'artifacts/desktop/ContentOS Setup.exe');
const systemRoot = process.env.SystemRoot || 'C:\\Windows';
const systemPath = `${join(systemRoot, 'System32')};${systemRoot}`;
const statePath = join(userDataRoot, 'runtime', 'state', 'runtime.json');
const postgresDataRoot = join(userDataRoot, 'data', 'postgres');
const keepRoot = process.env.CONTENTOS_KEEP_ACCEPTANCE_ROOT === '1';
const projectName = `Clean Windows acceptance ${randomUUID()}`;
let appProcess: ChildProcess | undefined;
let appStdout = '';
let appStderr = '';
let installedExecutable = '';

function cleanRuntimeEnv(): NodeJS.ProcessEnv {
  const externalKeys = /^(DATABASE_URL|CONTENTOS_OPERATOR_DATABASE_URL|CONTENTOS_TEST_DATABASE_URL|CONTENTOS_TEST_ADMIN_DATABASE_URL|FFMPEG_PATH|FFPROBE_PATH|PG|NODE_PATH|QWEN_|PEXELS_|CONTENTOS_HZAGENT_)/u;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !externalKeys.test(key))) as NodeJS.ProcessEnv;
  env.PATH = systemPath;
  env.Path = systemPath;
  env.CONTENTOS_USER_DATA_ROOT = userDataRoot;
  env.CONTENTOS_DATABASE_MODE = 'EMBEDDED';
  return env;
}

async function findFile(directory: string, fileName: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function waitFor<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function readState(): Promise<RuntimeState | undefined> {
  try { return JSON.parse(await readFile(statePath, 'utf8')) as RuntimeState; } catch { return undefined; }
}

async function controlStatus(state: RuntimeState): Promise<RuntimeStatus> {
  const response = await fetch(`http://127.0.0.1:${state.controlPort}/runtime/status`);
  if (!response.ok) throw new Error(`Runtime status returned HTTP ${response.status}`);
  return await response.json() as RuntimeStatus;
}

async function apiRequest<T>(port: number, path: string, init: RequestInit = {}): Promise<{ response: Response; body: T }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const body = await response.json().catch(() => ({})) as T;
  return { response, body };
}

async function install(): Promise<void> {
  await access(installer);
  await mkdir(installRoot, { recursive: true });
  await execFileAsync(installer, ['/S', `/D=${installRoot}`], { windowsHide: true, timeout: 300_000 });
  installedExecutable = await findFile(installRoot, 'ContentOS.exe') || '';
  if (!installedExecutable) throw new Error(`Installed ContentOS.exe was not found below ${installRoot}`);
}

async function startApp(): Promise<{ state: RuntimeState; status: RuntimeStatus }> {
  appStdout = '';
  appStderr = '';
  appProcess = spawn(installedExecutable, [`--user-data-dir=${userDataRoot}`], { cwd: installRoot, env: cleanRuntimeEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  appProcess.stdout?.on('data', (chunk: Buffer) => { appStdout += chunk.toString(); });
  appProcess.stderr?.on('data', (chunk: Buffer) => { appStderr += chunk.toString(); });
  const running = await waitFor(async () => {
    const state = await readState();
    if (!state) return undefined;
    try { return { state, status: await controlStatus(state) }; } catch { return undefined; }
  }, (value) => value.state.state === 'READY' || value.state.state === 'READY_WITH_WARNINGS', 300_000, 'packaged runtime readiness');
  const { state, status } = running;
  const required = ['database', 'migration', 'api', 'asset-worker', 'video-worker', 'web'];
  for (const serviceId of required) if (status.services.find((service) => service.id === serviceId)?.state !== 'READY') throw new Error(`Required service is not READY: ${serviceId}`);
  const intelligence = status.services.find((service) => service.id === 'media-intelligence-worker');
  if (!intelligence || intelligence.required !== false) throw new Error('Media Intelligence Worker must be registered as an optional Desktop service');
  if (intelligence.state !== 'READY') throw new Error(`Media Intelligence Worker did not start: ${intelligence.state}`);
  return { state, status };
}

async function stopApp(): Promise<void> {
  const state = await readState();
  if (state) await fetch(`http://127.0.0.1:${state.controlPort}/runtime/stop`, { method: 'POST', headers: { authorization: `Bearer ${state.controlToken}` } }).catch(() => undefined);
  await waitFor(readState, (value) => value.state === 'STOPPED', 30_000, 'runtime stop').catch(() => undefined);
  const child = appProcess;
  if (child?.pid && child.exitCode === null) {
    await execFileAsync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => undefined);
  }
  appProcess = undefined;
}

async function crashApp(): Promise<void> {
  const child = appProcess;
  if (!child?.pid) throw new Error('Cannot simulate crash without an app process');
  await execFileAsync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }).catch(() => undefined);
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));
  appProcess = undefined;
}

async function occupyPort(port: number): Promise<Server | undefined> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, rejectListen) => { server.once('error', rejectListen); server.listen(port, '127.0.0.1', () => resolveListen()); });
    return server;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error;
    return undefined;
  }
}

async function waitForJob(port: number, jobId: string): Promise<ApiJob> {
  return waitFor(async () => (await apiRequest<ApiJob>(port, `/api/v1/jobs/${encodeURIComponent(jobId)}`)).body, (job) => ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.state), 300_000, `job ${jobId} completion`).then((job) => {
    if (job.state !== 'SUCCEEDED') throw new Error(`Job ${jobId} ended in ${job.state}: ${JSON.stringify(job.error)}`);
    return job;
  });
}

async function assertProjectAndAssets(port: number, projectId: string, sourceAssetId: string): Promise<void> {
  const project = await apiRequest<Record<string, unknown>>(port, `/api/v1/projects/${encodeURIComponent(projectId)}`);
  if (!project.response.ok || project.body.id !== projectId) throw new Error('Project did not persist after restart');
  const assets = await apiRequest<{ items?: Array<{ id: string; lifecycle: string }> }>(port, `/api/v1/projects/${encodeURIComponent(projectId)}/assets`);
  if (!assets.response.ok || !assets.body.items?.some((asset) => asset.id === sourceAssetId && asset.lifecycle === 'READY')) throw new Error('Imported source asset did not persist after restart');
}

async function createAndRender(port: number, projectId: string, sourceAssetId: string, seed: number): Promise<{ projectId: string; outputAssetId: string; outputBytes: number; outputDuration: string }> {
  const plan = await apiRequest<{ revision?: number }>(port, `/api/v1/projects/${projectId}/director-plans`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seed, brief: { topic: 'Clean Windows acceptance', audience: 'operator', objective: 'render a real imported video', tone: 'clear' }, storyboard: [{ id: `scene-${seed}`, title: 'Acceptance scene', narration: 'Acceptance render', visualIntent: 'solid color video', durationMs: 2000, sourceAssetIds: [sourceAssetId] }], provenance: { author: 'clean-acceptance', source: 'manual' } }) });
  if (plan.response.status !== 201 || plan.body.revision === undefined) throw new Error(`Director plan creation failed: ${JSON.stringify(plan.body)}`);
  for (const action of ['accept', 'approve']) {
    const result = await apiRequest<Record<string, unknown>>(port, `/api/v1/projects/${projectId}/director-plans/${plan.body.revision}/${action}`, { method: 'POST' });
    if (!result.response.ok) throw new Error(`Director plan ${action} failed: ${JSON.stringify(result.body)}`);
  }
  const render = await apiRequest<{ id?: string }>(port, `/api/v1/projects/${projectId}/video/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ videoAssetIds: [sourceAssetId], targetDurationMs: 2000, seed, plannerType: 'RANDOM' }) });
  if (render.response.status !== 201 || !render.body.id) throw new Error(`Render job creation failed: ${JSON.stringify(render.body)}`);
  const job = await waitForJob(port, render.body.id);
  const outputAssetId = typeof job.result?.outputAssetId === 'string' ? job.result.outputAssetId : '';
  if (!outputAssetId) throw new Error(`Render job did not return output asset: ${JSON.stringify(job.result)}`);
  const content = await fetch(`http://127.0.0.1:${port}/api/v1/projects/${projectId}/assets/${encodeURIComponent(outputAssetId)}/content`);
  if (!content.ok) throw new Error(`Rendered asset content returned HTTP ${content.status}`);
  const outputPath = join(root, `render-${seed}.mp4`);
  await writeFile(outputPath, Buffer.from(await content.arrayBuffer()));
  const outputBytes = (await stat(outputPath)).size;
  if (outputBytes <= 0) throw new Error('Rendered MP4 is empty');
  const ffprobe = await findFile(installRoot, 'ffprobe.exe');
  if (!ffprobe) throw new Error('Bundled ffprobe.exe was not found in installed resources');
  const probe = await execFileAsync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath], { env: cleanRuntimeEnv(), windowsHide: true, timeout: 30_000 });
  const outputDuration = String(probe.stdout).trim();
  if (!outputDuration || Number(outputDuration) <= 0) throw new Error(`Bundled ffprobe rejected rendered MP4: ${outputDuration}`);
  return { projectId, outputAssetId, outputBytes, outputDuration };
}

async function processIds(imageName: string): Promise<Set<string>> {
  const result = await execFileAsync(join(systemRoot, 'System32', 'tasklist.exe'), ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
  const ids = new Set<string>();
  for (const line of String(result.stdout).split(/\r?\n/u)) {
    const fields = line.trim().replace(/^"|"$/gu, '').split('","');
    if (fields[0]?.toLowerCase() === imageName.toLowerCase() && fields[1]) ids.add(fields[1]);
  }
  return ids;
}

async function clusterCount(): Promise<number> {
  let count = 0;
  const dataRoot = join(userDataRoot, 'data');
  for (const entry of await readdir(dataRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(dataRoot, entry.name, 'PG_VERSION'));
      count += 1;
    } catch {
      // PostgreSQL also stores internal relation files named PG_VERSION under
      // base/*; only a direct child cluster directory counts here.
    }
  }
  return count;
}

async function waitForNoNewProcesses(baselineContentOs: Set<string>, baselinePostgres: Set<string>, timeoutMs = 30_000): Promise<{ contentOs: string[]; postgres: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let contentOs: string[] = [];
  let postgres: string[] = [];
  while (Date.now() < deadline) {
    const currentContentOs = await processIds('ContentOS.exe');
    const currentPostgres = await processIds('postgres.exe');
    contentOs = [...currentContentOs].filter((pid) => !baselineContentOs.has(pid));
    postgres = [...currentPostgres].filter((pid) => !baselinePostgres.has(pid));
    if (contentOs.length === 0 && postgres.length === 0) return { contentOs, postgres };
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return { contentOs, postgres };
}

let result: AcceptanceResult | undefined;
const baselineContentOs = await processIds('ContentOS.exe');
const baselinePostgres = await processIds('postgres.exe');
try {
  await install();
  const blockedPorts = await Promise.all([3000, 3001, 3099, 55433].map((port) => occupyPort(port)));
  let running = await startApp();
  const servicePorts = Object.fromEntries(running.status.services.filter((service) => service.port).map((service) => [service.id, service.port]));
  for (const port of [servicePorts.api, servicePorts.web, running.state.controlPort, servicePorts.database]) if ([3000, 3001, 3099, 55433].includes(Number(port))) throw new Error(`Port conflict was not recovered: ${port}`);
  for (const server of blockedPorts) server?.close();
  const apiPort = Number(servicePorts.api);
  const ffmpeg = await findFile(installRoot, 'ffmpeg.exe');
  if (!ffmpeg) throw new Error('Bundled ffmpeg.exe was not found in installed resources');
  const sourcePath = join(root, 'source.mp4');
  await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath], { env: cleanRuntimeEnv(), windowsHide: true, timeout: 60_000 });
  const project = await apiRequest<{ id?: string }>(apiPort, '/api/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: projectName }) });
  if (project.response.status !== 201 || !project.body.id) throw new Error(`Project creation failed: ${JSON.stringify(project.body)}`);
  const form = new FormData();
  form.append('file', new Blob([await readFile(sourcePath)], { type: 'video/mp4' }), 'acceptance-source.mp4');
  const upload = await apiRequest<{ import?: { id?: string } }>(apiPort, `/api/v1/projects/${project.body.id}/asset-imports`, { method: 'POST', body: form });
  if (upload.response.status !== 202 || !upload.body.import?.id) throw new Error(`Video import failed: ${JSON.stringify(upload.body)}`);
  const imported = await waitFor(async () => (await apiRequest<{ items?: Array<{ id: string; state: string; outputAssetId?: string }> }>(apiPort, `/api/v1/projects/${project.body.id}/asset-imports`)).body.items?.find((item) => item.id === upload.body.import?.id), (item) => item.state === 'READY' && Boolean(item.outputAssetId), 180_000, 'video import');
  const sourceAssetId = imported.outputAssetId!;
  const first = await createAndRender(apiPort, project.body.id, sourceAssetId, 1);
  await crashApp();
  running = await startApp();
  await assertProjectAndAssets(Number(running.status.services.find((service) => service.id === 'api')?.port), first.projectId, sourceAssetId);
  const second = await createAndRender(Number(running.status.services.find((service) => service.id === 'api')?.port), first.projectId, sourceAssetId, 2);
  const pgVersion = await readFile(join(postgresDataRoot, 'PG_VERSION'), 'utf8');
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await stopApp();
    running = await startApp();
    await assertProjectAndAssets(Number(running.status.services.find((service) => service.id === 'api')?.port), first.projectId, sourceAssetId);
    if ((await readFile(join(postgresDataRoot, 'PG_VERSION'), 'utf8')) !== pgVersion) throw new Error('PostgreSQL cluster version changed across restart');
  }
  await stopApp();
  const { contentOs: newContentOs, postgres: newPostgres } = await waitForNoNewProcesses(baselineContentOs, baselinePostgres);
  if (newContentOs.length > 0 || newPostgres.length > 0) throw new Error(`Orphan processes remain: ContentOS.exe=${newContentOs.join(',') || 'none'}, postgres.exe=${newPostgres.join(',') || 'none'}`);
  if (await clusterCount() !== 1) throw new Error(`Expected one PostgreSQL cluster, found ${await clusterCount()}`);
  result = { projectId: first.projectId, sourceAssetId, firstOutputAssetId: first.outputAssetId, secondOutputAssetId: second.outputAssetId, apiPort: Number(servicePorts.api), webPort: Number(servicePorts.web), controlPort: running.state.controlPort, databasePort: Number(servicePorts.database), ...(running.status.postgresVersion ? { postgresVersion: running.status.postgresVersion } : {}), ...(running.status.ffmpegVersion ? { ffmpegVersion: running.status.ffmpegVersion } : {}), outputBytes: second.outputBytes, outputDuration: second.outputDuration };
  console.log(JSON.stringify({ ok: true, acceptance: result }));
} finally {
  await stopApp().catch(() => undefined);
  if (appProcess?.pid) await execFileAsync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(appProcess.pid), '/T', '/F'], { windowsHide: true }).catch(() => undefined);
  if (appStdout || appStderr) console.error(JSON.stringify({ appStdout: appStdout.slice(-4000), appStderr: appStderr.slice(-4000) }));
  if (keepRoot) console.error(`clean acceptance root preserved at ${root}`);
  else await rm(root, { recursive: true, force: true });
}
