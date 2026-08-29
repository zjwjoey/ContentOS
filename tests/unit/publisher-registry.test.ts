import test from 'node:test';
import assert from 'node:assert/strict';
import { PublisherAdapterRegistry } from '../../packages/modules/publisher/src/index.js';
import type { AuthResult, ExternalStateResult, PlatformCapabilityProfile, PublishResult, PublishSnapshot, PublisherAdapter, PublisherContext } from '../../packages/contracts/src/index.js';

class Adapter implements PublisherAdapter {
  constructor(private readonly id: 'douyin' | 'wechat-channels') {}
  capabilities(): PlatformCapabilityProfile { return { platformId: this.id, mediaTypes: ['video/mp4'], scheduling: false, requiresHumanConfirmation: true }; }
  async authenticate(_context: PublisherContext): Promise<AuthResult> { return { status: 'AUTHENTICATED' }; }
  async publish(_context: PublisherContext, _snapshot: PublishSnapshot): Promise<PublishResult> { return { status: 'PUBLISHED', externalPostId: `${this.id}-post` }; }
  async reconcile(_context: PublisherContext, _idempotencyKey: string): Promise<ExternalStateResult> { return { status: 'NOT_FOUND' }; }
}

test('publisher adapter registry dispatches platform IDs and rejects duplicate registration', () => {
  const registry = new PublisherAdapterRegistry();
  const adapter = new Adapter('douyin');
  registry.register(adapter);
  assert.equal(registry.get('douyin'), adapter);
  assert.deepEqual(registry.ids(), ['douyin']);
  assert.throws(() => registry.register(new Adapter('douyin')), /already registered/);
  assert.throws(() => registry.get('wechat-channels'), /not registered/);
});
