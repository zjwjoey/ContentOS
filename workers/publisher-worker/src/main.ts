import { WorkerRuntime, type JobHandler } from '../../../packages/shared/src/worker-runtime.js';
import { DouyinOpenApiAdapter, PublisherAdapterRegistry, createPublisherHandler, WeChatChannelsPlaywrightAdapter, type BrowserSessionFactory, type CredentialProvider, type DouyinHttpTransport, type ReviewApprovalProvider, type WeChatChannelsAdapterOptions } from '../../../packages/modules/publisher/src/index.js';

export interface RealPublisherWorkerOptions {
  profileRoot: string;
  browser: BrowserSessionFactory;
  credentials: CredentialProvider;
  approval: ReviewApprovalProvider;
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
  registry.register(options.douyinTransport ? new DouyinOpenApiAdapter(options.douyinTransport) : new DouyinOpenApiAdapter());
  registry.register(options.wechatOptions ? new WeChatChannelsPlaywrightAdapter(options.browser, options.wechatOptions) : new WeChatChannelsPlaywrightAdapter(options.browser));
  return createPublisherWorker(createPublisherHandler({ registry, approval: options.approval, credentials: options.credentials, profileRoot: options.profileRoot }));
}

if (process.argv[1]?.endsWith('main.ts')) {
  const worker = createPublisherWorker();
  process.once('SIGINT', () => void worker.shutdown('SIGINT'));
  process.once('SIGTERM', () => void worker.shutdown('SIGTERM'));
  await worker.start();
  console.log(JSON.stringify(worker.health()));
}
