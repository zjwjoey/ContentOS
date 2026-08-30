import type { PublisherAdapter, PublisherPlatformId } from '../../../contracts/src/index.js';

export class PublisherAdapterRegistry {
  private readonly adapters = new Map<PublisherPlatformId, PublisherAdapter>();

  register(adapter: PublisherAdapter): void {
    const platformId = adapter.capabilities().platformId;
    if (!['fake-platform', 'douyin', 'wechat-channels'].includes(platformId)) throw new Error(`Unsupported publisher adapter ${platformId}`);
    if (this.adapters.has(platformId as PublisherPlatformId)) throw new Error(`Publisher adapter ${platformId} already registered`);
    this.adapters.set(platformId as PublisherPlatformId, adapter);
  }

  get(platformId: PublisherPlatformId): PublisherAdapter {
    const adapter = this.adapters.get(platformId);
    if (!adapter) throw new Error(`Publisher adapter ${platformId} is not registered`);
    return adapter;
  }

  has(platformId: PublisherPlatformId): boolean { return this.adapters.has(platformId); }
  ids(): PublisherPlatformId[] { return [...this.adapters.keys()].sort(); }
}
