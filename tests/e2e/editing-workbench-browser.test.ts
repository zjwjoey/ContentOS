import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { chromium, type Page } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const apiUrl = process.env.CONTENTOS_API_URL || baseUrl;
const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : [];
const fixtureAudio = process.env.CONTENTOS_BROWSER_FIXTURE_AUDIO;

async function waitForBatch(page: Page, batchId: string, expected: 'SUCCEEDED' | 'PARTIAL' = 'SUCCEEDED'): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${apiUrl}/api/v1/edit/batches/${encodeURIComponent(batchId)}`);
    if (response.ok()) {
      const batch = await response.json() as Record<string, unknown>;
      if (batch.status === expected || (expected === 'SUCCEEDED' && batch.status === 'PARTIAL')) return batch;
      if (batch.status === 'FAILED') throw new Error(`批次失败：${JSON.stringify(batch)}`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`批次在限定时间内未完成：${batchId}`);
}

async function makeSourceRoots(): Promise<{ first: string; second: string; output: string }> {
  assert.ok(fixtureDir && fixtureVideos.length >= 2 && fixtureAudio && baseUrl, '编辑工作台浏览器验收需要隔离 fixture');
  const first = join(fixtureDir!, 'workbench-source-a');
  const second = join(fixtureDir!, 'workbench-source-b');
  const output = join(fixtureDir!, 'workbench-output');
  await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true }); await mkdir(output, { recursive: true });
  await copyFile(fixtureVideos[0]!, join(first, '商品-a.mp4'));
  // MIX is strict-unique per task: each two-sentence item needs two distinct
  // source clips in its selected folder.
  await copyFile(fixtureVideos[1]!, join(first, '商品-b.mp4'));
  await copyFile(fixtureVideos[1]!, join(second, '街景-b.mp4'));
  return { first, second, output };
}

async function exportBatch(page: Page, batchId: string, expectedCount = 1): Promise<void> {
  await page.getByRole('button', { name: '导出成片' }).click();
  try { await page.getByText(/已创建 [1-9] 个导出任务/u).waitFor({ state: 'visible', timeout: 15_000 }); }
  catch (error) { throw new Error(`批次 ${batchId} 导出未成功：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
  const preview = page.locator('video.history-preview');
  await preview.first().waitFor({ state: 'visible', timeout: 15_000 });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && await preview.count() < expectedCount) await page.waitForTimeout(250);
  assert.equal(await preview.count(), expectedCount, `批次 ${batchId} 应该有可预览成片`);
}

test('独立剪辑工作台完成脚本、测试混剪与批量失败重试流程', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  const roots = await makeSourceRoots();
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const database = new pg.Pool({ connectionString: process.env.CONTENTOS_BROWSER_DATABASE_URL });
  try {
    // Flow A: script edit, uploaded audio, two source roots, export and preview.
    const pairTextRoot = join(fixtureDir!, 'pair-text'); const pairAudioRoot = join(fixtureDir!, 'pair-audio');
    await mkdir(pairTextRoot, { recursive: true }); await mkdir(pairAudioRoot, { recursive: true });
    await writeFile(join(pairTextRoot, '001.txt'), '第一条文案'); await writeFile(join(pairTextRoot, '003.txt'), '第三条文案');
    await copyFile(fixtureAudio!, join(pairAudioRoot, '001.wav')); await copyFile(fixtureAudio!, join(pairAudioRoot, '004.wav'));
    const pairingResponse = await page.request.post(`${apiUrl}/api/v1/edit/pair`, { data: { textFiles: [join(pairTextRoot, '001.txt'), join(pairTextRoot, '003.txt')], audioFiles: [join(pairAudioRoot, '001.wav'), join(pairAudioRoot, '004.wav')] } });
    assert.equal(pairingResponse.status(), 200); const pairing = await pairingResponse.json() as { items: Array<{ basename: string; status: string }> };
    assert.deepEqual(pairing.items.map((item) => [item.basename, item.status]), [['001', 'READY'], ['003', 'MISSING_AUDIO'], ['004', 'MISSING_TEXT']]);
    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    const scriptArea = page.locator('.edit-form textarea').first(); await scriptArea.click(); await scriptArea.pressSequentially('第一段脚本。第二段脚本。第三段脚本。');
    await page.getByLabel('脚本配音文件').setInputFiles(fixtureAudio!);
    const sourceLabels = page.locator('.folder-row input');
    await page.getByRole('button', { name: '高级模式：手动添加路径' }).click(); await sourceLabels.nth(0).fill(roots.first); await sourceLabels.nth(1).fill(roots.second);
    await page.getByLabel('输出文件夹').fill(roots.output);
    await page.getByRole('button', { name: '开始剪辑' }).click();
    try { await page.waitForURL(/\/edit\/history\?batch=/u, { timeout: 45_000 }); }
    catch (error) { const values = await page.locator('input,textarea').evaluateAll((elements) => elements.map((element) => ({ tag: element.tagName, aria: element.getAttribute('aria-label'), value: (element as HTMLInputElement).value }))); throw new Error(`脚本剪辑未进入历史页：${JSON.stringify(values)}\n${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    const scriptBatchId = new URL(page.url()).searchParams.get('batch'); assert.ok(scriptBatchId);
    await waitForBatch(page, scriptBatchId!);
    await exportBatch(page, scriptBatchId!);

    // Flow B: three items, test one, copy the task, then run all.
    await page.goto(`${baseUrl}/edit/mix`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);
    const rows = page.locator('.batch-row');
    for (let index = 0; index < 2; index += 1) { const addItem = page.getByRole('button', { name: '+ 添加一条' }); assert.equal(await addItem.count(), 1); assert.equal(await addItem.isEnabled(), true); await addItem.click({ force: true }); await rows.nth(index + 1).waitFor({ state: 'visible', timeout: 5_000 }); }
    const rowCount = await rows.count(); assert.equal(rowCount, 3);
    for (let index = 0; index < rowCount; index += 1) {
      await rows.nth(index).locator('textarea').fill(`批量文案 ${index + 1}。第二句。`);
      await rows.nth(index).locator('.path-fallback input').fill(fixtureAudio!);
    }
    await page.locator('.folder-row input').first().fill(roots.first); await page.getByLabel('输出文件夹').fill(roots.output);
    await page.getByRole('button', { name: '生成 1 条测试' }).click();
    await page.waitForURL(/\/edit\/history\?batch=/u);
    const testBatchId = new URL(page.url()).searchParams.get('batch'); assert.ok(testBatchId);
    await waitForBatch(page, testBatchId!); await exportBatch(page, testBatchId!);
    await page.getByRole('link', { name: '满意，开始全部混剪' }).click();
    await page.waitForURL(/\/edit\/mix\?copy=/u);
    await page.locator('.batch-row').nth(2).waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByRole('button', { name: '开始全部混剪' }).click();
    try { await page.waitForURL(/\/edit\/history\?batch=/u, { timeout: 45_000 }); }
    catch (error) { throw new Error(`全部混剪未进入历史页：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    const mixBatchId = new URL(page.url()).searchParams.get('batch'); assert.ok(mixBatchId);
    const mixBatch = await waitForBatch(page, mixBatchId!); assert.equal(mixBatch.totalCount, 3);
    await exportBatch(page, mixBatchId!, 3);

    // Flow C: simulate one renderer failure after two outputs succeeded, then retry only that item.
    const mixItems = mixBatch.items as Array<{ id: string; jobId?: string }>;
    assert.equal(mixItems.length, 3); assert.ok(mixItems[0]?.jobId);
    await database.query("update jobs set state = 'FAILED', error = $2, updated_at = now() where id = $1", [mixItems[0]!.jobId, { code: 'SIMULATED_RENDER_FAILURE', message: '模拟渲染失败' }]);
    await database.query("update edit_batch_items set state = 'FAILED', output_asset_id = null, output_path = null, error = $2, updated_at = now() where id = $1", [mixItems[0]!.id, { code: 'SIMULATED_RENDER_FAILURE', message: '模拟渲染失败' }]);
    await page.goto(`${baseUrl}/edit/history?batch=${encodeURIComponent(mixBatchId!)}`, { waitUntil: 'domcontentloaded' });
    const partial = await waitForBatch(page, mixBatchId!, 'PARTIAL'); assert.equal(partial.totalCount, 3); assert.equal(partial.failedCount, 1); assert.equal(partial.succeededCount, 2);
    assert.equal(await page.getByRole('button', { name: '重试失败任务' }).isEnabled(), true);
    const retryResponse = await page.request.post(`${apiUrl}/api/v1/edit/batches/${encodeURIComponent(mixBatchId!)}/retry`);
    assert.equal(retryResponse.status(), 202); const retryPayload = await retryResponse.json() as { items: unknown[] }; assert.equal(retryPayload.items.length, 1);
    await waitForBatch(page, mixBatchId!);
    await exportBatch(page, mixBatchId!, 3);
  } finally { await database.end(); await browser.close(); }
});
