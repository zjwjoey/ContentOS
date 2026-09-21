import { basename } from 'node:path';
import { CompositeReadableDraftAdapter, JianyingRuntimeLocator, type JianyingRuntimeStatus } from '../packages/modules/video/src/index.js';

function errorCode(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function countNamedCollections(value: unknown, names: Set<string>): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.length;
  return Object.entries(value as Record<string, unknown>).reduce((total, [key, child]) => total + (names.has(key) && Array.isArray(child) ? child.length : countNamedCollections(child, names)), 0);
}

function safeDraftSummary(payloads: Record<string, unknown>[]) {
  const first = payloads[0] || {};
  const draftId = typeof first.draft_id === 'string' ? first.draft_id : typeof first.draftId === 'string' ? first.draftId : undefined;
  const draftName = typeof first.draft_name === 'string' ? first.draft_name : typeof first.draftName === 'string' ? first.draftName : undefined;
  const root = payloads.length === 1 ? first : payloads;
  return {
    ...(draftId ? { draftId } : {}),
    ...(draftName ? { draftName } : {}),
    payloadCount: payloads.length,
    materialCount: countNamedCollections(root, new Set(['materials', 'material', 'materials_info'])),
    trackCount: countNamedCollections(root, new Set(['tracks', 'track'])),
    segmentCount: countNamedCollections(root, new Set(['segments', 'segment'])),
  };
}

function publicStatus(status: JianyingRuntimeStatus) {
  return {
    platform: status.platform,
    helperConfigured: status.helper.configured,
    helperAvailable: status.helper.status === 'AVAILABLE',
    helperName: status.helper.path ? basename(status.helper.path) : undefined,
    dllConfigured: status.dll.configured,
    dllAvailable: status.dll.status === 'AVAILABLE',
    dllName: status.dll.path ? basename(status.dll.path) : undefined,
    encryptedDraftSupport: status.encryptedDraftSupport,
  };
}

const draftPath = process.argv.slice(2).find((value) => !value.startsWith('-'));
if (!draftPath) {
  console.log('Jianying runtime smoke test: BLOCKED_BY_ENVIRONMENT');
  console.log('Usage: pnpm test:jianying-runtime -- <draft-file-or-directory>');
  process.exit(0);
}

const locator = new JianyingRuntimeLocator();
const status = await locator.getRuntimeStatus();
console.log(JSON.stringify({ runtime: publicStatus(status) }));

try {
  const result = await new CompositeReadableDraftAdapter().read(draftPath);
  console.log(JSON.stringify({ summary: safeDraftSummary(result.payloads) }));
  console.log('Jianying runtime smoke test: PASS');
} catch (error) {
  const code = errorCode(error);
  if (['JIANYING_ENCRYPTED_DRAFT_REQUIRES_WINDOWS_RUNTIME', 'JIANYING_VIDEOEDITOR_DLL_UNAVAILABLE', 'JIANYING_HELPER_UNAVAILABLE'].includes(code)) {
    console.log(`Jianying runtime smoke test: BLOCKED_BY_ENVIRONMENT (${code})`);
    process.exit(0);
  }
  console.error(`Jianying runtime smoke test: FAIL (${code})`);
  process.exit(1);
}
