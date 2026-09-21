import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : [];

test('Script Editing V3 browser flow imports Jianying draft files and directories', async () => {
  assert.ok(baseUrl && fixtureDir, 'V3 browser harness must provide a fixture directory');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const filePath = join(fixtureDir!, 'jianying-browser-file.json');
  const directoryPath = join(fixtureDir!, 'jianying-browser-directory');
  await mkdir(directoryPath, { recursive: true });
  await writeFile(filePath, JSON.stringify({ draft_id: 'browser-file-draft', draft_name: '浏览器文件草稿' }));
  await writeFile(join(directoryPath, 'draft_content.json'), JSON.stringify({ draft_id: 'browser-directory-draft', draft_name: '浏览器目录草稿' }));
  try {
    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    const draftInput = page.locator('input[placeholder="只读导入剪映草稿文件或草稿目录（可选）"]');
    const importDraft = async (draftPath: string) => {
      await draftInput.fill('');
      await draftInput.pressSequentially(draftPath, { delay: 1 });
      await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '导入剪映历史');
        return Boolean(button && !(button as HTMLButtonElement).disabled);
      }, undefined, { timeout: 10_000 });
      await page.getByRole('button', { name: '导入剪映历史' }).click();
      await page.getByText(/已只读导入剪映草稿/).waitFor({ state: 'visible', timeout: 60_000 });
    };
    await importDraft(filePath);
    await importDraft(directoryPath);
  } finally { await browser.close(); }
});

test('Script Editing V3 browser flow covers pool, candidates, locking and full preview', async () => {
  assert.ok(baseUrl && fixtureDir && fixtureVideos.length >= 3, 'V3 browser harness must provide fixtures');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  let generationResponse = 'not observed';
  let sessionId = '';
  page.on('response', (response) => {
    if (response.url().includes('/api/v1/edit/v3/sessions/') && response.url().endsWith('/generate')) void response.text().then((body) => { generationResponse = `${response.status()} ${body}`; });
    if (response.url().endsWith('/api/v1/edit/v3/sessions') && response.request().method() === 'POST') void response.json().then((body: { id?: string }) => { sessionId = body.id || ''; }).catch(() => undefined);
  });
  const sourceRoot = join(fixtureDir!, 'v3-pool');
  await mkdir(sourceRoot, { recursive: true });
  for (const [index, source] of fixtureVideos.slice(0, 3).entries()) await generateFixtureVideo(join(sourceRoot, `v3-material-${index + 1}.mp4`), process.env.FFMPEG_PATH || 'ffmpeg', ['blue', 'green', 'red'][index], 8);

  try {
    // The product entry is the existing Script Editing route. /edit/script/v3
    // remains only as a compatibility alias and must not be a second workbench.
    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sentence Editing Workbench' }).waitFor({ state: 'visible', timeout: 15_000 });
    const runtimeStatus = page.getByTestId('jianying-runtime-status');
    await runtimeStatus.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(await runtimeStatus.innerText(), /明文草稿支持/);
    const sourceRootInput = page.locator('input[placeholder="输入已授权的素材文件夹路径"]');
    await sourceRootInput.fill('');
    await sourceRootInput.pressSequentially(sourceRoot, { delay: 1 });
    assert.equal(await sourceRootInput.inputValue(), sourceRoot);
    const scanButton = page.getByRole('button', { name: '扫描素材' });
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '扫描素材'); return Boolean(button && !(button as HTMLButtonElement).disabled); }, undefined, { timeout: 10_000 });
    await scanButton.click();
    await page.getByText(/扫描状态：SUCCEEDED/).waitFor({ state: 'visible', timeout: 45_000 });

    await page.getByRole('button', { name: '固定素材池快照' }).click();
    const snapshotLabel = page.getByText(/Snapshot：/);
    await snapshotLabel.waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('material-pool-health').waitFor({ state: 'visible', timeout: 15_000 });
    const snapshotId = (await snapshotLabel.innerText()).match(/Snapshot：([^ ·]+)/)?.[1];
    assert.ok(snapshotId);
    const snapshotResponse = await page.request.get(`${baseUrl}/api/v1/edit/v3/pool/snapshots/${snapshotId}`);
    assert.equal(snapshotResponse.status(), 200, await snapshotResponse.text());
    const snapshot = await snapshotResponse.json() as { items: Array<{ assetId: string; fileName: string; durationMs: number }> };
    assert.ok(snapshot.items.every((item) => item.durationMs >= 3_000), `V3 fixture durations: ${JSON.stringify(snapshot.items)}`);
    await page.locator('textarea').fill('门店外景吸引顾客。顾客在货架区域挑选商品。');
    await page.getByRole('button', { name: '整理并确认分段' }).click();
    await page.getByTestId('confirmed-segments').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: '创建 Workbench' }).click();
    await page.getByText('文案已生成视觉查询，点击“生成首版方案”。').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: '生成首版方案' }).click();
    await page.getByRole('heading', { name: 'Sentence Editing Cards' }).waitFor({ state: 'visible', timeout: 20_000 });
    const cards = page.locator('article.card');
    await cards.nth(1).waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await cards.count(), 2);

    const firstCard = cards.nth(0);
    await firstCard.getByRole('button', { name: '锁定', exact: true }).click();
    await page.getByText('已锁定当前 Clip').waitFor({ state: 'visible', timeout: 10_000 });
    await firstCard.getByRole('button', { name: '解锁', exact: true }).click();
    await page.getByText('已解锁当前 Clip').waitFor({ state: 'visible', timeout: 10_000 });

    const candidateSummary = firstCard.getByText(/Candidate Browser/);
    const candidateLoadingStarted = performance.now();
    await candidateSummary.click();
    await firstCard.getByRole('button', { name: '选择候选' }).first().waitFor({ state: 'visible', timeout: 10_000 });
    console.log(JSON.stringify({ benchmark: 'SCRIPT_EDITING_V3_UI', metric: 'candidateLoadingMs', value: Math.round((performance.now() - candidateLoadingStarted) * 100) / 100 }));
    await firstCard.getByRole('button', { name: '选择候选' }).first().click();
    await page.getByText(/已将当前句子替换为候选/).waitFor({ state: 'visible', timeout: 10_000 });

    assert.ok(sessionId);
    await firstCard.getByTestId('manual-select-toggle').click();
    const manualPanel = firstCard.getByTestId('manual-select-panel');
    await manualPanel.waitFor({ state: 'visible', timeout: 10_000 });
    await manualPanel.getByPlaceholder('人工标签（逗号分隔）').first().fill('货架');
    await manualPanel.getByRole('button', { name: '保存标签' }).first().click();
    await page.getByText(/已保存 .* 的人工标签/).waitFor({ state: 'visible', timeout: 10_000 });
    await manualPanel.getByRole('button', { name: '标记 Gold' }).first().click();
    await page.getByText(/已标记 .* 为 Gold/).waitFor({ state: 'visible', timeout: 10_000 });
    await manualPanel.getByTestId('manual-select-clip').last().click();
    await page.getByText(/已人工选择/).waitFor({ state: 'visible', timeout: 10_000 });
    const trimRanges = firstCard.locator('input[type="range"]');
    await trimRanges.nth(0).fill('100');
    await trimRanges.nth(1).fill('3100');
    await firstCard.getByRole('button', { name: '保存 Trim' }).click();
    await page.getByText('已保存 Source Monitor 区间').waitFor({ state: 'visible', timeout: 10_000 });

    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByText('已撤销到上一版；快速预览已过期。').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByText('已恢复下一版；快速预览已过期。').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText(/Revision History/).click();
    await page.getByText(/变更句子/).first().waitFor({ state: 'visible', timeout: 10_000 });
    const firstPoolPreview = page.locator('.material-preview-card').first();
    await firstPoolPreview.getByRole('button', { name: '检测镜头' }).click();
    await page.getByText(/镜头检测完成：/).waitFor({ state: 'visible', timeout: 120_000 });

    const revisionPreview = page.locator('section.card').filter({ hasText: 'V3.4 Revision / Preview' });
    await revisionPreview.getByRole('button', { name: '更新 Draft Preview' }).click();
    await page.getByText(/Draft Preview 已完成：复用/).waitFor({ state: 'visible', timeout: 120_000 });
    assert.ok(await revisionPreview.locator('video').getAttribute('src'));

    await page.getByRole('button', { name: '渲染整片', exact: true }).click();
    await page.getByText('整片渲染已进入 durable Job；正在等待成片…').waitFor({ state: 'visible', timeout: 10_000 });
    const preview = page.locator('video.history-preview').last();
    await preview.waitFor({ state: 'visible', timeout: 120_000 });
    await page.getByText('整片已完成，可以播放并按时间定位句子。').waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok(await preview.getAttribute('src'));

    await firstCard.getByRole('button', { name: /01 ·/ }).click();
    await page.getByText('当前句子：门店外景吸引顾客').waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    throw new Error(`V3 browser flow failed：${await page.locator('body').innerText()}\n生成接口：${generationResponse}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser.close();
  }
});

test('Script Editing V3 degraded journey stays manual when Qwen is not configured', async () => {
  assert.ok(baseUrl && fixtureDir && fixtureVideos.length >= 1, 'V3 browser harness must provide fixtures');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const sourceRoot = join(fixtureDir!, 'v3-degraded');
  await mkdir(sourceRoot, { recursive: true });
  await generateFixtureVideo(join(sourceRoot, 'v3-degraded-material.mp4'), process.env.FFMPEG_PATH || 'ffmpeg', 'purple', 8);
  try {
    const qwenStatus = await page.request.get(`${baseUrl}/api/v1/ai/qwen/status`);
    assert.equal(qwenStatus.status(), 200);
    assert.equal((await qwenStatus.json() as { configured: boolean }).configured, false, 'degraded journey requires Qwen to be unconfigured');
    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sentence Editing Workbench' }).waitFor({ state: 'visible', timeout: 15_000 });
    const sourceRootInput = page.locator('input[placeholder="输入已授权的素材文件夹路径"]');
    await sourceRootInput.fill('');
    await sourceRootInput.pressSequentially(sourceRoot, { delay: 1 });
    assert.equal(await sourceRootInput.inputValue(), sourceRoot);
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '扫描素材'); return Boolean(button && !(button as HTMLButtonElement).disabled); }, undefined, { timeout: 10_000 });
    await page.getByRole('button', { name: '扫描素材' }).click();
    await page.getByText(/扫描状态：SUCCEEDED/).waitFor({ state: 'visible', timeout: 45_000 });
    await page.getByRole('button', { name: '固定素材池快照' }).click();
    const snapshotLabel = page.getByText(/Snapshot：/);
    await snapshotLabel.waitFor({ state: 'visible', timeout: 15_000 });
    const snapshotId = (await snapshotLabel.innerText()).match(/Snapshot：([^ ·]+)/)?.[1];
    assert.ok(snapshotId);
    const snapshotResponse = await page.request.get(`${baseUrl}/api/v1/edit/v3/pool/snapshots/${snapshotId}`);
    assert.equal(snapshotResponse.status(), 200, await snapshotResponse.text());
    const snapshot = await snapshotResponse.json() as { items: Array<{ assetId: string }> };
    const analyzeResponse = await page.request.post(`${baseUrl}/api/v1/edit/v3/pool/snapshots/${snapshotId}/analyze`, { data: { assetId: snapshot.items[0]!.assetId } });
    assert.equal(analyzeResponse.status(), 503, await analyzeResponse.text());
    await page.locator('textarea').fill('人工选择画面完成降级剪辑。');
    await page.getByRole('button', { name: '整理并确认分段' }).click();
    await page.getByTestId('confirmed-segments').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: '创建 Workbench' }).click();
    await page.getByRole('button', { name: '生成首版方案' }).click();
    const firstCard = page.locator('article.card').first();
    await firstCard.getByTestId('manual-select-toggle').click();
    const manualPanel = firstCard.getByTestId('manual-select-panel');
    await manualPanel.waitFor({ state: 'visible', timeout: 15_000 });
    await manualPanel.getByTestId('manual-select-clip').first().click();
    await page.getByText(/已人工选择/).waitFor({ state: 'visible', timeout: 10_000 });
    const ranges = firstCard.locator('input[type="range"]');
    await ranges.nth(0).fill('0');
    await ranges.nth(1).fill('3000');
    await firstCard.getByRole('button', { name: '保存 Trim' }).click();
    await page.getByText('已保存 Source Monitor 区间').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '渲染整片', exact: true }).click();
    await page.locator('video.history-preview').last().waitFor({ state: 'visible', timeout: 120_000 });
    await page.getByText('整片已完成，可以播放并按时间定位句子。').waitFor({ state: 'visible', timeout: 15_000 });
  } finally { await browser.close(); }
});

test('Script Editing V3.4 browser closure covers Asset Library and Gold Set workflow', async () => {
  assert.ok(baseUrl && fixtureDir && fixtureVideos.length >= 1, 'V3 browser harness must provide fixtures');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const workspaceId = 'workspace-v3';
  const root = join(fixtureDir!, `asset-library-closure-${randomUUID()}`);
  const source = join(root, 'closure-original.mp4');
  const movedRoot = join(fixtureDir!, `asset-library-moved-${randomUUID()}`);
  const moved = join(movedRoot, 'closure-moved.mp4');
  try {
    await mkdir(root, { recursive: true }); await mkdir(movedRoot, { recursive: true }); await copyFile(fixtureVideos[0]!, source); await copyFile(source, moved);
    const scanResponse = await page.request.post(`${baseUrl}/api/v1/edit/v3/scans`, { data: { workspaceId, sourceRoot: root, recursive: false } });
    assert.ok([201, 202].includes(scanResponse.status()), await scanResponse.text());
    const scan = await scanResponse.json() as { scanId: string; jobId: string; sourceRootId: string };
    for (let attempt = 0; attempt < 90; attempt += 1) { const job = await page.request.get(`${baseUrl}/api/v1/jobs/${scan.jobId}`); if (job.ok() && (await job.json() as { state: string }).state === 'SUCCEEDED') break; await new Promise((resolve) => setTimeout(resolve, 250)); }
    await unlink(source);
    const missingScanResponse = await page.request.post(`${baseUrl}/api/v1/edit/v3/scans`, { data: { workspaceId, sourceRoot: root, recursive: false, idempotencyKey: `asset-library-missing-${randomUUID()}` } });
    assert.ok([201, 202].includes(missingScanResponse.status()), await missingScanResponse.text());
    const missingScan = await missingScanResponse.json() as { jobId: string };
    for (let attempt = 0; attempt < 90; attempt += 1) { const job = await page.request.get(`${baseUrl}/api/v1/jobs/${missingScan.jobId}`); if (job.ok() && (await job.json() as { state: string }).state === 'SUCCEEDED') break; await new Promise((resolve) => setTimeout(resolve, 250)); }
    const missingIndex = await page.request.get(`${baseUrl}/api/v1/video/local-media/index?workspaceId=${encodeURIComponent(workspaceId)}&query=closure-original.mp4&page=1&pageSize=10`);
    assert.equal(missingIndex.status(), 200, await missingIndex.text());
    const missingItems = await missingIndex.json() as { items: Array<{ available: boolean }> };
    assert.equal(missingItems.items[0]?.available, false, JSON.stringify(missingItems));
    await page.goto(`${baseUrl}/assets/library`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '长期素材库' }).waitFor({ state: 'visible', timeout: 15_000 });
    const libraryQuery = page.locator('input[placeholder="搜索文件名、相对路径或人工标签"]');
    await libraryQuery.fill('closure-original.mp4');
    await page.getByRole('button', { name: '查询' }).click();
    await page.getByText('closure-original.mp4', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText('MISSING').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText('完整路径').first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByLabel('选择素材').first().check();
    await page.getByPlaceholder('批量添加标签，逗号分隔').fill('批量验证');
    await page.getByRole('button', { name: '批量添加标签' }).click();
    await page.getByText(/已为 1 个素材保存标签/).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '禁用素材' }).first().click();
    await page.getByRole('button', { name: '恢复素材' }).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '选择文件' }).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByText(/Shots：尚未检测/).first().waitFor({ state: 'visible', timeout: 10_000 });
    const fileId = `${scan.sourceRootId}:closure-original.mp4`;
    const relink = await page.request.post(`${baseUrl}/api/v1/video/local-media/index/${encodeURIComponent(fileId)}/relink?workspaceId=${encodeURIComponent(workspaceId)}`, { data: { sourcePath: moved } });
    assert.equal(relink.status(), 200, await relink.text()); assert.equal((await relink.json() as { confidence: string }).confidence, 'HIGH');

    const items = Array.from({ length: 100 }, (_, index) => ({ assetId: `closure-asset-${index + 1}`, fileName: `closure-${index + 1}.mp4`, durationMs: 6_000, tags: index % 2 ? ['货架'] : ['门店外景'] }));
    const queries = Array.from({ length: 10 }, (_, index) => ({ id: `closure-query-${index + 1}`, visualNeed: index === 0 ? '顾客在货架区域挑选商品' : `Visual Need ${index + 1}`, usableAssetIds: [items[index]!.assetId], forbiddenAssetIds: [items[index + 50]!.assetId] }));
    const imported = await page.request.post(`${baseUrl}/api/v1/edit/v3/evaluation-sets/import`, { data: { workspaceId, name: 'Browser Closure Gold Set', idempotencyKey: 'browser-closure-gold-set', items, queries } });
    assert.equal(imported.status(), 201, await imported.text()); const set = await imported.json() as { id: string };
    await page.goto(`${baseUrl}/edit/script/v3/evaluation/${encodeURIComponent(set.id)}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Browser Closure Gold Set' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByPlaceholder('新增 Visual Need，例如：仓库备货').fill('仓库备货'); await page.getByRole('button', { name: '创建 Visual Need' }).click(); await page.getByText('仓库备货').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByPlaceholder('搜索文件名或标签').fill('closure-1'); await page.getByRole('button', { name: '最佳' }).first().click(); await page.getByText('人工判定已保存').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '运行 Rules Baseline' }).click(); await page.getByText('BASELINE_RULES', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  } finally { await browser.close(); await rm(root, { recursive: true, force: true }); await rm(movedRoot, { recursive: true, force: true }); }
});
