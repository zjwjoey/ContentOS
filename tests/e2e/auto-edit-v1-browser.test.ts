import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDatabase } from '../../packages/database/src/index.js';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR;
const databaseUrl = process.env.CONTENTOS_BROWSER_DATABASE_URL;

test('Auto Edit V1 browser flow completes Script and Random local editing', async () => {
  assert.ok(baseUrl, 'browser harness must provide CONTENTOS_OPERATOR_URL');
  assert.ok(fixtureDir, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_DIR');
  assert.ok(databaseUrl, 'browser harness must provide CONTENTOS_BROWSER_DATABASE_URL');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const db = await createDatabase(databaseUrl);
  const brandingFixture = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;
  assert.ok(brandingFixture, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_VIDEO');
  let presetId = '';
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    const created = await page.request.post(`${baseUrl}/api/v1/projects`, { data: { name: `自动剪辑浏览器验收 ${Date.now()}`, metadata: { createdBy: 'browser' } } });
    assert.equal(created.status(), 201, await created.text());
    const projectId = (await created.json() as { id: string }).id;
    assert.ok(projectId);
    await page.goto(`${baseUrl}/settings/video-presets`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.locator('input[aria-label="品牌视频文件"]').setInputFiles({ name: 'MIZAN-logo.mp4', mimeType: 'video/mp4', buffer: await readFile(brandingFixture) });
    try { await page.getByText('品牌视频已上传。').waitFor({ state: 'visible', timeout: 30_000 }); } catch (error) { throw new Error(`品牌视频上传失败：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    const uploadedBranding = await page.request.get(`${baseUrl}/api/v1/video/preset-assets`); assert.equal(uploadedBranding.status(), 200); const uploadedBrandingItems = (await uploadedBranding.json() as { items: Array<{ id: string; originalName: string }> }).items; const brandingAssetId = uploadedBrandingItems.find((item) => item.originalName === 'MIZAN-logo.mp4')?.id; assert.ok(brandingAssetId);
    const presetCreated = await page.request.post(`${baseUrl}/api/v1/video/presets`, { data: { name: `浏览器模板 ${Date.now()}`, description: '浏览器模板验收', editModeDefault: 'SCRIPT', minClipDurationMs: 2000, maxClipDurationMs: 5000, preferUnusedMedia: true } });
    assert.equal(presetCreated.status(), 201, await presetCreated.text());
    presetId = (await presetCreated.json() as { id: string }).id;
    await page.reload({ waitUntil: 'domcontentloaded' });
    const presetCard = page.locator('.preset-list .card').filter({ hasText: '浏览器模板验收' }).first();
    await presetCard.getByRole('button', { name: '选择片头' }).click();
    await page.getByRole('button', { name: '选择 MIZAN-logo.mp4', exact: true }).click();
    await page.getByRole('button', { name: '确认', exact: true }).click();
    assert.equal(await presetCard.getByText('MIZAN-logo.mp4', { exact: true }).count(), 1);
    await presetCard.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('模板已保存。').waitFor({ state: 'visible', timeout: 10_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedPresetCard = page.locator('.preset-list .card').filter({ hasText: '浏览器模板验收' }).first();
    await reloadedPresetCard.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await reloadedPresetCard.getByText('MIZAN-logo.mp4', { exact: true }).count(), 1);

    const director = new DirectorV1Service(db);
    const brief = await director.createBrief(projectId, { topic: '中文零售观察', targetPlatform: '短视频', channelPositioning: '商业观察', targetDurationSeconds: 30, contentType: '知识', audience: '经营者', coreThesis: '先验证再扩张', tone: '清晰', ctaGoal: '收藏', referenceMaterial: '浏览器验收素材', mustInclude: ['零售'], mustAvoid: ['夸大'], requirements: {}, createdBy: 'browser' });
    const aggregate = await director.createScript(projectId, brief.id);
    const draft = await director.createScriptRevision(projectId, aggregate.id, { origin: 'MANUAL', title: '五句中文脚本', titleCandidates: ['五句中文脚本'], coverText: '五句中文脚本', topicKeywords: ['零售', '门店'], hook: '欧洲零售扩张。', body: '折扣门店增长？数据图表变化！顾客购物增加。', cta: '收藏。', createdBy: 'browser' });
    await director.acceptScript(projectId, draft.id);

    await page.goto(`${baseUrl}/projects/${projectId}/video`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('剪辑模板').selectOption(presetId);
    await page.getByText(/固定片头/).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: /按脚本剪辑/ }).first().click();
    await page.getByText(/当前项目脚本 · 版本 1 · 已载入 5 句话/).waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByRole('button', { name: /下一步：选择素材/ }).click();
    await page.getByLabel('素材文件夹').fill(fixtureDir);
    await page.getByRole('button', { name: '扫描文件夹' }).click();
    try { await page.getByText(/扫描完成：可用 5 个视频/).waitFor({ state: 'visible', timeout: 45_000 }); }
    catch (error) { throw new Error(`素材扫描未完成：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    await page.locator('.media-browser .media-card').nth(0).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByRole('button', { name: /取消选择/ }).first().click();
    await page.getByRole('button', { name: '编辑素材信息' }).first().click();
    await page.getByLabel('添加标签').fill('浏览器验收');
    await page.getByLabel('添加标签').press('Enter');
    await page.getByRole('button', { name: '保存' }).click();
    await page.getByRole('button', { name: '下一步：自动剪辑' }).click();
    await page.getByRole('button', { name: '开始自动剪辑' }).click();
    const sentenceClips = page.locator('.review-row').filter({ hasNotText: '片头' }).filter({ hasNotText: '片尾' }).getByRole('button', { name: '选择镜头' });
    await sentenceClips.nth(4).waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await sentenceClips.count(), 5);
    const initialPreview = page.locator('video.clip-preview');
    await initialPreview.waitFor({ state: 'visible', timeout: 15_000 });
    const initialSource = await initialPreview.getAttribute('src');
    const clipPreview = page.locator('video.clip-preview');
    let selectedIndex = -1;
    let clipSource: string | null = null;
    for (let index = 0; index < await sentenceClips.count(); index += 1) {
      await sentenceClips.nth(index).click();
      await clipPreview.waitFor({ state: 'visible', timeout: 15_000 });
      const candidate = await clipPreview.getAttribute('src');
      if (candidate && candidate !== initialSource) {
        selectedIndex = index;
        clipSource = candidate;
        break;
      }
    }
    assert.notEqual(selectedIndex, -1, 'sentence selection should update the source preview');
    assert.ok(clipSource);
    const range = await page.request.get(new URL(clipSource, baseUrl).toString(), { headers: { Range: 'bytes=0-15' } });
    assert.equal(range.status(), 206, `${range.status()} ${clipSource} ${await range.text()}`);
    const contentReviewCheckboxes = page.locator('.review-row').filter({ hasNotText: '片头' }).filter({ hasNotText: '片尾' }).locator('input[type="checkbox"]');
    for (const index of [0, 2, 4]) await contentReviewCheckboxes.nth(index).check();
    await page.getByRole('button', { name: '重新匹配' }).first().click();
    await page.getByText('新的剪辑版本已创建。').waitFor({ state: 'visible', timeout: 15_000 });
    await page.getByText('查看历史版本').waitFor({ state: 'visible', timeout: 15_000 });

    await page.getByText('重新生成剪辑').click();
    await page.locator('.mode-card').nth(1).click();
    await page.getByRole('button', { name: '生成剪辑方案' }).click();
    const randomSentenceClips = page.locator('.review-row').filter({ hasNotText: '片头' }).filter({ hasNotText: '片尾' }).getByRole('button', { name: '选择镜头' });
    await randomSentenceClips.nth(4).waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await randomSentenceClips.count(), 5);
    await randomSentenceClips.nth(2).click();
    await page.getByRole('button', { name: '随机换一个' }).click();
    await page.getByText('待提交调整：1 项').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '保存镜头调整' }).click();
    await page.getByText('新的剪辑版本已创建。').waitFor({ state: 'visible', timeout: 15_000 });
    const manifests = await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/video/manifests`);
    assert.equal(manifests.status(), 200);
    const currentManifest = ((await manifests.json()) as { items: Array<{ id: string; status: string }> }).items.find((item) => item.status === 'PERSISTED');
    assert.ok(currentManifest);
    await page.getByRole('button', { name: '下一步：生成成片', exact: true }).click();
    await page.getByText('片头：MIZAN-logo.mp4 · 片尾：未设置', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    const renderButton = page.getByRole('button', { name: '生成成片', exact: true });
    assert.equal(await renderButton.count(), 1);
    assert.equal(await renderButton.isEnabled(), true, await page.locator('body').innerText());
    const outputVideo = page.locator('.card').filter({ hasText: '成片预览' }).locator('video');
    assert.equal(await outputVideo.count(), 0);
    await renderButton.click();
    try { await outputVideo.waitFor({ state: 'visible', timeout: 60_000 }); }
    catch (error) { throw new Error(`成片未生成：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    await page.getByText('视频生成完成').waitFor({ state: 'visible', timeout: 15_000 });
    const outputSrc = await outputVideo.getAttribute('src');
    assert.ok(outputSrc);
    assert.match(outputSrc, new RegExp(`/api/v1/projects/${projectId}/assets/.+/content`));
    assert.equal(outputSrc.includes('/api/v1/video/local-media/content'), false);
    const snapshot = await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/video`);
    assert.equal(snapshot.status(), 200);
    assert.equal(((await snapshot.json()) as { currentRender?: { manifestId?: string } }).currentRender?.manifestId, currentManifest.id);
    const persistedManifest = await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/video/manifests/${currentManifest.id}`);
    assert.equal(persistedManifest.status(), 200); const persistedManifestBody = await persistedManifest.json() as { manifest: { timeline: Array<{ role?: string; assetId: string }> } }; assert.equal(persistedManifestBody.manifest.timeline.find((clip) => clip.role === 'INTRO')?.assetId, brandingAssetId);

    const body = await page.locator('body').innerText();
    for (const forbidden of ['Manifest Revision', 'Render Job', 'Standalone', 'Inspector', 'Generate Plan', 'Workspace', 'Video Worker', 'Random Montage']) assert.equal(body.includes(forbidden), false, `ordinary Video UI must hide ${forbidden}`);
  } finally {
    if (presetId) await db.query('delete from video_edit_presets where id = $1', [presetId]);
    await db.end();
    await browser.close();
  }
});
