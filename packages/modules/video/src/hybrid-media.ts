import { createHash } from 'node:crypto';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Pool } from 'pg';
import type { AssetService } from '../../asset/src/asset-service.js';
import type { LocalStorageProvider } from '../../../infrastructure/storage/src/index.js';
import { segmentScriptSentences } from './sentence-segmenter.js';
import { calculateSentenceRequiredDurationMs, type PlannerAsset, type ResolvedVisualAssignment } from './planner.js';

export type HybridSourcePolicy = 'LOCAL_ONLY' | 'LOCAL_FIRST' | 'HYBRID' | 'EXTERNAL_FIRST';
export type KnownEntityType = 'BRAND' | 'COMPANY' | 'PERSON' | 'PLACE' | 'PRODUCT';
export interface KnownVisualEntity { name: string; type: KnownEntityType; aliases?: string[]; }
export const DEFAULT_VISUAL_ENTITIES: KnownVisualEntity[] = [
  { name: 'MIZAN', type: 'BRAND' }, { name: '东晟', type: 'COMPANY' }, { name: 'Action', type: 'BRAND' },
  { name: 'Pepco', type: 'BRAND' }, { name: '小陈', type: 'PERSON' }, { name: '波兰', type: 'PLACE', aliases: ['Poland'] },
  { name: '华沙', type: 'PLACE', aliases: ['Warsaw'] }, { name: '中欧', type: 'PLACE', aliases: ['Central Europe'] },
];
export interface VisualEntityDetail { name: string; type: KnownEntityType; requiresAuthenticAsset: boolean; }
export interface VisualPlanSegmentV1 {
  segmentIndex: number; text: string; visualIntent: string; entities: string[]; entityDetails?: VisualEntityDetail[]; keywords: string[];
  localQueries: string[]; externalQueries: string[]; sourcePolicy: HybridSourcePolicy; requiresAuthenticEntityVisual: boolean; desiredDurationMs: number; reason?: string;
}
export interface VisualPlanV1 { schemaVersion: 'VISUAL_PLAN_V1'; scriptHash: string; segments: VisualPlanSegmentV1[]; generatedBy: 'deterministic-v1' | 'ai'; }
export interface ResolvedVisualPlanSegmentV1 extends VisualPlanSegmentV1 {
  selectedAssetId: string; selectedSource: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS';
  selectedRole: 'AUTHENTIC_ENTITY' | 'NEUTRAL_BROLL' | 'GENERIC_BROLL' | 'PLACE_CONTEXT';
  entityFallback: boolean; fallback?: boolean; allowAssetReuse?: boolean; matchScore: number; searchQuery?: string; reason?: string; query?: string;
}
export interface ResolvedVisualPlanV1 { schemaVersion: 'RESOLVED_VISUAL_PLAN_V1'; plan: VisualPlanV1; segments: ResolvedVisualPlanSegmentV1[]; }

export interface ExternalVideoFile { id: string; width: number; height: number; durationMs: number; url: string; fileType?: string; quality?: string; }
export interface ExternalVideoResult { provider: string; assetId: string; pageUrl?: string; creator?: string; creatorUrl?: string; width: number; height: number; durationMs: number; files: ExternalVideoFile[]; tags?: string[]; }
export interface ExternalVideoSearchOptions { query: string; orientation?: 'portrait' | 'landscape' | 'square'; locale?: string; page?: number; perPage?: number; signal?: AbortSignal | undefined; }
export interface RateLimitInfo { limit?: number | undefined; remaining?: number | undefined; resetAt?: string | undefined; }
export interface ExternalVideoProvider { readonly name: string; readonly configured: boolean; search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }>; download(video: ExternalVideoResult, destination: string, signal?: AbortSignal): Promise<{ fileId: string; bytes: number; contentType: string }>; health?(): Promise<{ ok: boolean; message?: string; rateLimit?: RateLimitInfo }>; }

const processCache = new Map<string, { expiresAt: number; value: ExternalVideoResult[]; rateLimit?: RateLimitInfo }>();
const WORD_MAP: Record<string, string[]> = {
  产品: ['product', 'product closeup'], 科技: ['technology', 'futuristic technology'], 城市: ['city', 'urban skyline'], 人物: ['people', 'portrait'], 自然: ['nature', 'landscape'], 会议: ['business meeting', 'office'], 工厂: ['factory', 'manufacturing'], 海边: ['ocean', 'beach'], 食物: ['food', 'cooking'], 旅行: ['travel', 'destination'], 零售: ['retail store'], 商店: ['retail store'], 物流: ['logistics warehouse', 'delivery'], 仓库: ['warehouse logistics'], 消费者: ['shoppers', 'consumer'], 市场: ['retail market', 'business district'], 商业合作: ['business meeting', 'business handshake'], 讨论: ['business discussion'], 门店: ['retail store'], 选择: ['crossroads', 'decision', 'business'], 招商: ['business meeting', 'retail office'], 交流: ['handshake', 'business discussion'], 合作: ['business meeting', 'handshake'],
};
const CONCEPTS = new Set(['商业合作', '市场磨合', '选择', '观点', '商业', '合作', '市场', '讨论', '不同声音', '零售', '商店', '仓库', '物流', '消费者', '城市', '门店', '工厂', '办公', '招商', '交流']);
const ENGLISH_STOPWORDS = new Set(['This', 'That', 'With', 'When', 'The', 'And', 'For', 'From']);
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase(); }
function unique(values: string[]): string[] { return [...new Set(values.map((value) => value.trim()).filter(Boolean))]; }

export function classifyVisualEntities(text: string, registry: KnownVisualEntity[] = DEFAULT_VISUAL_ENTITIES): VisualEntityDetail[] {
  const normalized = normalize(text); const found: VisualEntityDetail[] = [];
  for (const entity of registry) if ([entity.name, ...(entity.aliases || [])].some((candidate) => normalized.includes(normalize(candidate)))) found.push({ name: entity.name, type: entity.type, requiresAuthenticAsset: ['BRAND', 'COMPANY', 'PERSON', 'PRODUCT'].includes(entity.type) });
  const english = text.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/gu) || [];
  for (const value of english) if (!found.some((item) => normalize(item.name) === normalize(value)) && !CONCEPTS.has(value) && !ENGLISH_STOPWORDS.has(value)) found.push({ name: value, type: 'PRODUCT', requiresAuthenticAsset: true });
  return found;
}
function keywordQueries(text: string, entities: string[]): string[] { const mapped = Object.entries(WORD_MAP).flatMap(([key, values]) => text.includes(key) ? values : []); const english = text.match(/[A-Za-z][A-Za-z0-9-]{2,}/gu) || []; return unique([...mapped, ...english, ...entities]).slice(0, 10); }
export function planVisuals(script: string, options: { durationMs?: number; minClipDurationMs?: number; maxClipDurationMs?: number; generatedBy?: 'deterministic-v1' | 'ai'; entityRegistry?: KnownVisualEntity[] } = {}): VisualPlanV1 {
  const sentences = segmentScriptSentences(script); const scriptHash = `sha256:${hash(script)}`; const defaultDesired = Math.max(2_000, Math.round((options.durationMs || Math.max(2_000, sentences.length * 4_000)) / Math.max(1, sentences.length)));
  return { schemaVersion: 'VISUAL_PLAN_V1', scriptHash, generatedBy: options.generatedBy || 'deterministic-v1', segments: sentences.map((sentence, index) => {
    const details = classifyVisualEntities(sentence.text, options.entityRegistry || DEFAULT_VISUAL_ENTITIES); const entities = details.map((item) => item.name); const keywords = keywordQueries(sentence.text, entities); const authentic = details.some((item) => item.requiresAuthenticAsset); const places = details.filter((item) => item.type === 'PLACE');
    const desiredDurationMs = options.minClipDurationMs !== undefined && options.maxClipDurationMs !== undefined ? calculateSentenceRequiredDurationMs(sentence.text, options.minClipDurationMs, options.maxClipDurationMs) : defaultDesired;
    const intent = keywords.length ? keywords.join(', ') : 'editorial abstract b-roll'; const externalQueries = unique([...(authentic ? keywords.filter((item) => !entities.includes(item)) : keywords), ...(places.length ? places.map((place) => `${place.name} city street`) : []), ...(places.length ? [] : ['cinematic neutral b-roll'])]);
    return { segmentIndex: index, text: sentence.text, visualIntent: intent, entities, entityDetails: details, keywords, localQueries: unique([...entities, ...keywords]), externalQueries, sourcePolicy: authentic ? 'LOCAL_FIRST' : 'HYBRID', requiresAuthenticEntityVisual: authentic, desiredDurationMs, reason: authentic ? '已识别真实品牌、公司或人物，优先使用本地真实素材' : places.length ? '地点允许使用上下文 B-roll' : '未识别真实实体，使用中性 B-roll' };
  }) };
}
export function dedupeExternalQueries(plan: VisualPlanV1): string[] { return unique(plan.segments.flatMap((segment) => segment.externalQueries.map(normalize))); }
export interface RankedLocalCandidate extends PlannerAsset {
  score: number;
  semanticScore: number;
  authenticEntityScore: number;
  placeScore: number;
  keywordScore: number;
  usagePenalty: number;
  matched: string[];
  matchedAuthenticEntities: string[];
  matchedPlaceEntities: string[];
  matchedKeywords: string[];
}
export function rankLocalCandidates(segment: VisualPlanSegmentV1, assets: Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>): RankedLocalCandidate[] {
  const authenticEntities = (segment.entityDetails || []).filter((entity) => entity.requiresAuthenticAsset);
  const placeEntities = (segment.entityDetails || []).filter((entity) => entity.type === 'PLACE');
  const required = segment.localQueries.map(normalize);
  return assets.filter((asset) => Number(asset.durationMs) > 0).map((asset) => {
    const haystack = normalize([asset.id, asset.sourcePath, asset.originalName || '', ...(asset.tags || []), ...Object.values(asset.metadata || {}).filter((value): value is string => typeof value === 'string')].join(' '));
    const matched = required.filter((query) => haystack.includes(query));
    const matchedAuthenticEntities = authenticEntities.filter((entity) => haystack.includes(normalize(entity.name))).map((entity) => entity.name);
    const matchedPlaceEntities = placeEntities.filter((entity) => haystack.includes(normalize(entity.name))).map((entity) => entity.name);
    const matchedKeywords = segment.keywords.filter((keyword) => haystack.includes(normalize(keyword)));
    const categoryHit = Object.entries(asset.metadata || {}).some(([key, value]) => /category|kind|type/u.test(key) && typeof value === 'string' && segment.keywords.some((query) => normalize(String(value)).includes(normalize(query))));
    const authenticEntityScore = matchedAuthenticEntities.length * 80;
    const placeScore = matchedPlaceEntities.length * 30;
    const keywordScore = matchedKeywords.length * 24;
    const semanticScore = authenticEntityScore + placeScore + keywordScore + (categoryHit ? 18 : 0);
    const usagePenalty = Math.min(25, Number(asset.usageCount || 0) * 2 + Number(asset.recentUsageCount || 0));
    return { ...asset, score: semanticScore - usagePenalty, semanticScore, authenticEntityScore, placeScore, keywordScore, usagePenalty, matched, matchedAuthenticEntities, matchedPlaceEntities, matchedKeywords };
  }).sort((a, b) => b.score - a.score || b.semanticScore - a.semanticScore || a.id.localeCompare(b.id));
}
function allowedDownloadUrl(input: string): URL { let url: URL; try { url = new URL(input); } catch { throw new Error('PEXELS_DOWNLOAD_URL_INVALID'); } if (url.protocol !== 'https:' || !['videos.pexels.com', 'images.pexels.com'].includes(url.hostname.toLowerCase())) throw new Error('PEXELS_DOWNLOAD_URL_BLOCKED'); return url; }
export function pickPexelsFile(video: ExternalVideoResult): ExternalVideoFile { const files = video.files.filter((file) => file.url && file.width > 0 && file.height > 0).sort((a, b) => { const orientation = (file: ExternalVideoFile) => file.height / file.width >= 1.2 ? 0 : file.height >= file.width ? 1 : 2; const resolution = (file: ExternalVideoFile) => file.width >= 720 && file.width <= 2160 ? 0 : file.width < 720 ? 1 : 2; return orientation(a) - orientation(b) || resolution(a) - resolution(b) || Math.abs(a.width / a.height - 0.5625) - Math.abs(b.width / b.height - 0.5625) || Math.abs(a.width - 1080) - Math.abs(b.width - 1080) || b.width - a.width; }); const file = files[0]; if (!file) throw new Error('PEXELS_NO_USABLE_VIDEO_FILE'); allowedDownloadUrl(file.url); return file; }
export function rankExternalCandidates(segment: VisualPlanSegmentV1, results: ExternalVideoResult[], used: Set<string> = new Set(), requiredDurationMs = segment.desiredDurationMs): ExternalVideoResult[] {
  return results.filter((result) => result.durationMs >= requiredDurationMs && result.files.some((file) => file.url && file.width > 0 && file.height > 0)).map((result) => { const portrait = result.height >= result.width ? 30 : 0; const quality = result.width >= 720 ? 10 : 0; const unused = used.has(`${result.provider}:${result.assetId}`) ? 0 : 35; return { result, score: portrait + quality + unused }; }).sort((a, b) => b.score - a.score || a.result.assetId.localeCompare(b.result.assetId)).map((item) => item.result);
}

export class PexelsVideoProvider implements ExternalVideoProvider {
  readonly name = 'pexels'; readonly configured: boolean; private rateLimit: RateLimitInfo | undefined;
  constructor(private readonly apiKey = process.env.PEXELS_API_KEY || '', private readonly fetchImpl: typeof fetch = fetch, private readonly timeoutMs = 15_000, private readonly downloadTimeoutMs = 90_000) { this.configured = Boolean(this.apiKey.trim()); }
  private async request(path: string, signal?: AbortSignal): Promise<Response> { if (!this.configured) throw new Error('PEXELS_NOT_CONFIGURED'); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); try { const response = await this.fetchImpl(`https://api.pexels.com${path}`, { headers: { Authorization: this.apiKey }, signal: controller.signal }); this.rateLimit = { limit: Number(response.headers.get('x-ratelimit-limit')) || undefined, remaining: Number(response.headers.get('x-ratelimit-remaining')) || undefined, resetAt: response.headers.get('x-ratelimit-reset') || undefined }; if (!response.ok) throw new Error(`PEXELS_HTTP_${response.status}`); return response; } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); } }
  async search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }> { return this.searchInternal(options, false); }
  private async searchInternal(options: ExternalVideoSearchOptions, bypassCache: boolean): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }> {
    const page = options.page || 1; const perPage = Math.min(20, options.perPage || 8); const key = JSON.stringify({ provider: this.name, query: normalize(options.query), orientation: options.orientation || '', locale: options.locale || '', page, perPage });
    const cached = bypassCache ? undefined : processCache.get(key); if (cached && cached.expiresAt > Date.now()) return { results: cached.value, ...(cached.rateLimit ? { rateLimit: cached.rateLimit } : {}) };
    const params = new URLSearchParams({ query: options.query, page: String(page), per_page: String(perPage), ...(options.orientation ? { orientation: options.orientation } : {}), ...(options.locale ? { locale: options.locale } : {}) }); const response = await this.request(`/videos/search?${params.toString()}`, options.signal); const body = await response.json() as { videos?: Array<Record<string, unknown>> };
    const results = (body.videos || []).map((item) => { const user = item.user as Record<string, unknown> | undefined; const files = Array.isArray(item.video_files) ? item.video_files.map((raw) => { const file = raw as Record<string, unknown>; return { id: String(file.id || ''), width: Number(file.width || 0), height: Number(file.height || 0), durationMs: Number(item.duration || 0) * 1000, url: String(file.link || ''), fileType: String(file.file_type || ''), quality: String(file.quality || '') }; }) : []; return { provider: this.name, assetId: String(item.id || ''), pageUrl: String(item.url || ''), creator: String(user?.name || ''), creatorUrl: String(user?.url || ''), width: Number(item.width || 0), height: Number(item.height || 0), durationMs: Number(item.duration || 0) * 1000, files }; }).filter((item) => item.assetId && item.files.some((file) => file.url));
    if (!bypassCache) processCache.set(key, { expiresAt: Date.now() + 24 * 60 * 60 * 1000, value: results, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }); return { results, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) };
  }
  async download(video: ExternalVideoResult, destination: string, signal?: AbortSignal): Promise<{ fileId: string; bytes: number; contentType: string }> {
    const file = pickPexelsFile(video); const controller = new AbortController(); let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.downloadTimeoutMs); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    try {
      let current = allowedDownloadUrl(file.url); let response: Response | undefined;
      for (let redirect = 0; redirect <= 2; redirect += 1) { try { response = await this.fetchImpl(current.toString(), { redirect: 'manual', signal: controller.signal }); } catch (error) { if (timedOut) throw new Error('PEXELS_DOWNLOAD_TIMEOUT'); throw error; } if (![301, 302, 303, 307, 308].includes(response.status)) break; const location = response.headers.get('location'); if (!location) throw new Error('PEXELS_REDIRECT_INVALID'); current = allowedDownloadUrl(new URL(location, current).toString()); }
      if (!response || !response.ok) throw new Error(`PEXELS_DOWNLOAD_HTTP_${response?.status || 0}`); const contentType = response.headers.get('content-type') || ''; if (!contentType.toLowerCase().startsWith('video/')) throw new Error('PEXELS_DOWNLOAD_CONTENT_TYPE_INVALID'); const maxBytes = 500 * 1024 * 1024; const length = Number(response.headers.get('content-length') || 0); if (length > maxBytes) throw new Error('PEXELS_DOWNLOAD_TOO_LARGE'); if (!response.body) throw new Error('PEXELS_DOWNLOAD_EMPTY'); await mkdir(join(destination, '..'), { recursive: true }); const handle = await import('node:fs/promises').then((fs) => fs.open(destination, 'w')); let bytes = 0; try { for await (const chunk of response.body as AsyncIterable<Uint8Array>) { bytes += chunk.byteLength; if (bytes > maxBytes) throw new Error('PEXELS_DOWNLOAD_TOO_LARGE'); await handle.write(chunk); } } catch (error) { if (timedOut) throw new Error('PEXELS_DOWNLOAD_TIMEOUT'); throw error; } finally { await handle.close(); } return { fileId: file.id, bytes, contentType };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async health(): Promise<{ ok: boolean; message?: string; rateLimit?: RateLimitInfo }> { try { await this.searchInternal({ query: 'abstract', perPage: 1 }, true); return { ok: true, ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }; } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'PEXELS_HEALTH_FAILED', ...(this.rateLimit ? { rateLimit: this.rateLimit } : {}) }; } }
}

export class FakeExternalVideoProvider implements ExternalVideoProvider {
  readonly name = 'fake-pexels'; readonly configured = true; searchCount = 0; downloadCount = 0; constructor(private readonly fixturePath = process.env.CONTENTOS_FAKE_PEXELS_FIXTURE || '') {}
  async search(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[] }> { this.searchCount += 1; if (process.env.CONTENTOS_FAKE_PEXELS_FAILURE === '1') throw new Error('FAKE_PEXELS_UNAVAILABLE'); const q = options.query.trim() || 'abstract'; const base = hash(q).slice(0, 12); return { results: [1, 2].map((index) => ({ provider: this.name, assetId: `fake-${base}-${index}`, pageUrl: `https://www.pexels.com/video/fake-${base}-${index}/`, creator: 'ContentOS Fake', creatorUrl: 'https://www.pexels.com/@contentos-fake', width: 1080, height: 1920, durationMs: 6_000, files: [{ id: `file-${base}-${index}`, width: 1080, height: 1920, durationMs: 6_000, url: `https://videos.pexels.com/fake/contentos-${index}.mp4`, fileType: 'video/mp4', quality: 'hd' }] })) }; }
  async download(video: ExternalVideoResult, destination: string): Promise<{ fileId: string; bytes: number; contentType: string }> { this.downloadCount += 1; if (!this.fixturePath) throw new Error('CONTENTOS_FAKE_PEXELS_FIXTURE_REQUIRED'); await mkdir(join(destination, '..'), { recursive: true }); await copyFile(this.fixturePath, destination); return { fileId: video.files[0]?.id || 'fake-file', bytes: 1, contentType: 'video/mp4' }; }
  async health(): Promise<{ ok: boolean }> { return { ok: process.env.CONTENTOS_FAKE_PEXELS_FAILURE !== '1' }; }
}

const providerHealth = new Map<string, { ok: boolean; message?: string; rateLimit?: RateLimitInfo; checkedAt: string }>();
export function recordProviderHealth(provider: string, status: { ok: boolean; message?: string; rateLimit?: RateLimitInfo }): void { providerHealth.set(provider, { ...status, checkedAt: new Date().toISOString() }); }
export function getProviderHealth(provider: string): { ok?: boolean; message?: string; rateLimit?: RateLimitInfo; checkedAt?: string } { return providerHealth.get(provider) || {}; }
export function createExternalVideoProvider(): ExternalVideoProvider { return process.env.CONTENTOS_FAKE_PEXELS === '1' ? new FakeExternalVideoProvider() : new PexelsVideoProvider(); }

export interface HybridRetrievalResult { assets: PlannerAsset[]; plan: VisualPlanV1; resolvedPlan: ResolvedVisualPlanV1; resolvedAssignments: ResolvedVisualAssignment[]; diagnostics: { localCount: number; externalCount: number; fallbackCount: number; genericFallbackCount: number; queries: string[]; warnings: string[]; sourceStats: { local: number; pexels: number; fallback: number; genericFallback: number }; }; }
function externalIdentity(result: ExternalVideoResult): string { return `${result.provider}:${result.assetId}`; }
function fallbackRole(segment: VisualPlanSegmentV1): 'NEUTRAL_BROLL' | 'PLACE_CONTEXT' { return segment.entityDetails?.some((item) => item.type === 'PLACE') ? 'PLACE_CONTEXT' : 'NEUTRAL_BROLL'; }

export class HybridMediaService {
  constructor(private readonly assetService: AssetService, private readonly storage: LocalStorageProvider, private readonly provider?: ExternalVideoProvider, private readonly db?: Pool) {}
  private async searchCached(options: ExternalVideoSearchOptions): Promise<{ results: ExternalVideoResult[]; rateLimit?: RateLimitInfo }> {
    const page = options.page || 1; const perPage = options.perPage || 8; const key = JSON.stringify({ provider: this.provider?.name || '', query: normalize(options.query), orientation: options.orientation || '', locale: options.locale || '', page, perPage });
    if (this.db) { const row = (await this.db.query('select response, rate_limit from external_media_search_cache where cache_key=$1 and expires_at > now()', [key])).rows[0] as { response?: unknown; rate_limit?: RateLimitInfo } | undefined; if (row?.response) return { results: row.response as ExternalVideoResult[], ...(row.rate_limit ? { rateLimit: row.rate_limit } : {}) }; }
    const response = await this.provider!.search(options); if (this.db) await this.db.query('insert into external_media_search_cache(cache_key,provider,query,orientation,locale,page,per_page,response,rate_limit,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval \'24 hours\') on conflict(cache_key) do update set response=excluded.response,rate_limit=excluded.rate_limit,expires_at=excluded.expires_at', [key, this.provider!.name, options.query, options.orientation || null, options.locale || null, page, perPage, JSON.stringify(response.results), response.rateLimit || null]); return response;
  }
  private async importExternal(workspaceId: string, result: ExternalVideoResult, signal: AbortSignal | undefined): Promise<PlannerAsset> {
    const file = pickPexelsFile(result); const stableProvenance = { provider: result.provider, providerAssetId: result.assetId, providerFileId: file.id, providerPageUrl: result.pageUrl || null, creatorName: result.creator || null, creatorUrl: result.creatorUrl || null, originalWidth: file.width || result.width, originalHeight: file.height || result.height, durationMs: result.durationMs || file.durationMs, downloadedAt: new Date().toISOString() };
    if (this.db) { const row = (await this.db.query('select e.asset_id,a.storage_key,a.metadata from external_media_assets e join assets a on a.id=e.asset_id where e.provider=$1 and e.provider_asset_id=$2 and e.provider_file_id=$3 and a.lifecycle=\'READY\'', [result.provider, result.assetId, file.id])).rows[0] as { asset_id: string; storage_key: string; metadata?: Record<string, unknown> } | undefined; if (row && await this.storage.exists(String(row.storage_key))) { await this.db.query('insert into video_workspace_assets(workspace_id,asset_id,role) values($1,$2,\'SOURCE\') on conflict do nothing', [workspaceId, row.asset_id]); return { id: row.asset_id, storageKey: String(row.storage_key), sourcePath: this.storage.objectPath(String(row.storage_key)), durationMs: result.durationMs || file.durationMs, ...(row.metadata ? { metadata: row.metadata } : { metadata: { external: stableProvenance } }) }; } }
    const temp = join(this.storage.root, 'staging', `hybrid-${hash(`${workspaceId}:${result.provider}:${result.assetId}:${file.id}`)}${extname(file.url) || '.mp4'}`);
    try {
      await this.provider!.download(result, temp, signal);
      const imported = await this.assetService.importFile({ workspaceId, sourcePath: temp, kind: 'VIDEO', role: 'SOURCE', metadata: { external: stableProvenance } });
      if (this.db) await this.db.query('insert into external_media_assets(provider,provider_asset_id,provider_file_id,asset_id,provenance) values($1,$2,$3,$4,$5) on conflict(provider,provider_asset_id,provider_file_id) do update set asset_id=excluded.asset_id,provenance=excluded.provenance,updated_at=now()', [result.provider, result.assetId, file.id, imported.id, JSON.stringify(stableProvenance)]);
      return { id: imported.id, storageKey: imported.storageKey, sourcePath: this.storage.objectPath(imported.storageKey), durationMs: result.durationMs || file.durationMs, metadata: { external: stableProvenance } };
    } finally { await rm(temp, { force: true }).catch(() => undefined); }
  }
  async resolve(input: { workspaceId: string; script: string; localAssets: Array<PlannerAsset & { originalName?: string; tags?: string[]; metadata?: Record<string, unknown> }>; usePexels: boolean; minClipDurationMs?: number; maxClipDurationMs?: number; signal?: AbortSignal }): Promise<HybridRetrievalResult> {
    const minClipDurationMs = input.minClipDurationMs ?? 2_000; const maxClipDurationMs = input.maxClipDurationMs ?? 5_000; const plan = planVisuals(input.script, { minClipDurationMs, maxClipDurationMs }); const chosen: PlannerAsset[] = []; const assignments: ResolvedVisualAssignment[] = []; const resolvedSegments: ResolvedVisualPlanSegmentV1[] = []; let externalCount = 0; const warnings: string[] = []; const usedLocalAssetIds = new Set<string>(); const usedExternalProviderAssets = new Set<string>(); const localUseCount = new Map<string, number>(); const searchResults = new Map<string, ExternalVideoResult[]>();
    for (const segment of plan.segments) {
      if (input.signal?.aborted) throw new Error('EDIT_PREPARE_CANCELLED'); const ranked = rankLocalCandidates(segment, input.localAssets); const authentic = segment.requiresAuthenticEntityVisual; const durationEligible = ranked.filter((candidate) => candidate.durationMs >= segment.desiredDurationMs); const authenticCandidates = durationEligible.filter((candidate) => candidate.matchedAuthenticEntities.length > 0); const relevantCandidates = durationEligible.filter((candidate) => candidate.semanticScore > 0);
      let local = authentic ? (authenticCandidates.find((candidate) => !usedLocalAssetIds.has(candidate.id)) || authenticCandidates[0]) : relevantCandidates.find((candidate) => !usedLocalAssetIds.has(candidate.id));
      let asset = local as PlannerAsset | undefined; let source: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS' = 'LOCAL'; let query: string | undefined; let entityFallback = authentic && !local; let fallback = false; let allowAssetReuse = Boolean(local && localUseCount.has(local.id)); let reuseReason: string | undefined;
      if (!asset && input.usePexels && this.provider) {
        for (const candidateQuery of segment.externalQueries) {
          query = candidateQuery; try { let results = searchResults.get(candidateQuery); if (!results) { results = (await this.searchCached({ query: candidateQuery, orientation: 'portrait', locale: 'zh-CN', perPage: 8, ...(input.signal ? { signal: input.signal } : {}) })).results; searchResults.set(candidateQuery, results); } const rankedExternal = rankExternalCandidates(segment, results, usedExternalProviderAssets); const unusedCandidates = rankedExternal.filter((result) => !usedExternalProviderAssets.has(externalIdentity(result))); const candidate = unusedCandidates[0] || rankedExternal[0]; if (!candidate) continue; const wasReused = unusedCandidates.length === 0; asset = await this.importExternal(input.workspaceId, candidate, input.signal); source = this.provider.name === 'fake-pexels' ? 'FAKE_PEXELS' : 'PEXELS'; externalCount += 1; usedExternalProviderAssets.add(externalIdentity(candidate)); allowAssetReuse = wasReused; if (wasReused) reuseReason = '外部候选已用尽，已明确复用同一素材'; break; } catch (error) { warnings.push(`${candidateQuery}:${error instanceof Error ? error.message : 'external retrieval failed'}`); }
        }
      }
      if (!asset) {
        const generic = durationEligible.find((candidate) => !usedLocalAssetIds.has(candidate.id)) || durationEligible[0] || input.localAssets.find((candidate) => candidate.durationMs >= segment.desiredDurationMs);
        if (!generic) throw new Error(input.usePexels ? 'HYBRID_MEDIA_UNAVAILABLE:当前没有满足镜头时长的本地素材，网络素材服务也暂时不可用。' : 'EDIT_NO_VIDEO_ASSETS');
        asset = generic; source = 'LOCAL'; fallback = true; entityFallback = authentic; allowAssetReuse = localUseCount.has(generic.id); if (allowAssetReuse) reuseReason = '本地素材不足，已明确复用同一素材';
      }
      const adjacentAssetDeduped = chosen.at(-1)?.id === asset.id; if (adjacentAssetDeduped && !allowAssetReuse) { allowAssetReuse = true; reuseReason = '不同外部身份下载后命中同一字节去重 Asset，已显式允许复用'; }
      const rankedLocal = ranked.find((item) => item.id === asset!.id); const matchedKeywords = rankedLocal?.matchedKeywords || []; const reused = allowAssetReuse; const matchScore = entityFallback ? 0 : Math.min(100, rankedLocal?.semanticScore || (source === 'LOCAL' ? 0 : 60)); const resolvedRole = entityFallback ? fallbackRole(segment) : authentic && source === 'LOCAL' ? 'AUTHENTIC_ENTITY' : source === 'LOCAL' ? 'GENERIC_BROLL' : authentic ? fallbackRole(segment) : 'GENERIC_BROLL'; const reason = reuseReason || (fallback ? (entityFallback ? '无真实实体素材，已使用本地 generic fallback' : '无相关素材，已使用本地 generic fallback') : source === 'LOCAL' ? (authentic ? '本地真实实体素材命中' : '本地相关素材命中') : entityFallback ? '外部素材仅作中性补画，不代表真实实体' : '外部素材下载并写入本地缓存');
      localUseCount.set(asset.id, (localUseCount.get(asset.id) || 0) + 1); if (source === 'LOCAL') usedLocalAssetIds.add(asset.id); chosen.push(asset); assignments.push({ segmentIndex: segment.segmentIndex, selectedAssetId: asset.id, selectedSource: source, selectedRole: resolvedRole, entityFallback, fallback, allowAssetReuse: reused, matchScore, ...(query ? { searchQuery: query } : {}), reason, visualIntent: segment.visualIntent, matchedKeywords }); resolvedSegments.push({ ...segment, selectedAssetId: asset.id, selectedSource: source, selectedRole: resolvedRole, entityFallback, fallback, allowAssetReuse: reused, matchScore, reason, ...(query ? { query, searchQuery: query } : {}) });
    }
    const fallbackCount = resolvedSegments.filter((segment) => segment.entityFallback).length; const genericFallbackCount = resolvedSegments.filter((segment) => segment.fallback && !segment.entityFallback).length; return { assets: chosen, plan, resolvedPlan: { schemaVersion: 'RESOLVED_VISUAL_PLAN_V1', plan, segments: resolvedSegments }, resolvedAssignments: assignments, diagnostics: { localCount: chosen.length - externalCount, externalCount, fallbackCount, genericFallbackCount, queries: dedupeExternalQueries(plan), warnings, sourceStats: { local: chosen.length - externalCount, pexels: externalCount, fallback: fallbackCount, genericFallback: genericFallbackCount } } };
  }
}
