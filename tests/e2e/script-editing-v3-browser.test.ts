import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { generateFixtureVideo } from '../../packages/infrastructure/ffmpeg/src/index.js';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : [];

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
    await page.goto(`${baseUrl}/edit/script/v3`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sentence Editing Workbench' }).waitFor({ state: 'visible', timeout: 15_000 });
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
    const snapshotId = (await snapshotLabel.innerText()).match(/Snapshot：([^ ·]+)/)?.[1];
    assert.ok(snapshotId);
    const snapshotResponse = await page.request.get(`${baseUrl}/api/v1/edit/v3/pool/snapshots/${snapshotId}`);
    assert.equal(snapshotResponse.status(), 200, await snapshotResponse.text());
    const snapshot = await snapshotResponse.json() as { items: Array<{ assetId: string; fileName: string; durationMs: number }> };
    assert.ok(snapshot.items.every((item) => item.durationMs >= 3_000), `V3 fixture durations: ${JSON.stringify(snapshot.items)}`);
    await page.locator('textarea').fill('门店外景吸引顾客。顾客在货架区域挑选商品。');
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
    await candidateSummary.click();
    await firstCard.getByRole('button', { name: '选择候选' }).first().waitFor({ state: 'visible', timeout: 10_000 });
    await firstCard.getByRole('button', { name: '选择候选' }).first().click();
    await page.getByText(/已将当前句子替换为候选/).waitFor({ state: 'visible', timeout: 10_000 });

    assert.ok(sessionId);
    const goldResponse = await page.request.post(`${baseUrl}/api/v1/edit/v3/pool/snapshots/${snapshotId}/items/${encodeURIComponent(snapshot.items[0]!.assetId)}/gold`, { data: { gold: true } });
    assert.equal(goldResponse.status(), 200, await goldResponse.text());
    const manualResponse = await page.request.post(`${baseUrl}/api/v1/edit/v3/sessions/${sessionId}/operations`, { data: { type: 'MANUAL_SELECT_CLIP', sentenceId: 'sentence-0', assetId: snapshot.items[0]!.assetId } });
    assert.equal(manualResponse.status(), 201, await manualResponse.text());

    await page.getByRole('button', { name: '渲染整片', exact: true }).click();
    await page.getByText('整片渲染已进入 durable Job；正在等待成片…').waitFor({ state: 'visible', timeout: 10_000 });
    const preview = page.locator('video.history-preview').last();
    await preview.waitFor({ state: 'visible', timeout: 120_000 });
    await page.getByText('整片已完成，可以播放并按时间定位句子。').waitFor({ state: 'visible', timeout: 15_000 });
    assert.ok(await preview.getAttribute('src'));

    await firstCard.getByRole('button', { name: /01 ·/ }).click();
    await page.getByText('当前句子：门店外景吸引顾客。').waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    throw new Error(`V3 browser flow failed：${await page.locator('body').innerText()}\n生成接口：${generationResponse}\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser.close();
  }
});
