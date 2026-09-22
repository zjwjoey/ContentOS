import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type APIResponse } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureVideo = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : fixtureVideo ? [fixtureVideo] : [];

async function json<T>(response: APIResponse): Promise<T> { assert.ok(response.ok(), `${response.status()} ${await response.text()}`); return response.json() as Promise<T>; }
async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs; let latest: T | undefined;
  while (Date.now() < deadline) { latest = await read(); if (predicate(latest)) return latest; await new Promise((resolve) => setTimeout(resolve, 500)); }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

test('Production Run browser journey connects Director, Material Pool, V3 Editing, Preview, Approval and Render', async () => {
  assert.ok(baseUrl, 'browser harness must provide CONTENTOS_OPERATOR_URL'); assert.ok(fixtureVideo, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_VIDEO'); assert.ok(fixtureVideos.length >= 3, 'browser harness must provide at least three material fixtures');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const project = await json<{ id: string }>(await page.request.post(`${baseUrl}/api/v1/projects`, { data: { name: `Production browser ${Date.now()}` } }));
    const projectId = project.id;
    const brief = await json<{ id: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/director/brief`, { data: { topic: '浏览器闭环', targetPlatform: '测试平台', channelPositioning: '短视频', targetDurationSeconds: 10, contentType: '产品介绍', audience: '测试用户', coreThesis: '把生产链串起来', tone: '清晰', referenceMaterial: 'browser fixture', mustInclude: ['闭环'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'browser' } }));
    const generation = await json<{ jobId: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/scripts/generate`, { data: { briefId: brief.id, correlationId: `browser-${Date.now()}` } }));
    await waitFor(async () => json<{ state: string }>(await page.request.get(`${baseUrl}/api/v1/jobs/${generation.jobId}`)), (job) => job.state === 'SUCCEEDED', 'Director Script Job');
    const scripts = await waitFor(async () => json<{ items: Array<{ id: string; status: string }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/scripts`)), (value) => value.items.some((item) => item.status === 'DRAFT'), 'Director Script');
    const script = scripts.items.find((item) => item.status === 'DRAFT'); assert.ok(script);
    await json<{ id: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/approvals`, { data: { targetType: 'SCRIPT', targetId: script.id, targetRevisionId: script.id, status: 'PENDING', approver: 'browser', evidence: { source: 'production-browser' } } }));
    await json(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/approvals/SCRIPT/${script.id}/${script.id}/approve`, { data: { approver: 'browser' } }));

    await page.goto(`${baseUrl}/projects/${projectId}/production`, { waitUntil: 'domcontentloaded' }); await page.getByRole('heading', { name: '内容生产编排' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByLabel('运行名称').fill('浏览器闭环运行'); await page.getByRole('button', { name: '创建生产运行' }).click(); await page.getByText('生产运行已创建', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    const runList = await json<{ items: Array<{ id: string; title: string }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/production-runs`)); const run = runList.items.find((item) => item.title === '浏览器闭环运行'); assert.ok(run);
    const handoff = async (stage: string, outputRefs: Record<string, unknown>, status = 'SUCCEEDED') => json<{ steps: Array<{ stage: string; status: string }> }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/handoff/${stage}`, { data: { outputRefs, status } }));
    await handoff('CONTENT', { scriptRevisionId: script.id }); await handoff('VOICE', {}, 'SKIPPED'); await handoff('DIGITAL_HUMAN', {}, 'SKIPPED');
    const workspaceId = `workspace-project-${projectId}`;
    const snapshot = await json<{ id: string }>(await page.request.post(`${baseUrl}/api/v1/edit/v3/pool/snapshots`, { data: { workspaceId, sourceFiles: fixtureVideos.slice(0, 3), sourceKind: 'MANUAL' } })); await handoff('MATERIALS', { materialPoolSnapshotId: snapshot.id });
    const session = await json<{ session: { id: string } }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/editing-session`, { data: { scriptRevisionId: script.id, materialPoolSnapshotId: snapshot.id } }));
    const generated = await json<{ generated: { manifestId: string } }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/editing-session/${session.session.id}/generate`, { data: {} })); assert.ok(generated.generated.manifestId);
    const preview = await json<{ jobId: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/preview`, { data: { mode: 'DRAFT' } })); await waitFor(async () => json<{ state: string }>(await page.request.get(`${baseUrl}/api/v1/jobs/${preview.jobId}`)), (job) => ['SUCCEEDED', 'FAILED'].includes(job.state), 'Production Preview Job');
    const afterPreview = await json<{ steps: Array<{ stage: string; status: string }> }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/reconcile`, { data: {} })); assert.equal(afterPreview.steps.find((step) => step.stage === 'PREVIEW')?.status, 'SUCCEEDED');
    await json(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/request-approval`, { data: { approver: 'browser' } })); await json(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/approve`, { data: { approver: 'browser' } }));
    const render = await json<{ jobId: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/render`, { data: {} })); await waitFor(async () => json<{ state: string }>(await page.request.get(`${baseUrl}/api/v1/jobs/${render.jobId}`)), (job) => ['SUCCEEDED', 'FAILED'].includes(job.state), 'Production Render Job');
    const finalRun = await json<{ steps: Array<{ stage: string; status: string }>; status: string }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/production-runs/${run.id}/reconcile`, { data: {} })); assert.equal(finalRun.steps.find((step) => step.stage === 'RENDER')?.status, 'SUCCEEDED');
  } finally { await browser.close(); }
});
