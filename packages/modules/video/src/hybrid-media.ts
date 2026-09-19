import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AssetService } from '../../asset/src/asset-service.js';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { segmentScriptSentences, type ScriptSentence } from './sentence-segmenter.js';
import type { PlannerAsset } from './planner.js';

export type HybridSourcePolicy = 'LOCAL_ONLY' | 'LOCAL_FIRST' | 'HYBRID' | 'EXTERNAL_FIRST';
export interface VisualPlanSegmentV1 {
  segmentIndex: number;
  text: string;
  visualIntent: string;
  entities: string[];
  keywords: string[];
  localQueries: string[];
  externalQueries: string[];
  sourcePolicy: HybridSourcePolicy;
  requiresAuthenticEntityVisual: boolean;
  desiredDurationMs: number;
}
export interface VisualPlanV1 { schemaVersion: 'VISUAL_PLAN_V1'; scriptHash: string; segments: VisualPlanSegmentV1[]; generatedBy: 'deterministic-v1' | 'ai'; }

export interface ExternalVideoFile { id: string; width: number; height: number; durationMs: number; url: string; fileType?: string; quality?: string; }
export interface ExternalVideoResult { provider: string; assetId: string; pageUrl?: string; creator?: string; creatorUrl?: string; width: number; height: number; durationMs: number; files: ExternalVideoFile[]; tags?: string[]; }
export interface ExternalVideoSearchOptions { query: string; orientation?: 'portrait' | 'landscape' | 'square'; locale?: string; page?: number; perPage?: number; signal?: AbortSignal | undefined; }
export interface ExternalVideoProvider {
  readonly name: string;
  readonly configured: boolean;
  search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }>;
  download(video: ExternalVideoResult, destination: string, signal?: AbortSignal): Promise<{ fileId: string; bytes: number; contentType: string }>;
  health?(): Promise<{ ok: boolean; message?: string; rateLimit?: RateLimitInfo }>;
}
export interface RateLimitInfo { limit?: number | undefined; remaining?: number | undefined; resetAt?: string | undefined; }

const cache = new Map<string, { expiresAt: number; value: ExternalVideoResult[]; rateLimit?: RateLimitInfo }>();
const WORD_MAP: Record<string, string[]> = { 产品: ['product', 'product closeup'], 科技: ['technology', 'futuristic technology'], 城市: ['city', 'urban skyline'], 人物: ['people', 'portrait'], 自然: ['nature', 'landscape'], 会议: ['business meeting', 'office'], 工厂: ['factory', 'manufacturing'], 海边: ['ocean', 'beach'], 食物: ['food', 'cooking'], 旅行: ['travel', 'destination'] };

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase(); }
function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }
function extractEntities(text: string): string[] {
  const english = text.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/gu) || [];
  const chinese = text.match(/[\u3400-\u9fff]{2,8}/gu) || [];
  return unique([...english, ...chinese]).filter((value) => !['This', 'That', 'With', 'When', 'The', '我们', '今天', '如果', '因为'].includes(value));
}
function keywordQueries(text: string, entities: string[]): string[] {
  const mapped = Object.entries(WORD_MAP).flatMap(([key, values]) => text.includes(key) ? values : []);
  const englishWords = text.match(/[A-Za-z][A-Za-z0-9-]{2,}/gu) || [];
  return unique([...entities, ...mapped, ...englishWords]).slice(0, 8);
}
export function planVisuals(script: string, options: { durationMs?: number; generatedBy?: 'deterministic-v1' | 'ai' } = {}): VisualPlanV1 {
  const sentences = segmentScriptSentences(script);
  const scriptHash = `sha256:${hash(script)}`;
  const desired = Math.max(2_000, Math.round((options.durationMs || Math.max(2_000, sentences.length * 4_000)) / Math.max(1, sentences.length)));
  return { schemaVersion: 'VISUAL_PLAN_V1', scriptHash, generatedBy: options.generatedBy || 'deterministic-v1', segments: sentences.map((sentence, index) => {
    const entities = extractEntities(sentence.text);
    const keywords = keywordQueries(sentence.text, entities);
    const authentic = entities.length > 0;
    const intent = keywords.length ? keywords.join(', ') : 'editorial abstract b-roll';
    return { segmentIndex: index, text: sentence.text, visualIntent: intent, entities, keywords, localQueries: unique([...entities, ...keywords]), externalQueries: unique([...(authentic ? keywords.filter((item) => !entities.includes(item)) : keywords), authentic ? 'editorial b-roll' : 'cinematic b-roll']), sourcePolicy: authentic ? 'LOCAL_FIRST' : 'HYBRID', requiresAuthenticEntityVisual: authentic, desiredDurationMs: desired };
  }) };
}

export function dedupeExternalQueries(plan: VisualPlanV1): string[] { return unique(plan.segments.flatMap((segment) => segment.externalQueries.map(normalize))); }
export function rankLocalCandidates(segment: VisualPlanSegmentV1, assets: Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>): Array<PlannerAsset & { score: number; matched: string[] }> {
  const required = segment.localQueries.map(normalize);
  return assets.filter((asset) => Number(asset.durationMs) > 0).map((asset) => {
    const haystack = normalize([asset.id, asset.sourcePath, asset.originalName || '', ...(asset.tags || []), ...Object.values(asset.metadata || {}).filter((value): value is string => typeof value === 'string')].join(' '));
    const matched = required.filter((query) => haystack.includes(query));
    const entityHit = segment.entities.some((entity) => haystack.includes(normalize(entity)));
    const usagePenalty = Math.min(25, Number(asset.usageCount || 0) * 2 + Number(asset.recentUsageCount || 0));
    const score = matched.length * 24 + (entityHit ? 80 : 0) + (asset.sourcePath ? 5 : 0) - usagePenalty;
    return { ...asset, score, matched };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function allowedDownloadUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('PEXELS_DOWNLOAD_URL_INVALID'); }
  if (url.protocol !== 'https:' || !['videos.pexels.com', 'images.pexels.com'].includes(url.hostname.toLowerCase())) throw new Error('PEXELS_DOWNLOAD_URL_BLOCKED');
  return url;
}
function pickFile(video: ExternalVideoResult): ExternalVideoFile {
  const files = video.files.filter((file) => file.url && file.width > 0 && file.height > 0).sort((a, b) => (Math.abs((b.width / b.height) - 0.5625) - Math.abs((a.width / a.height) - 0.5625)) || b.width - a.width);
  if (!files[0]) throw new Error('PEXELS_NO_USABLE_VIDEO_FILE');
  allowedDownloadUrl(files[0].url);
  return files[0];
}

export class PexelsVideoProvider implements ExternalVideoProvider {
  readonly name = 'pexels';
  readonly configured: boolean;
  private rateLimit: RateLimitInfo | undefined;
  constructor(private readonly apiKey = process.env.PEXELS_API_KEY || '', private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000) { this.configured = Boolean(this.apiKey.trim()); }
  private async request(path: string, signal?: AbortSignal): Promise<Response> {
    if (!this.configured) throw new Error('PEXELS_NOT_CONFIGURED');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(`https://api.pexels.com${path}`, { headers: { Authorization: this.apiKey }, signal: controller.signal });
      this.rateLimit = { limit: Number(response.headers.get('x-ratelimit-limit')) || undefined, remaining: Number(response.headers.get('x-ratelimit-remaining')) || undefined, resetAt: response.headers.get('x-ratelimit-reset') || undefined };
      if (!response.ok) throw new Error(`PEXELS_HTTP_${response.status}`);
      return response;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }> {
    const key = `${options.query}|${options.orientation || ''}|${options.locale || ''}|${options.page || 1}`;
    const cached = cache.get(key); if (cached && cached.expiresAt > Date.now()) return { results: cached.value, ...(cached.rateLimit ? { rateLimit: cached.rateLimit } : {}) };
    const params = new URLSearchParams({ query: options.query, page: String(options.page || 1), per_page: String(Math.min(20, options.perPage || 8)), ...(options.orientation ? { orientation: options.orientation } : {}), ...(options.locale ? { locale: options.locale } : {}) });
    const response = await this.request(`/videos/search?${params.toString()}`, options.signal); const body = await response.json() as { videos?: Array<Record<string, unknown>> };
    const results = (body.videos || []).map((item) => { const files = Array.isArray(item.video_files) ? item.video_files.map((file) => ({ id: String((file as Record<string, unknown>).id || ''), width: Number((file as Record<string, unknown>).width || 0), height: Number((file as Record<string, unknown>).height || 0), durationMs: Number(item.duration || 0) * 1000, url: String((file as Record<string, unknown>).link || ''), fileType: String((file as Record<string, unknown>).file_type || ''), quality: String((file as Record<string, unknown>).quality || '') })) : []; return { provider: 'pexels', assetId: String(item.id || ''), pageUrl: String(item.url || ''), creator: String((item.user as Record<string, unknown> | undefined)?.name || ''), creatorUrl: String((item.user as Record<string, unknown> | undefined)?.url || ''), width: Number(item.width || 0), height: Number(item.height || 0), durationMs: Number(item.duration || 0) * 1000, files }; }).filter((item) => item.assetId && item.files.some((file) => file.url));
    cache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value: results, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }); return { results, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) };
  }
  async download(video: ExternalVideoResult, destination: string, signal?: AbortSignal): Promise<{ fileId: string; bytes: number; contentType: string }> {
    const file = pickFile(video); let current = allowedDownloadUrl(file.url); let response: Response | undefined;
    for (let redirect = 0; redirect <= 2; redirect += 1) { response = await this.fetchImpl(current.toString(), { redirect: 'manual', ...(signal ? { signal } : {}) }); if (![301, 302, 303, 307, 308].includes(response.status)) break; const location = response.headers.get('location'); if (!location) throw new Error('PEXELS_REDIRECT_INVALID'); current = allowedDownloadUrl(new URL(location, current).toString()); }
    if (!response || !response.ok) throw new Error(`PEXELS_DOWNLOAD_HTTP_${response?.status || 0}`);
    const contentType = response.headers.get('content-type') || ''; if (!contentType.toLowerCase().startsWith('video/')) throw new Error('PEXELS_DOWNLOAD_CONTENT_TYPE_INVALID');
    const maxBytes = 500 * 1024 * 1024; const length = Number(response.headers.get('content-length') || 0); if (length > maxBytes) throw new Error('PEXELS_DOWNLOAD_TOO_LARGE');
    if (!response.body) throw new Error('PEXELS_DOWNLOAD_EMPTY'); await mkdir(join(destination, '..'), { recursive: true });
    const fileHandle = await import('node:fs/promises').then((fs) => fs.open(destination, 'w')); let bytes = 0;
    try { for await (const chunk of response.body as AsyncIterable<Uint8Array>) { bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error('PEXELS_DOWNLOAD_TOO_LARGE'); await fileHandle.write(chunk); } } finally { await fileHandle.close(); }
    return { fileId: file.id, bytes, contentType };
  }
  async health(): Promise<{ ok: boolean; message?: string; rateLimit?: RateLimitInfo }> { try { await this.search({ query: 'abstract', perPage: 1 }); return { ok: true, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'PEXELS_HEALTH_FAILED', ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }; } }
  getRateLimit(): RateLimitInfo | undefined { return this.rateLimit; }
}

export class FakeExternalVideoProvider implements ExternalVideoProvider {
  readonly name = 'fake-pexels'; readonly configured = true;
  constructor(private readonly fixturePath = process.env.CONTENTOS_FAKE_PEXELS_FIXTURE || '') {}
  async search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[] }> { const query = options.query.trim() || 'abstract'; return { results: [{ provider: this.name, assetId: `fake-${hash(query).slice(0, 12)}`, pageUrl: `https://www.pexels.com/video/fake-${hash(query).slice(0, 8)}/`, creator: 'ContentOS Fake', width: 1080, height: 1920, durationMs: 8_000, files: [{ id: `file-${hash(query).slice(0, 12)}`, width: 1080, height: 1920, durationMs: 8_000, url: 'https://videos.pexels.com/fake/contentos.mp4', fileType: 'video/mp4', quality: 'hd' }] }] }; }
  async download(video: ExternalVideoResult, destination: string): Promise<{ fileId: string; bytes: number; contentType: string }> { if (!this.fixturePath) throw new Error('CONTENTOS_FAKE_PEXELS_FIXTURE_REQUIRED'); await copyFile(this.fixturePath, destination); return { fileId: video.files[0]?.id || 'fake-file', bytes: 1, contentType: 'video/mp4' }; }
  async health(): Promise<{ ok: boolean }> { return { ok: true }; }
}
export function createExternalVideoProvider(): ExternalVideoProvider { return process.env.CONTENTOS_FAKE_PEXELS === '1' ? new FakeExternalVideoProvider() : new PexelsVideoProvider(); }

export interface HybridRetrievalResult { assets: PlannerAsset[]; plan: VisualPlanV1; diagnostics: { localCount: number; externalCount: number; fallbackCount: number; queries: string[]; warnings: string[]; }; }
export class HybridMediaService {
  constructor(private readonly assetService: AssetService, private readonly storage: LocalStorageProvider, private readonly provider?: ExternalVideoProvider) {}
  async resolve(input: { workspaceId: string; script: string; localAssets: Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>; usePexels: boolean; signal?: AbortSignal }): Promise<HybridRetrievalResult> {
    const plan = planVisuals(input.script); const chosen: PlannerAsset[] = []; let externalCount = 0; let fallbackCount = 0; const warnings: string[] = []; const queries = dedupeExternalQueries(plan);
    for (const segment of plan.segments) {
      if (input.signal?.aborted) throw new Error('EDIT_PREPARE_CANCELLED');
      const ranked = rankLocalCandidates(segment, input.localAssets); const local = ranked.find((candidate) => candidate.durationMs >= Math.min(segment.desiredDurationMs, Math.max(1, candidate.durationMs)));
      if (local && (!segment.requiresAuthenticEntityVisual || local.score >= 70)) { chosen.push(local); continue; }
      if (segment.requiresAuthenticEntityVisual && !local) fallbackCount += 1;
      if (!input.usePexels || !this.provider) { if (local) chosen.push(local); else if (input.localAssets[0]) chosen.push(input.localAssets[0]); else throw new Error('EDIT_NO_VIDEO_ASSETS'); continue; }
      const query = segment.externalQueries[0] || 'cinematic b-roll';
      try {
        const search = await this.provider.search({ query, orientation: 'portrait', locale: 'zh-CN', perPage: 8, ...(input.signal ? { signal: input.signal } : {}) }); const result = search.results[0];
        if (!result) throw new Error('PEXELS_NO_RESULTS');
        const temp = join(this.storage.root, 'staging', `hybrid-${hash(`${input.workspaceId}:${segment.segmentIndex}:${result.assetId}`)}${extname(result.files[0]?.url || '.mp4') || '.mp4'}`);
        await this.provider.download(result, temp, input.signal); const imported = await this.assetService.importFile({ workspaceId: input.workspaceId, sourcePath: temp, kind: 'VIDEO', role: 'SOURCE' });
        await rm(temp, { force: true }); chosen.push({ id: imported.id, storageKey: imported.storageKey, sourcePath: this.storage.objectPath(imported.storageKey), durationMs: result.durationMs || 8_000 }); externalCount += 1;
      } catch (error) { warnings.push(`${query}:${error instanceof Error ? error.message : 'external retrieval failed'}`); if (local) chosen.push(local); else if (input.localAssets[0]) chosen.push(input.localAssets[0]); else throw error; }
    }
    return { assets: chosen.length ? chosen : input.localAssets, plan, diagnostics: { localCount: chosen.length - externalCount, externalCount, fallbackCount, queries, warnings } };
  }
}
