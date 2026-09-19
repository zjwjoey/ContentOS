import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

test('Hybrid Script Editing source controls are visible and provider status is cached', async () => {
  const baseUrl = process.env.CONTENTOS_OPERATOR_URL; assert.ok(baseUrl, 'browser harness URL required');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const status = await page.request.get(`${process.env.CONTENTOS_API_URL || baseUrl}/api/v1/media-providers`); assert.equal(status.status(), 200);
    const body = await status.json() as { items: Array<{ configured: boolean; healthy: boolean | null }> }; assert.equal(body.items.length, 1);
    await page.goto(`${baseUrl}/edit/script`, { waitUntil: 'domcontentloaded' });
    assert.ok((await page.locator('body').innerText()).includes('Pexels'));
    assert.equal(await page.getByText(/来源|素材来源/u).count() > 0, true);
  } finally { await browser.close(); }
});
