import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';

const baseUrl = process.env.CONTENTOS_OPERATOR_URL;
const fixtureDir = process.env.CONTENTOS_BROWSER_FIXTURE_DIR;
const fixtureVideos = process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS ? JSON.parse(process.env.CONTENTOS_BROWSER_FIXTURE_VIDEOS) as string[] : [];
const fixtureAudio = process.env.CONTENTOS_BROWSER_FIXTURE_AUDIO;

async function waitForPlan(page: Page, id: string, expected: 'READY' | 'RENDERED' = 'READY'): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(`${baseUrl}/api/v1/edit/script-plans/${encodeURIComponent(id)}`);
    assert.equal(response.status(), 200, await response.text());
    const plan = await response.json() as Record<string, unknown>;
    if (plan.status === 'FAILED') throw new Error(`V2 方案失败：${JSON.stringify(plan)}`);
    if (plan.status === expected) return plan;
    await page.waitForTimeout(350);
  }
  throw new Error(`V2 方案未在限定时间内达到 ${expected}：${id}`);
}

test('Script Editing V2 browser flows cover local, hybrid, reroll, BGM and history', async () => {
  assert.ok(baseUrl && fixtureDir && fixtureAudio && fixtureVideos.length >= 3, 'V2 browser harness must provide fixtures');
  const browser = await chromium.launch({ headless: true, ...(process.env.CONTENTOS_BROWSER_EXECUTABLE ? { executablePath: process.env.CONTENTOS_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  const localRoot = join(fixtureDir!, 'v2-local');
  const hybridRoot = join(fixtureDir!, 'v2-hybrid');
  const musicPath = join(fixtureDir!, 'v2-bgm.wav');
  await mkdir(localRoot, { recursive: true }); await mkdir(hybridRoot, { recursive: true });
  await copyFile(fixtureVideos[0]!, join(localRoot, 'MIZAN-store.mp4'));
  await copyFile(fixtureVideos[1]!, join(localRoot, 'MIZAN-office.mp4'));
  await copyFile(fixtureVideos[2]!, join(localRoot, 'retail-shelf.mp4'));
  for (const [index, source] of fixtureVideos.slice(3).entries()) await copyFile(source!, join(localRoot, `retail-extra-${index + 1}.mp4`));
  for (let index = 0; index < 6; index += 1) await copyFile(fixtureVideos[index % fixtureVideos.length]!, join(localRoot, `reroll-pool-${index + 1}.mp4`));
  await copyFile(fixtureVideos[0]!, join(hybridRoot, 'MIZAN-only.mp4'));
  await copyFile(fixtureAudio!, musicPath);
  try {
    // Flow A: the actual V2 page generates and previews a local-only plan.
    await page.goto(`${baseUrl}/edit/script/v2`, { waitUntil: 'domcontentloaded' });
    const scriptInput = page.locator('#v2-script');
    await scriptInput.fill('');
    await scriptInput.pressSequentially('最近看到一些针对MIZAN的不同声音。\n但是商业合作本来就会有不同观点。\n欢迎大家到店交流。\n市场会慢慢给出答案。');
    await page.locator('#v2-voice').fill(fixtureAudio!);
    await page.locator('input[placeholder="本地素材文件夹"]').first().fill(localRoot);
    const createButton = page.getByRole('button', { name: '生成剪辑方案' });
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('生成剪辑方案')); return Boolean(button && !(button as HTMLButtonElement).disabled); });
    await createButton.click();
    try { await page.getByRole('heading', { name: '剪辑方案' }).waitFor({ state: 'visible', timeout: 10_000 }); }
    catch (error) { throw new Error(`V2 local plan UI 未出现：${await page.locator('body').innerText()}\n${error instanceof Error ? error.message : String(error)}`); }
    await page.locator('img[alt="MIZAN-store.mp4"]').first().waitFor({ state: 'visible', timeout: 30_000 });
    const localPlan = await page.evaluate(() => JSON.parse(window.localStorage.getItem('contentos-script-v2-plan') || '{}') as { id?: string });
    assert.ok(localPlan.id);
    const ready = await waitForPlan(page, localPlan.id!);
    const resolved = ready.resolvedPlan as { scenes: Array<{ clipSlots: Array<{ id: string; asset?: { path: string }; locked?: boolean }> }> };
    const first = resolved.scenes[0]!.clipSlots[0]!;
    assert.ok(first.asset?.path);
    const beforeLockPath = first.asset.path;
    const lockResponse = await page.request.patch(`${process.env.CONTENTOS_API_URL || baseUrl}/api/v1/edit/script-plans/${localPlan.id}/clips/${encodeURIComponent(first.id)}`, { data: { locked: true } });
    const lockBody = await lockResponse.text();
    assert.equal(lockResponse.status(), 200, lockBody);
    const another = resolved.scenes.flatMap((scene) => scene.clipSlots).find((clip) => clip.id !== first.id && !clip.locked);
    if (another) {
      const rerollResponse = await page.request.post(`${process.env.CONTENTOS_API_URL || baseUrl}/api/v1/edit/script-plans/${localPlan.id}/reroll`, { data: { clipId: another.id, localOnly: true } });
      const rerollBody = await rerollResponse.text();
      assert.equal(rerollResponse.status(), 200, rerollBody);
      const rerolled = await page.request.get(`${process.env.CONTENTOS_API_URL || baseUrl}/api/v1/edit/script-plans/${localPlan.id}`);
      const rerolledBody = await rerolled.json() as { resolvedPlan: typeof ready.resolvedPlan };
      const retained = (rerolledBody.resolvedPlan as typeof resolved).scenes.flatMap((scene) => scene.clipSlots).find((clip) => clip.id === first.id);
      assert.equal(retained?.asset?.path, beforeLockPath, 'locked V2 clip must survive a reroll');
      await waitForPlan(page, localPlan.id!, 'READY');
    }
    await page.goto(`${baseUrl}/edit/script/v2`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '剪辑方案' }).waitFor({ state: 'visible', timeout: 15_000 });
    const renderButton = page.getByRole('button', { name: '开始剪辑' });
    assert.equal(await renderButton.count(), 1);
    await page.waitForFunction(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('开始剪辑')); return Boolean(button && !(button as HTMLButtonElement).disabled); }, undefined, { timeout: 15_000 });
    await renderButton.click();
    await waitForPlan(page, localPlan.id!, 'RENDERED');

    // Flow B: a deliberately small local pool forces the fake Pexels provider
    // to contribute fallback clips while retaining the authentic local clip.
    const hybridResponse = await page.request.post(`${baseUrl}/api/v1/edit/script-plans`, { data: { workspaceId: 'workspace-local', script: 'MIZAN门店正在发展。\n商业会议需要新的视角。\n欢迎关注后续消息。', voicePath: fixtureAudio, sourceRoots: [hybridRoot], usePexels: true, template: 'COMMERCIAL_OPINION', pace: 'NORMAL', shotDensity: 'MEDIUM', backgroundMusicMode: 'NONE' } });
    assert.equal(hybridResponse.status(), 201, await hybridResponse.text());
    const hybridPlan = await hybridResponse.json() as { id: string };
    const hybridReady = await waitForPlan(page, hybridPlan.id);
    const hybridClips = (hybridReady.resolvedPlan as { scenes: Array<{ clipSlots: Array<{ asset?: { source?: string } }> }> }).scenes.flatMap((scene) => scene.clipSlots);
    assert.ok(hybridClips.some((clip) => clip.asset?.source === 'LOCAL'));
    assert.ok(hybridClips.some((clip) => clip.asset?.source === 'FAKE_PEXELS' || clip.asset?.source === 'PEXELS'));

    // Flow D: specified local BGM is accepted and carried into the rendered plan.
    const bgmResponse = await page.request.post(`${baseUrl}/api/v1/edit/script-plans`, { data: { workspaceId: 'workspace-local', script: 'MIZAN门店开业。\n欢迎到店体验。', voicePath: fixtureAudio, sourceRoots: [localRoot], template: 'STORE_PROMOTION', backgroundMusicMode: 'SPECIFIED', backgroundMusic: { path: musicPath, volume: 0.08, loop: true, ducking: { enabled: true, musicVolume: 0.04 } } } });
    assert.equal(bgmResponse.status(), 201, await bgmResponse.text());
    const bgmPlan = await bgmResponse.json() as { id: string };
    const bgmReady = await waitForPlan(page, bgmPlan.id);
    const bgm = (bgmReady.resolvedPlan as { audioPlan?: { path?: string } }).audioPlan;
    assert.ok(bgm?.path && bgm.path.toLocaleLowerCase().endsWith('v2-bgm.wav'));

    // Flow E: history shows V2 summaries without exposing internal JSON terms.
    await page.goto(`${baseUrl}/edit/history`, { waitUntil: 'domcontentloaded' });
    await page.getByText('脚本剪辑方案').waitFor({ state: 'visible', timeout: 15_000 });
    const historyText = await page.locator('body').innerText();
    assert.equal(historyText.includes('EditorialPlanV1'), false);
    assert.equal(historyText.includes('Manifest ID'), false);
  } finally {
    await browser.close();
  }
});
