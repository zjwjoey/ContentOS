import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

async function waitForBatch(page: Page, apiUrl: string, batchId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 45_000;
  let lastBatch: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${apiUrl}/api/v1/edit/batches/${encodeURIComponent(batchId)}`);
    if (response.ok()) {
      const batch = await response.json() as Record<string, unknown>; lastBatch = batch;
      if (batch.status === 'SUCCEEDED' || batch.status === 'PARTIAL') return batch;
      if (batch.status === 'FAILED') throw new Error(`Hybrid batch failed: ${JSON.stringify(batch)}`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Hybrid batch timed out: ${batchId} ${JSON.stringify(lastBatch)}`);
}

test('Hybrid Script Editing source controls and external-only flow work in the browser', async () => {
  const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
  assert.ok(baseUrl, 'browser harness URL required');
  const apiUrl = process.env.CONTENTOS_API_URL || baseUrl;
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const status = await page.request.get(`${apiUrl}/api/v1/media-providers`);
    assert.equal(status.status(), 200);
    const providerStatus = await status.json() as { items: Array<{ configured: boolean; healthy: boolean | null }> };
    assert.equal(providerStatus.items.length, 1);
    assert.equal(providerStatus.items[0]?.configured, true);

    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);
    assert.match(await page.locator('body').innerText(), /Pexels/);
    assert.equal(await page.getByText(/素材来源/u).count() > 0, true);

    const missingPage = await browser.newPage();
    await missingPage.route(`${baseUrl}/api/v1/media-providers`, async (route) => await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'fake-pexels', configured: false, healthy: null }] }) }));
    await missingPage.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' }); await missingPage.waitForTimeout(500);
    const missingToggle = missingPage.locator('.source-provider input[type="checkbox"]');
    assert.equal(await missingToggle.isDisabled(), true); assert.equal(await missingToggle.isChecked(), false); assert.match(await missingPage.locator('.source-provider').innerText(), /未配置/u); assert.equal(await missingPage.getByRole('link', { name: '前往设置' }).count(), 1); await missingPage.close();

    const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR!;
    const fixture = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO!;
    const localRoot = join(fixtureDir, 'hybrid-local');
    const hybridOutput = join(fixtureDir, 'hybrid-output');
    await mkdir(localRoot, { recursive: true });
    await mkdir(hybridOutput, { recursive: true });
    await copyFile(fixture, join(localRoot, 'generic.mp4'));

    await page.locator('.edit-form textarea').first().fill('MIZAN 正在波兰拓展业务。商业合作正在推进。');
    await page.locator('.folder-row input').first().fill(localRoot);
    await page.locator('.folder-row input').first().blur();
    const pexelsToggle = page.locator('.source-provider input[type="checkbox"]');
    await pexelsToggle.check();
    assert.equal(await pexelsToggle.isChecked(), true);
    await page.getByLabel('输出文件夹').fill(hybridOutput);
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: '开始剪辑' }).click();
    await page.waitForURL(/\/edit\/history\?batch=/u, { timeout: 15_000 });
    const hybridBatchId = new URL(page.url()).searchParams.get('batch');
    assert.ok(hybridBatchId);
    const hybridBatch = await waitForBatch(page, apiUrl, hybridBatchId!);
    const hybridItem = (hybridBatch.items as Array<{ sourceStats?: { localCount: number; externalCount: number } }>)[0];
    assert.ok(hybridItem?.sourceStats && hybridItem.sourceStats.externalCount > 0);

    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);
    const externalOutput = join(fixtureDir, 'hybrid-external-output');
    await mkdir(externalOutput, { recursive: true });
    await page.locator('.edit-form textarea').first().fill('MIZAN 正在波兰拓展业务。');
    await page.locator('.source-provider input[type="checkbox"]').check();
    await page.getByLabel('输出文件夹').fill(externalOutput);
    await page.getByRole('button', { name: '开始剪辑' }).click();
    await page.waitForURL(/\/edit\/history\?batch=/u, { timeout: 15_000 });
    const externalBatchId = new URL(page.url()).searchParams.get('batch');
    assert.ok(externalBatchId);
    const externalBatch = await waitForBatch(page, apiUrl, externalBatchId!);
    assert.equal((externalBatch.items as Array<unknown>).length, 1);
  } finally {
    await browser.close();
  }
});
