import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Page } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureVideo = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : fixtureVideo ? [fixtureVideo] : [];
const fixtureAudio = process.env.CONTENTOS_BROWSER_FIXTURE_AUDIO;

async function waitForText(page: Page, text: string, timeout = 30_000): Promise<void> {
  await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

async function createAndApprovePublish(page: Page, title: string, description: string) {
  await page.getByLabel('标题').fill(title);
  await page.getByLabel('描述').fill(description);
  await page.getByRole('button', { name: '创建项目发布草稿' }).click();
  const draft = page.getByRole('listitem').filter({ hasText: title });
  await draft.getByRole('link', { name: '前往 Approval Gate' }).click();
  await page.getByRole('button', { name: '批准此 Revision' }).click();
  await page.getByRole('link', { name: 'Publisher', exact: true }).click();
  return page.getByRole('listitem').filter({ hasText: title });
}

test('operator browser completes Fake Publisher success, retry, human-action and reconciliation journeys', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  assert.ok(fixtureVideo, 'test:browser must provide a playable upload fixture');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle');
    await page.getByRole('textbox', { name: /项目名称/ }).fill(`Browser flow ${Date.now()}`);
    await page.locator('form').evaluate((form) => (form as HTMLFormElement).requestSubmit());
    await page.getByTestId('project-center').waitFor({ timeout: 10_000 });
    const projectId = new URL(page.url()).pathname.split('/')[2];
    assert.ok(projectId, 'project navigation must include the created project id');

    await page.getByRole('link', { name: /^Assets/ }).click();
    await page.getByLabel('选择文件').setInputFiles(fixtureVideo);
    await waitForText(page, 'source.mp4');
    try { await page.getByText(/可用 · VIDEO/).waitFor({ state: 'visible', timeout: 30_000 }); }
    catch { throw new Error(`Asset import did not become usable: ${await page.locator('body').innerText()}`); }

    await page.getByRole('link', { name: '进入 Director' }).click();
    await page.getByLabel('选题').fill('浏览器验收选题');
    await page.getByLabel('栏目定位').fill('ContentOS 验收栏目');
    await page.getByLabel('目标受众').fill('短视频运营者');
    await page.getByLabel('核心观点').fill('通过完整产品流验证模块边界。');
    await page.getByLabel('事实依据').fill('本地隔离 Fake 环境。');
    await page.getByLabel('必须包含').fill('验收步骤');
    await page.getByLabel('必须避免').fill('真实平台调用');
    await page.getByRole('button', { name: '保存 Brief 版本' }).click();
    await page.getByRole('button', { name: '生成 Script' }).click();
    await page.getByRole('button', { name: '接受 Script' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: '接受 Script' }).click();
    await page.getByRole('button', { name: '生成 Storyboard Job' }).click();
    await page.getByRole('button', { name: '批准 Storyboard' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: '批准 Storyboard' }).click();
    await page.getByRole('link', { name: '进入 Video' }).click();

    await page.getByRole('button', { name: '创建渲染 Job' }).click();
    await page.locator('video').waitFor({ state: 'visible', timeout: 45_000 });
    await page.getByRole('button', { name: '送往 Approval Gate' }).click();
    await page.getByRole('link', { name: 'Approval Gate' }).click();
    await page.getByRole('button', { name: '批准此 Revision' }).click();
    await waitForText(page, 'APPROVED');

    await page.getByRole('link', { name: /^Publisher/ }).first().click();
    await page.getByRole('button', { name: '创建测试账号' }).click();
    await waitForText(page, '开发模拟结果');
    const success = await createAndApprovePublish(page, '浏览器完整闭环', 'Fake Platform 成功发布');
    await success.getByRole('button', { name: '进入发布队列' }).dblclick();
    await success.getByText('ExternalPost', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await success.getByText('ExternalPost', { exact: false }).count(), 1, 'duplicate queue clicks must not duplicate ExternalPost');

    await page.goto(`${baseUrl}/projects/${projectId}`, { waitUntil: 'networkidle' });
    await waitForText(page, 'PUBLISHED');

    await page.getByRole('link', { name: /^Publisher/ }).first().click();
    const outcome = page.getByLabel('开发模拟结果');
    await outcome.selectOption('NETWORK');
    await waitForText(page, '开发模拟结果已更新');
    const retry = await createAndApprovePublish(page, '浏览器网络重试', '先模拟网络故障，再恢复成功');
    await retry.getByRole('button', { name: '进入发布队列' }).click();
    await retry.getByText('NETWORK', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await outcome.selectOption('SUCCESS');
    await waitForText(page, '开发模拟结果已更新');
    await retry.getByText('ExternalPost', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await retry.getByText('PublishAttempt #', { exact: false }).count(), 2, 'a retry must preserve both PublishAttempt records');

    await outcome.selectOption('AUTH_EXPIRED');
    await waitForText(page, '开发模拟结果已更新');
    const humanAction = await createAndApprovePublish(page, '浏览器登录失效', '登录失效必须等待人工处理');
    await humanAction.getByRole('button', { name: '进入发布队列' }).click();
    await humanAction.getByText('AUTH_EXPIRED').waitFor({ state: 'visible', timeout: 30_000 });
    await humanAction.getByText('NEEDS_HUMAN_ACTION').waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1_500);
    assert.equal(await humanAction.getByText('PublishAttempt #', { exact: false }).count(), 1, 'human-action failures must not retry automatically');

    await outcome.selectOption('BROWSER_CRASH');
    await waitForText(page, '开发模拟结果已更新');
    const reconciling = await createAndApprovePublish(page, '浏览器未知发布状态', '浏览器崩溃后必须走 reconcile');
    await reconciling.getByRole('button', { name: '进入发布队列' }).click();
    await reconciling.getByText('UNKNOWN_EXTERNAL_STATE').waitFor({ state: 'visible', timeout: 30_000 });
    await reconciling.getByText('ExternalPost', { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await reconciling.getByText('PublishAttempt #', { exact: false }).count(), 2, 'reconciliation must preserve publish and reconcile attempts');
    assert.equal(await reconciling.getByText('ExternalPost', { exact: false }).count(), 1, 'reconciliation must confirm exactly one ExternalPost');
  } finally {
    await browser.close();
  }
});

test('operator browser completes Standalone Quick Edit upload, adjustment and render journeys', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  assert.equal(fixtureVideos.length, 4, 'test:browser must provide four playable upload fixtures');
  assert.ok(fixtureAudio, 'test:browser must provide an audio fixture');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/video/quick-edit`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '创建草稿会话' }).click();
    await page.getByLabel('上传视频 / 配音').setInputFiles([...fixtureVideos, fixtureAudio]);
    await page.getByText('source.mp4', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('已就绪', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 });
    await page.getByRole('combobox', { name: '主配音' }).selectOption({ label: 'voice.wav' });
    await page.getByRole('button', { name: 'Generate Plan' }).click();
    await page.getByLabel('Manifest 时间线').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: 'REROLL' }).click();
    await page.getByText('已创建新的 Manifest Revision。').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: 'TRIM' }).click();
    await page.getByText('已创建新的 Manifest Revision。').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('button', { name: 'Render 成品' }).click();
    await page.getByText('Render 状态：SUCCEEDED').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByText('Render 输出成片').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.locator('video').count() >= 1, true, 'rendered output video should be visible');
  } finally {
    await browser.close();
  }
});
