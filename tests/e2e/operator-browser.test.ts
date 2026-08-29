import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;

test('operator browser smoke walks the unified project stages', { skip: !baseUrl }, async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl!, { waitUntil: 'domcontentloaded' });
    await page.getByRole('textbox', { name: /项目名称/ }).fill(`Browser smoke ${Date.now()}`);
    await page.getByRole('button', { name: /创建并进入项目总控/ }).click();
    await page.getByTestId('project-center').waitFor();
    for (const label of ['Assets', 'Director', 'Video', 'Approval Gate', 'Publisher']) assert.equal(await page.getByRole('link', { name: label, exact: true }).count(), 1, label);
  } finally {
    await browser.close();
  }
});
