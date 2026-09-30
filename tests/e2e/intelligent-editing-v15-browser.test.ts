import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, type APIResponse } from 'playwright';
import test from 'node:test';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureVideo = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;

async function json<T>(response: APIResponse): Promise<T> {
  assert.ok(response.ok(), `${response.status()} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

test('Intelligent Editing V1.5 browser vertical slice uploads, analyzes, plans, records replacement and renders', async () => {
  assert.ok(baseUrl, 'browser harness must provide CONTENTOS_OPERATOR_URL');
  assert.ok(fixtureVideo, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_VIDEO');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const project = await json<{ id: string }>(await page.request.post(`${baseUrl}/api/v1/projects`, { data: { name: `Intelligent Editing Browser ${Date.now()}` } }));
    await page.goto(`${baseUrl}/projects/${project.id}/assets`, { waitUntil: 'domcontentloaded' });
    await page.locator('input[type="file"]').setInputFiles({ name: 'intelligent-browser-fixture.mp4', mimeType: 'video/mp4', buffer: await readFile(fixtureVideo) });
    const imported = await waitFor(async () => json<{ items: Array<{ state: string; outputAssetId?: string | null }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${project.id}/asset-imports`)), (value) => value.items.some((item) => ['READY', 'DEDUPED'].includes(item.state) && Boolean(item.outputAssetId)), 'Asset Import');
    const assetId = imported.items.find((item) => ['READY', 'DEDUPED'].includes(item.state) && item.outputAssetId)?.outputAssetId;
    assert.ok(assetId);

    await page.goto(`${baseUrl}/projects/${project.id}/intelligence`, { waitUntil: 'domcontentloaded' });
    let runId = '';
    let renderJobId = '';
    let initialPlan: { manifestId?: string | null; renderJobId?: string | null; candidates: Array<{ id: string; sentenceId: string; shotId: string | null; selected: boolean }> } | undefined;
    let replacement: { manifestId: string; renderJobId: string; revision: number; manifestRevision: number; selectedCandidateId: string } | undefined;
    page.on('response', (response) => {
      if (response.url().endsWith(`/api/v1/projects/${project.id}/intelligence/analyses`) && response.request().method() === 'POST') void response.json().then((body: { runId?: string }) => { runId = body.runId || ''; }).catch(() => undefined);
      if (response.url().endsWith(`/api/v1/projects/${project.id}/intelligence/plans`) && response.request().method() === 'POST') void response.json().then((body: typeof initialPlan & { renderJobId?: string | null }) => { initialPlan = body; renderJobId = body.renderJobId || ''; }).catch(() => undefined);
      if (response.url().includes(`/api/v1/projects/${project.id}/intelligence/plans/`) && response.url().endsWith('/select-candidate') && response.request().method() === 'POST') void response.json().then((body: typeof replacement) => { replacement = body; }).catch(() => undefined);
    });
    await page.getByRole('button', { name: '分析全部 READY 视频' }).click();
    await waitFor(async () => runId, (value) => Boolean(value), 'Analysis Run ID', 15_000);
    const analysis = await waitFor(async () => json<{ run: { status: string }; shots: unknown[]; keyframes: unknown[] }>(await page.request.get(`${baseUrl}/api/v1/projects/${project.id}/intelligence/analyses/${runId}`)), (value) => value.run.status === 'SUCCEEDED', 'Analysis Run');
    assert.ok(analysis.shots.length > 0); assert.ok(analysis.keyframes.length > 0);

    await page.getByText(/镜头 \/ 关键帧/).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText(/Shot [12] ·/).first().waitFor({ state: 'visible', timeout: 30_000 });
    const search = page.locator('input[placeholder="例如：消费者正在选购产品"]');
    await search.fill('视频');
    await page.getByRole('button', { name: '搜索' }).click();
    await page.getByText(/score/).first().waitFor({ state: 'visible', timeout: 15_000 });

    await page.locator('input[placeholder^="输入 Script Sentence"]').fill('素材中的视频画面');
    await page.getByRole('button', { name: '生成 Plan / Manifest / Render Job' }).click();
    await page.getByText(/Plan intelligent-plan-/).waitFor({ state: 'visible', timeout: 30_000 });
    await waitFor(async () => initialPlan, (value) => Boolean(value?.manifestId && value?.renderJobId && value.candidates?.length), 'Initial Plan', 15_000);
    const initialSelected = initialPlan!.candidates.find((candidate) => candidate.selected); const alternative = initialPlan!.candidates.find((candidate) => !candidate.selected); assert.ok(initialSelected); assert.ok(alternative);
    const alternatives = page.getByRole('button', { name: '选择此候选' }); assert.ok(await alternatives.count() > 0); await alternatives.first().click();
    await waitFor(async () => replacement, (value) => Boolean(value?.manifestId && value?.renderJobId && value.selectedCandidateId === alternative!.id), 'Candidate Replacement', 30_000);
    assert.notEqual(replacement!.manifestId, initialPlan!.manifestId); assert.notEqual(replacement!.renderJobId, initialPlan!.renderJobId); assert.equal(replacement!.revision, 2);
    const replacementManifest = await json<{ manifest: { timeline: Array<{ sourceSegmentId?: string }> } }>(await page.request.get(`${baseUrl}/api/v1/projects/${project.id}/video/manifests/${replacement!.manifestId}`)); assert.equal(replacementManifest.manifest.timeline.find((clip) => clip.sourceSegmentId === alternative!.shotId)?.sourceSegmentId, alternative!.shotId);
    renderJobId = replacement!.renderJobId;
    await page.getByText(/已生成新剪辑版本：Manifest Revision/).waitFor({ state: 'visible', timeout: 15_000 });
    await waitFor(async () => renderJobId, (value) => Boolean(value), 'Replacement Render Job ID', 15_000);
    const renderJob = await waitFor(async () => json<{ state: string; result?: { outputAssetId?: string } | null }>(await page.request.get(`${baseUrl}/api/v1/jobs/${renderJobId}`)), (job) => job.state === 'SUCCEEDED', 'Intelligent Render Job');
    assert.equal(renderJob.state, 'SUCCEEDED');
    assert.equal(typeof renderJob.result?.outputAssetId, 'string');
    assert.ok(assetId);
  } finally {
    await browser.close();
  }
});
