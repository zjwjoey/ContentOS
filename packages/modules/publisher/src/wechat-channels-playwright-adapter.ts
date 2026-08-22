import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext, PublisherFailure } from '../../../contracts/src/index.js';
import { withBrowserSession, type BrowserSessionFactory } from './browser-session.js';
import { InMemoryPublishStateStore, type PublishStateStore } from './douyin-open-api-adapter.js';
import { defaultWeChatChannelsSelectors, type WeChatChannelsSelectorProfile } from './wechat-channels-selectors.js';

export interface WeChatChannelsAdapterOptions { pageUrl?: string; headed?: boolean; allowSubmit?: boolean; evidenceDir?: string; selectorProfile?: WeChatChannelsSelectorProfile; }
function failure(code: PublisherFailure['code'], classification: PublisherFailure['classification'], message: string): PublisherFailure { return { code, classification, message }; }

export class WeChatChannelsPlaywrightAdapter implements PublisherAdapter {
  private readonly options: Required<Omit<WeChatChannelsAdapterOptions, 'selectorProfile'>> & { selectorProfile: WeChatChannelsSelectorProfile };
  private readonly state: PublishStateStore;
  constructor(private readonly browser: BrowserSessionFactory, options: WeChatChannelsAdapterOptions = {}, state: PublishStateStore = new InMemoryPublishStateStore()) {
    this.options = { pageUrl: 'https://channels.weixin.qq.com/platform/post/create', headed: true, allowSubmit: false, evidenceDir: join(process.cwd(), 'artifacts', 'publisher'), selectorProfile: defaultWeChatChannelsSelectors, ...options };
    this.state = state;
  }
  capabilities(): PlatformCapabilityProfile { return { platformId: 'wechat-channels', mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: true }; }
  async authenticate(context: PublisherContext): Promise<AuthResult> {
    return withBrowserSession(this.browser, { profileDir: context.profileDir, headed: this.options.headed }, async (session) => {
      const page = await session.page(); await page.goto(this.options.pageUrl);
      if (await page.isVisible(this.options.selectorProfile.loginMarker)) return { status: 'FAILED', failure: failure('AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED', 'WeChat Channels login is required') };
      if (await page.isVisible(this.options.selectorProfile.verificationMarker)) return { status: 'FAILED', failure: failure('REQUIRES_VERIFICATION', 'HUMAN_ACTION_REQUIRED', 'WeChat Channels requires human verification') };
      return { status: 'AUTHENTICATED' };
    });
  }
  async publish(context: PublisherContext, snapshot: PublishSnapshot): Promise<PublishResult> {
    const existing = await this.state.get(snapshot.idempotencyKey);
    if (existing) return { status: 'PUBLISHED', externalPostId: existing };
    if (!snapshot.mediaPath) return { status: 'FAILED', failure: failure('UPLOAD_FAILED', 'PERMANENT', 'WeChat Channels mediaPath is required') };
    const mediaPath = snapshot.mediaPath;
    const coverPath = snapshot.coverPath;
    return withBrowserSession(this.browser, { profileDir: context.profileDir, headed: this.options.headed }, async (session) => {
      const page = await session.page(); await page.goto(this.options.pageUrl);
      if (await page.isVisible(this.options.selectorProfile.loginMarker)) return { status: 'FAILED', failure: failure('AUTH_EXPIRED', 'HUMAN_ACTION_REQUIRED', 'WeChat Channels login is required') };
      if (await page.isVisible(this.options.selectorProfile.verificationMarker)) return { status: 'FAILED', failure: failure('REQUIRES_VERIFICATION', 'HUMAN_ACTION_REQUIRED', 'WeChat Channels requires human verification') };
      const selectors = this.options.selectorProfile;
      if (!(await page.isVisible(selectors.fileInput)) || !(await page.isVisible(selectors.descriptionInput))) return this.platformChanged(page, snapshot);
      await page.setInputFiles(selectors.fileInput, mediaPath);
      await page.fill(selectors.descriptionInput, [snapshot.title.trim(), snapshot.description.trim()].filter(Boolean).join('\n'));
      if (coverPath) {
        if (!(await page.isVisible(selectors.coverInput))) return this.platformChanged(page, snapshot);
        await page.setInputFiles(selectors.coverInput, coverPath);
      }
      if (!this.options.allowSubmit) return { status: 'FAILED', failure: failure('HUMAN_CONFIRMATION_REQUIRED', 'HUMAN_ACTION_REQUIRED', 'Human confirmation is required before publishing to WeChat Channels') };
      if (!(await page.isVisible(selectors.publishButton))) return this.platformChanged(page, snapshot);
      await page.click(selectors.publishButton);
      if (!(await page.isVisible(selectors.successMarker))) return this.uncertain(page, snapshot);
      const externalPostId = `wechat-channels-${createHash('sha256').update(snapshot.idempotencyKey).digest('hex').slice(0, 16)}`;
      await this.state.set(snapshot.idempotencyKey, externalPostId);
      return { status: 'PUBLISHED', externalPostId };
    });
  }
  async reconcile(_context: PublisherContext, idempotencyKey: string): Promise<ExternalStateResult> {
    const externalPostId = await this.state.get(idempotencyKey);
    return externalPostId ? { status: 'PUBLISHED', externalPostId } : { status: 'UNKNOWN' };
  }
  private async platformChanged(page: { screenshot(path: string): Promise<void> }, snapshot: PublishSnapshot): Promise<PublishResult> {
    const evidence = await this.capture(page, snapshot.idempotencyKey);
    return { status: 'FAILED', failure: failure('PLATFORM_CHANGED', 'PERMANENT', `WeChat Channels publish page changed; evidence ${evidence}`) };
  }
  private async uncertain(page: { screenshot(path: string): Promise<void> }, snapshot: PublishSnapshot): Promise<PublishResult> {
    const evidence = await this.capture(page, snapshot.idempotencyKey);
    return { status: 'UNKNOWN_EXTERNAL_STATE', failure: failure('UNKNOWN_EXTERNAL_STATE', 'RECONCILIATION_REQUIRED', `WeChat Channels submit result is uncertain; evidence ${evidence}`) };
  }
  private async capture(page: { screenshot(path: string): Promise<void> }, idempotencyKey: string): Promise<string> {
    await mkdir(this.options.evidenceDir, { recursive: true });
    const file = join(this.options.evidenceDir, `wechat-channels-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}.png`);
    await page.screenshot(file); return file;
  }
}
