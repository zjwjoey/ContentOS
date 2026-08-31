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

async function openOperatorHome(page: Page, url: string): Promise<void> {
  const projectsLoaded = page.waitForResponse((response) => response.url().includes('/api/v1/projects?') && response.status() === 200);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await projectsLoaded;
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
  page.on('request', (request) => { if (request.url().includes('/video/jobs')) console.log(`VIDEO_JOB_REQUEST ${request.postData() || ''}`); });
  try {
    await openOperatorHome(page, baseUrl);
    await page.getByRole('textbox', { name: /项目名称/ }).fill(`Browser flow ${Date.now()}`);
    await page.getByRole('button', { name: '创建并进入项目总控' }).click();
    try { await page.getByTestId('project-center').waitFor({ timeout: 10_000 }); }
    catch (error) { throw new Error(`Project Center did not load: ${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    const projectId = new URL(page.url()).pathname.split('/')[2];
    assert.ok(projectId, 'project navigation must include the created project id');

    await page.getByRole('link', { name: /^Assets/ }).click();
    await page.getByLabel('选择文件').setInputFiles(fixtureVideos);
    await waitForText(page, 'source.mp4');
    try { await page.getByText(/可用 · VIDEO/).first().waitFor({ state: 'visible', timeout: 30_000 }); }
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
    try { await page.getByRole('button', { name: '批准 Storyboard' }).waitFor({ state: 'visible', timeout: 30_000 }); }
    catch (error) { throw new Error(`Storyboard generation did not become actionable: ${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    await page.getByRole('button', { name: '批准 Storyboard' }).click();
    await page.getByRole('link', { name: '进入 Video' }).click();

    const sourceCheckboxes = page.locator('fieldset input[type="checkbox"]');
    await sourceCheckboxes.nth(1).waitFor({ state: 'attached', timeout: 30_000 });
    for (let index = 0; index < await sourceCheckboxes.count(); index += 1) await sourceCheckboxes.nth(index).check();
    await page.getByLabel('视频规划器').selectOption('STORYBOARD');
    await page.getByRole('button', { name: '创建渲染 Job' }).click();
    try { await page.locator('video').waitFor({ state: 'visible', timeout: 45_000 }); }
    catch (error) { throw new Error(`Video render did not become playable: ${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
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

    await page.goto(`${baseUrl}/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await waitForText(page, 'PUBLISHED');

    await page.getByRole('link', { name: /^Review Analytics/ }).click();
    await page.getByTestId('review-post').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('collect-metrics').first().click();
    await page.getByText(/播放 \d+ · 点赞 \d+/, { exact: false }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('analyze-review').first().click();
    await page.getByText('最新复盘').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('HIGH · 强化互动钩子', { exact: false }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByTestId('collect-metrics').first().click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('review-post').first().getByText(/播放 \d+ · 点赞 \d+/, { exact: false }).count(), 1, 'idempotent metric collection must keep one latest snapshot view');

    await page
      .getByRole('link', { name: /^Publisher/ })
      .first()
      .click();
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

test('operator browser completes the Benchmark Library flow', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await openOperatorHome(page, baseUrl);
    await page.getByRole('textbox', { name: /项目名称/ }).fill(`Benchmark browser ${Date.now()}`);
    await page.getByRole('button', { name: '创建并进入项目总控' }).click();
    try { await page.getByTestId('project-center').waitFor({ timeout: 10_000 }); }
    catch (error) { throw new Error(`Project Center did not load: ${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    const projectId = new URL(page.url()).pathname.split('/')[2];
    await page.getByRole('link', { name: 'Benchmark', exact: true }).click();
    await page.getByLabel('账号名称').fill('对标账号');
    await page.getByLabel('定位').fill('效率工具');
    await page.getByLabel('分类').fill('科技');
    await page.getByLabel('关键词').fill('效率,工具');
    await page.getByRole('button', { name: '保存账号' }).click();
    await page.getByText('对标账号', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByLabel('对标账号').selectOption({ index: 1 });
    await page.getByLabel('标题').fill('可复用的开场结构');
    await page.getByLabel('文案 / 内容').fill('先给结论，再解释三步方法。');
    await page.getByRole('button', { name: '保存内容' }).click();
    const content = page.getByRole('listitem').filter({ hasText: '可复用的开场结构' });
    await content.getByRole('button', { name: 'AI 分析' }).click();
    await content.getByText('分析 Job：SUCCEEDED').waitFor({ state: 'visible', timeout: 30_000 });
    await content.getByText('最新分析').waitFor({ state: 'visible', timeout: 15_000 });
    await content.getByRole('button', { name: '作为 Director Reference' }).click();
    await waitForText(page, '已作为 Director Reference 绑定到项目');
    assert.ok(projectId, 'benchmark flow remains project scoped');
  } finally { await browser.close(); }
});

test('operator browser completes Standalone Quick Edit upload, adjustment and render journeys', async () => {
  assert.ok(baseUrl, 'test:browser must start an isolated operator');
  assert.equal(fixtureVideos.length, 4, 'test:browser must provide four playable upload fixtures');
  assert.ok(fixtureAudio, 'test:browser must provide an audio fixture');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/video/quick-edit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '创建草稿会话' }).click();
    await page.getByLabel('上传视频 / 配音').setInputFiles([...fixtureVideos, fixtureAudio]);
    await page.getByText('source.mp4', { exact: false }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByText('已就绪', { exact: false }).first().waitFor({ state: 'visible', timeout: 45_000 });
    const voice = page.getByRole('combobox', { name: '主配音' });
    const durationMode = page.getByRole('combobox', { name: '目标时长' });
    assert.equal(await voice.isDisabled(), false, 'voice must be selectable before planning');
    assert.equal(await durationMode.isDisabled(), false, 'planner settings must be editable before planning');
    await voice.selectOption({ label: 'voice.wav' });
    await page.getByText('主配音已选择。').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: 'Generate Plan' }).click();
    await page.getByText('Manifest 计划已生成，规划设置已锁定。').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByLabel('Manifest 时间线').waitFor({ state: 'visible', timeout: 30_000 });
    const timelineButtons = page.getByLabel('Manifest 时间线').getByRole('button');
    const timelineCount = await timelineButtons.count();
    assert.ok(timelineCount >= 3, `auto voice duration must produce enough clips for all adjustments (got ${timelineCount}: ${await page.getByLabel('Manifest 时间线').innerText()}; body: ${await page.locator('body').innerText()})`);
    assert.equal(await voice.isDisabled(), true, 'voice must lock after planning');
    assert.equal(await durationMode.isDisabled(), true, 'planner settings must lock after planning');

    const currentRevision = async (): Promise<number> => {
      const selected = await page.getByLabel('Manifest Revision').locator('option:checked').textContent();
      const match = selected?.match(/v(\d+)/);
      if (!match) throw new Error(`Unable to read selected Manifest revision: ${selected}`);
      return Number(match[1]);
    };
    const waitForRevision = async (previous: number): Promise<number> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const next = await currentRevision();
        if (next > previous) return next;
        await page.waitForTimeout(100);
      }
      throw new Error(`Manifest revision did not advance beyond v${previous}`);
    };

    let revision = await currentRevision();
    await page.getByRole('button', { name: 'REROLL' }).click();
    revision = await waitForRevision(revision);
    const replacementPicker = page.getByLabel('替换素材');
    const replacementValues = await replacementPicker.locator('option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
    assert.ok(replacementValues.length > 0, 'a replacement READY asset must be available');
    let replacementSucceeded = false;
    for (const replacementAssetId of replacementValues) {
      await replacementPicker.selectOption(replacementAssetId);
      const replaceResponse = page.waitForResponse((response) => response.url().includes('/api/v1/video/quick-edits/') && response.url().endsWith('/adjustments') && response.request().method() === 'POST', { timeout: 15_000 });
      await page.getByRole('button', { name: 'REPLACE' }).click();
      const replaceResult = await replaceResponse;
      if (replaceResult.status() === 201) { replacementSucceeded = true; break; }
      const replaceBody = await replaceResult.text();
      if (replaceResult.status() !== 409 || !replaceBody.includes('Adjacent duplicate clips are not allowed')) throw new Error(`REPLACE failed with ${replaceResult.status()}: ${replaceBody}`);
    }
    assert.equal(replacementSucceeded, true, 'REPLACE must find a valid non-adjacent replacement asset');
    revision = await waitForRevision(revision);
    await page.getByRole('button', { name: 'TRIM' }).click();
    revision = await waitForRevision(revision);
    await page.getByLabel('Manifest 时间线').getByRole('button').nth(1).click();
    await page.getByRole('button', { name: 'REORDER' }).click();
    revision = await waitForRevision(revision);
    await page.getByRole('button', { name: 'REMOVE' }).click();
    revision = await waitForRevision(revision);
    assert.ok(revision >= 6, `all five adjustments must create revisions, got v${revision}`);
    const revisionPicker = page.getByLabel('Manifest Revision');
    const currentManifestValue = await revisionPicker.inputValue();
    await revisionPicker.locator('option').nth(2).waitFor({ state: 'attached', timeout: 15_000 });
    const historicalManifestValue = await revisionPicker.locator('option').nth(2).getAttribute('value');
    assert.ok(historicalManifestValue && historicalManifestValue !== currentManifestValue, 'a historical Manifest revision must be available');
    await revisionPicker.selectOption(historicalManifestValue);
    await page.getByText('历史版本仅供查看，但仍可精确渲染。').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await revisionPicker.inputValue(), historicalManifestValue);
    for (const name of ['TRIM', 'REMOVE', 'REORDER', 'REPLACE', 'REROLL']) assert.equal(await page.getByRole('button', { name }).isDisabled(), true, `${name} must be disabled for a historical revision`);
    assert.equal(await page.getByRole('button', { name: 'Render 成品' }).isDisabled(), false, 'historical revisions must remain renderable');
    await revisionPicker.selectOption(currentManifestValue);
    await page.getByText(`Manifest v${revision}`).waitFor({ state: 'visible', timeout: 15_000 });
    for (const name of ['TRIM', 'REMOVE', 'REORDER', 'REROLL']) assert.equal(await page.getByRole('button', { name }).isDisabled(), false, `${name} must be enabled for the current revision`);
    await page.getByRole('button', { name: 'Render 成品' }).click();
    await page.getByText('Render 状态：SUCCEEDED').waitFor({ state: 'visible', timeout: 60_000 });
    await page.getByText('Render 输出成片').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await page.locator('video').count() >= 1, true, 'rendered output video should be visible');
  } finally {
    await browser.close();
  }
});
