import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureVideo = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;

test('operator browser smoke walks the unified project stages', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  assert.ok(fixtureVideo, 'test:browser must provide a playable upload fixture');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl!, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    const projectName = `Browser smoke ${Date.now()}`;
    await page.getByRole('textbox', { name: /项目名称/ }).fill(projectName);
    await page.locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.getByTestId('project-center').waitFor({ timeout: 10_000 });
    for (const label of ['Assets', 'Director', 'Video', 'Approval Gate', 'Publisher']) assert.ok(await page.getByRole('link', { name: new RegExp(`^${label}`) }).count() >= 1, label);
  } finally {
    await browser.close();
  }
});
