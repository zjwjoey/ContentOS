import { WorkerRuntime, type JobHandler } from '../../../packages/shared/src/worker-runtime.js';
import { DouyinOpenApiAdapter, PublisherAdapterRegistry, createPublisherHandler, WeChatChannelsPlaywrightAdapter, type BrowserSessionFactory, type CredentialProvider, type DouyinHttpTransport, type PublishStateStore, type ReviewApprovalProvider, type WeChatChannelsAdapterOptions } from '../../../packages/modules/publisher/src/index.js';

export interface RealPublisherWorkerOptions {
  profileRoot: string;
  browser: BrowserSessionFactory;
  credentials: CredentialProvider;
  approval: ReviewApprovalProvider;
  state: PublishStateStore;
  douyinTransport?: DouyinHttpTransport;
  wechatOptions?: WeChatChannelsAdapterOptions;
}

export function createPublisherWorker(handler: JobHandler = async () => ({ status: 'NO_OP_STAGE_4_BOOTSTRAP' })): WorkerRuntime {
  const runtime = new WorkerRuntime('publisher-worker');
  runtime.register('publisher.publish', handler);
  return runtime;
}

export function createRealPublisherWorker(options: RealPublisherWorkerOptions): WorkerRuntime {
  const registry = new PublisherAdapterRegistry();
  registry.register(options.douyinTransport ? new DouyinOpenApiAdapter(options.douyinTransport, options.state) : new DouyinOpenApiAdapter(undefined, options.state));
  registry.register(options.wechatOptions ? new WeChatChannelsPlaywrightAdapter(options.browser, options.wechatOptions, options.state) : new WeChatChannelsPlaywrightAdapter(options.browser, {}, options.state));
  return createPublisherWorker(createPublisherHandler({ registry, approval: options.approval, credentials: options.credentials, profileRoot: options.profileRoot }));
}

export async function startPublisherWorkerEntrypoint(): Promise<never> {
  throw new Error('Publisher Worker requires explicit real composition with durable state, credentials and review approval providers');
}

if (process.argv[1]?.endsWith('main.ts')) {
  await startPublisherWorkerEntrypoint();
}
