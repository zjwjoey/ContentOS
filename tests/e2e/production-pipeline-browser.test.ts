import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;

test('Production Run browser journey creates an idempotent run and renders durable stages', async () => {
  assert.ok(baseUrl, 'browser harness must provide CONTENTOS_OPERATOR_URL');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const projectResponse = await page.request.post(`${baseUrl}/api/v1/projects`, { data: { name: `Production browser ${Date.now()}` } }); assert.ok(projectResponse.ok());
    const project = await projectResponse.json() as { id: string };
    await page.goto(`${baseUrl}/projects/${project.id}/production`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '内容生产编排' }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByLabel('运行名称').fill('浏览器闭环运行');
    await page.getByRole('button', { name: '创建生产运行' }).click();
    await page.getByText('生产运行已创建', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('link', { name: '打开编排详情' }).click();
    await page.getByText('阶段进度', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('list').getByText('数字人', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const content = page.getByRole('listitem').filter({ hasText: '内容' });
    await content.getByRole('button', { name: '开始阶段' }).click();
    await page.getByText(/RUNNING/).first().waitFor({ state: 'visible', timeout: 20_000 });
  } finally { await browser.close(); }
});
