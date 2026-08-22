import { createRealPublisherWorker } from '../workers/publisher-worker/src/main.js';
import { EnvironmentCredentialProvider, InMemoryPublishStateStore } from '../packages/modules/publisher/src/index.js';
import { PlaywrightBrowserSessionFactory } from '../packages/infrastructure/playwright/src/index.js';
import type { PublisherPlatformId, PublishResult } from '../packages/contracts/src/index.js';

export interface PublisherSmokeConfig {
  platformId: 'douyin' | 'wechat-channels';
  accountId: string;
  mediaPath: string;
  credentialRef: string;
  profileRoot: string;
  projectId: string;
  targetId: string;
  reviewDecisionId: string;
  allowSubmit: boolean;
  title: string;
  description: string;
}

export function publisherSmokeExitCode(result: PublishResult): 0 | 1 { return result.status === 'PUBLISHED' ? 0 : 1; }

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parsePublisherSmokeConfig(environment: Record<string, string | undefined>, args: string[]): PublisherSmokeConfig {
  if (environment.CONTENTOS_REAL_PLATFORM_SMOKE !== '1') throw new Error('Real publisher smoke tests require CONTENTOS_REAL_PLATFORM_SMOKE=1');
  if (environment.CONTENTOS_PUBLISHER_REVIEW_APPROVED !== '1') throw new Error('Real publisher smoke tests require an approved review decision');
  const platform = argument(args, '--platform');
  if (platform !== 'douyin' && platform !== 'wechat-channels') throw new Error('Smoke platform must be douyin or wechat-channels');
  const accountId = argument(args, '--account');
  const mediaPath = argument(args, '--media');
  const credentialRef = argument(args, '--credential-ref');
  const profileRoot = argument(args, '--profile-root') || environment.CONTENTOS_PUBLISHER_PROFILE_ROOT || './storage/publisher-profiles';
  if (!accountId || !/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error('Smoke account must be a safe non-empty identifier');
  if (!mediaPath) throw new Error('Smoke media path is required');
  if (!credentialRef) throw new Error('Smoke credential reference is required');
  if (!credentialRef.startsWith('env://')) throw new Error('Smoke credentials must use an env:// reference');
  const credentialKey = credentialRef.slice('env://'.length);
  if (!environment[credentialKey]) throw new Error(`Smoke credential ${credentialKey} is not configured`);
  const allowSubmit = environment.CONTENTOS_PUBLISHER_ALLOW_SUBMIT === '1';
  return { platformId: platform, accountId, mediaPath, credentialRef, profileRoot, projectId: environment.CONTENTOS_PUBLISHER_PROJECT_ID || 'smoke-project', targetId: environment.CONTENTOS_PUBLISHER_TARGET_ID || `smoke-${accountId}`, reviewDecisionId: environment.CONTENTOS_PUBLISHER_REVIEW_ID || 'smoke-approved-review', allowSubmit, title: environment.CONTENTOS_PUBLISHER_TITLE || 'ContentOS smoke test', description: environment.CONTENTOS_PUBLISHER_DESCRIPTION || 'ContentOS smoke test' };
}

export async function runPublisherSmoke(config: PublisherSmokeConfig, environment: Record<string, string | undefined> = process.env): Promise<PublishResult> {
  const worker = createRealPublisherWorker({
    profileRoot: config.profileRoot,
    browser: new PlaywrightBrowserSessionFactory({ ...(environment.CONTENTOS_CHROME_PATH ? { executablePath: environment.CONTENTOS_CHROME_PATH } : {}) }),
    credentials: new EnvironmentCredentialProvider(environment),
    state: new InMemoryPublishStateStore(),
    approval: { isApproved: async (input) => input.reviewDecisionId === config.reviewDecisionId && config.allowSubmit },
    wechatOptions: { headed: environment.CONTENTOS_PUBLISHER_HEADED !== '0', allowSubmit: config.allowSubmit },
  });
  await worker.start();
  try {
    const assetSha256 = createHash('sha256').update(await readFile(config.mediaPath)).digest('hex');
    return await worker.execute('publisher.publish', { platformId: config.platformId as PublisherPlatformId, accountId: config.accountId, credentialRef: config.credentialRef, projectId: config.projectId, targetId: config.targetId, reviewDecisionId: config.reviewDecisionId, snapshot: { requestId: `smoke-${Date.now()}`, idempotencyKey: `smoke:${config.platformId}:${config.accountId}:${config.mediaPath}`, assetId: 'smoke-asset', assetSha256, mediaPath: config.mediaPath, title: config.title, description: config.description } }) as PublishResult;
  } finally { await worker.shutdown('smoke-complete'); }
}

if (process.argv[1]?.endsWith('publisher-smoke.ts')) {
  try {
    const config = parsePublisherSmokeConfig(process.env, process.argv.slice(2));
    const result = await runPublisherSmoke(config);
    console.log(JSON.stringify({ platformId: config.platformId, accountId: config.accountId, status: result.status, ...(result.externalPostId ? { externalPostId: result.externalPostId } : {}), ...(result.failure ? { failureCode: result.failure.code, failureClassification: result.failure.classification } : {}) }));
    process.exitCode = publisherSmokeExitCode(result);
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAILED', message: error instanceof Error ? error.message : 'Publisher smoke failed' }));
    process.exitCode = 1;
  }
}
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
