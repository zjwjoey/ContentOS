import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, type Page } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureAudio = process.env.CONTENTOS_BROWSER_FIXTURE_AUDIO;
const fixtureVideo = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEO;

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(latest)}`);
}

async function json<T>(response: Awaited<ReturnType<Page['request']['get']>>): Promise<T> {
  assert.ok(response.ok(), `${response.status()} ${await response.text()}`);
  return response.json() as Promise<T>;
}

test('Digital Human V1 browser flow completes fake speech, avatar, preflight, blocked UI and Edit Manifest handoff', async () => {
  assert.ok(baseUrl, 'browser harness must provide CONTENTOS_OPERATOR_URL');
  assert.ok(fixtureAudio, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_AUDIO');
  assert.ok(fixtureVideo, 'browser harness must provide CONTENTOS_BROWSER_FIXTURE_VIDEO');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  try {
    const projectResponse = await page.request.post(`${baseUrl}/api/v1/projects`, { data: { name: `Digital Human browser ${Date.now()}`, metadata: { createdBy: 'digital-human-browser' } } });
    const project = await json<{ id: string }>(projectResponse);
    const projectId = project.id;
    await page.goto(`${baseUrl}/projects/${projectId}/avatar`, { waitUntil: 'domcontentloaded' });
    await page.getByText('运行能力', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByText(/数字人：READY/, { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });

    const createVoice = page.locator('details').filter({ hasText: '创建 Voice Profile' });
    await createVoice.locator('summary').click();
    await createVoice.getByLabel('名称').fill('Browser Voice');
    await createVoice.getByLabel('上传参考音频').setInputFiles(fixtureAudio);
    await page.getByText('参考音频已导入并选中。', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await createVoice.getByRole('button', { name: '创建音色' }).click();
    await page.getByText('音色已创建。', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });

    await page.getByLabel('文案').fill('浏览器数字人验收。');
    await page.getByRole('button', { name: '生成配音 / 测试音色' }).click();
    const speech = await waitFor(async () => json<{ items: Array<{ id: string; status: string; outputAssetId?: string | null }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/speech-generations`)), (value) => value.items.some((item) => item.status === 'SUCCEEDED' && Boolean(item.outputAssetId)), 'speech generation');
    const speechGeneration = speech.items.find((item) => item.status === 'SUCCEEDED' && item.outputAssetId);
    assert.ok(speechGeneration?.outputAssetId);
    await page.getByText('SUCCEEDED', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });

    const createAvatar = page.locator('details').filter({ hasText: '创建 Avatar Profile' });
    await createAvatar.locator('summary').click();
    await createAvatar.getByLabel('人物名称').fill('Browser Avatar');
    await createAvatar.getByLabel('归属人').fill('Browser QA');
    await createAvatar.getByRole('button', { name: '创建人物' }).click();
    await page.getByText('人物 Profile 已创建，请继续添加底片。', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });

    const avatarProfile = (await json<{ items: Array<{ id: string; status: string }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatars`))).items.find((item) => item.id);
    assert.ok(avatarProfile);
    const avatarCard = page.locator('.compact-card').filter({ hasText: '人物库管理' });
    await avatarCard.getByLabel('状态').selectOption('READY');
    await avatarCard.getByRole('button', { name: '保存人物 Profile' }).click();
    await page.getByText('人物 Profile 已保存。', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });

    const createClip = page.locator('details').filter({ hasText: '添加人物底片' });
    await createClip.locator('summary').click();
    await createClip.getByLabel('上传人物底片').setInputFiles(fixtureVideo);
    await page.getByText('人物底片已导入并选中。', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 });
    await createClip.getByLabel('底片名称').fill('Browser Front Clip');
    const clipCreateResponsePromise = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/v1/projects/${projectId}/digital-human/avatar-clips`), { timeout: 20_000 });
    await createClip.getByRole('button', { name: '添加底片' }).click();
    const clipCreateResponse = await clipCreateResponsePromise;
    assert.ok(clipCreateResponse.ok(), `Avatar Clip creation failed: ${clipCreateResponse.status()} ${await clipCreateResponse.text()}`);
    const avatarsAfterClip = await waitFor(async () => json<{ items: Array<{ id: string; clips: Array<{ id: string; status: string }> }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatars`)), (value) => value.items.some((item) => item.id === avatarProfile.id && item.clips.length > 0), 'avatar clip creation');
    const avatarWithClip = avatarsAfterClip.items.find((item) => item.id === avatarProfile.id);
    assert.ok(avatarWithClip?.clips[0]);
    const avatarSection = page.locator('section.card').filter({ has: page.getByRole('heading', { name: '② 数字人' }) });
    await avatarSection.locator('select').last().selectOption(avatarWithClip.clips[0].id);
    await page.getByLabel('配音 Asset ID').fill(speechGeneration.outputAssetId);

    const preflight = await json<{ status: string; checks: Array<{ status: string; code: string }> }>(await page.request.post(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatar-generations/preflight`, { data: { avatarProfileId: avatarProfile.id, avatarClipId: avatarWithClip.clips[0].id, speechAssetId: speechGeneration.outputAssetId } }));
    assert.equal(preflight.status, 'READY');
    assert.ok(preflight.checks.some((check) => check.code === 'AVATAR_PROVIDER_HEALTHY' && check.status === 'READY'));

    await page.getByRole('button', { name: '生成数字人' }).click();
    await page.getByText('生成前检查：READY', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.getByLabel('配音 Asset ID').fill('changed-after-preflight');
    await page.getByText('生成前检查：READY', { exact: true }).waitFor({ state: 'hidden', timeout: 5_000 });
    await page.getByLabel('配音 Asset ID').fill(speechGeneration.outputAssetId);
    const avatarGeneration = await waitFor(async () => json<{ items: Array<{ id: string; status: string; outputAssetId?: string | null }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatar-generations`)), (value) => value.items.some((item) => item.status === 'SUCCEEDED' && Boolean(item.outputAssetId)), 'avatar generation');
    const generated = avatarGeneration.items.find((item) => item.status === 'SUCCEEDED' && item.outputAssetId);
    assert.ok(generated?.outputAssetId);
    await page.locator('video').first().waitFor({ state: 'visible', timeout: 30_000 });

    const beforeBlockedGenerations = (await json<{ items: Array<{ id: string }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatar-generations`))).items.length;
    const blockedPage = await browser.newPage();
    await blockedPage.route('**/api/v1/projects/*/digital-human/capabilities', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ speech: { status: 'READY', providerId: 'fake-speech' }, avatar: { status: 'UNAVAILABLE', providerId: 'hzagent' }, mediaStaging: { status: 'UNAVAILABLE' } }) }));
    await blockedPage.goto(`${baseUrl}/projects/${projectId}/avatar`, { waitUntil: 'domcontentloaded' });
    await blockedPage.getByText(/数字人：UNAVAILABLE/, { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
    const blockedAvatarSection = blockedPage.locator('section.card').filter({ has: blockedPage.getByRole('heading', { name: '② 数字人' }) });
    await blockedAvatarSection.locator('select').first().selectOption(avatarProfile.id);
    await blockedAvatarSection.locator('select').last().selectOption(avatarWithClip.clips[0].id);
    await blockedPage.getByLabel('配音 Asset ID').fill(speechGeneration.outputAssetId);
    const blockedGenerateButton = blockedPage.getByRole('button', { name: '生成数字人' });
    assert.equal(await blockedGenerateButton.isDisabled(), true, 'Avatar generation must be disabled when provider capability is UNAVAILABLE');
    const afterBlockedGenerations = (await json<{ items: Array<{ id: string }> }>(await blockedPage.request.get(`${baseUrl}/api/v1/projects/${projectId}/digital-human/avatar-generations`))).items.length;
    assert.equal(afterBlockedGenerations, beforeBlockedGenerations, 'blocked Avatar UI must not create a Generation or Job');
    await blockedPage.close();

    await page.getByRole('button', { name: '进入视频工作台' }).first().click();
    await page.waitForURL(`**/projects/${projectId}/video`, { timeout: 30_000 });
    const manifests = await waitFor(async () => json<{ items: Array<{ id: string; manifest: { canvas: { aspectRatio: string }; audio?: { voiceAssetId?: string }; subtitles?: unknown[]; metadata?: { digitalHumanGenerationId?: string } } }> }>(await page.request.get(`${baseUrl}/api/v1/projects/${projectId}/video/manifests`)), (value) => value.items.some((item) => item.manifest.metadata?.digitalHumanGenerationId === generated.id), 'digital human Edit Manifest');
    const manifest = manifests.items.find((item) => item.manifest.metadata?.digitalHumanGenerationId === generated.id);
    assert.ok(manifest);
    assert.equal(manifest.manifest.canvas.aspectRatio, '9:16');
    assert.equal(manifest.manifest.audio?.voiceAssetId, speechGeneration.outputAssetId);
    assert.ok(manifest.manifest.subtitles && manifest.manifest.subtitles.length > 0);
  } finally {
    await browser.close();
  }
});
