import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { compileEditorialManifest, digestEditManifest, planEditorialScript, rerollEditorialClip, resolveEditorialPlan, segmentScriptSentences, type EditorialAssetV1, type VideoService } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';
import type { EditManifestV0 } from '../../../packages/contracts/src/index.js';
import type { AssetCatalogService } from '../../../packages/modules/asset/src/index.js';
import type { LocalStorageProvider } from '../../../packages/infrastructure/storage/src/index.js';
import type { VideoEditPresetService } from '../../../packages/modules/video/src/index.js';

const inputSchema = z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1).optional(), script: z.string().min(1), sentences: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string().min(1), normalizedText: z.string().min(1), voiceStartMs: z.number().nonnegative().optional(), voiceEndMs: z.number().positive().optional(), durationMs: z.number().positive().optional() })).optional(), assets: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), durationMs: z.number().positive(), source: z.enum(['LOCAL', 'PEXELS', 'FAKE_PEXELS']), entity: z.string().optional(), keywords: z.array(z.string()).optional(), originalName: z.string().optional(), tags: z.array(z.string()).optional(), sourceInMs: z.number().nonnegative().optional(), author: z.string().optional() })).default([]), sourceRoots: z.array(z.string().min(1)).default([]), usePexels: z.boolean().default(false), priorityAssets: z.array(z.object({ assetId: z.string().min(1), mode: z.enum(['PREFER', 'MUST_USE']), path: z.string().optional() })).default([]), knownEntities: z.array(z.string()).default([]), manualKeywords: z.array(z.string()).default([]), template: z.enum(['COMMERCIAL_OPINION', 'NEWS', 'STORE_PROMOTION', 'PRODUCT_INTRO']).default('COMMERCIAL_OPINION'), pace: z.enum(['SLOW', 'NORMAL', 'FAST']).optional(), shotDensity: z.union([z.enum(['LOW', 'MEDIUM', 'HIGH']), z.number().min(.5).max(2)]).optional(), subtitleStyle: z.enum(['simple', 'commercial', 'emphasis', 'news']).optional(), heroText: z.boolean().default(true), heroTextPolicy: z.array(z.enum(['HOOK', 'ENDING', 'EVIDENCE'])).optional(), seed: z.number().int().default(1), voiceAssetId: z.string().optional(), voicePath: z.string().optional(), backgroundMusicMode: z.enum(['NONE', 'AUTO', 'SPECIFIED']).default('NONE'), backgroundMusicCategory: z.string().optional(), backgroundMusic: z.object({ assetId: z.string().optional(), path: z.string().min(1), volume: z.number().min(0).max(1).default(.12), loop: z.boolean().default(true), category: z.string().optional(), ducking: z.object({ enabled: z.boolean(), voiceVolume: z.number().min(0).max(1).optional(), musicVolume: z.number().min(0).max(1).optional() }).optional() }).optional(), introEnabled: z.boolean().optional(), outroEnabled: z.boolean().optional(), brandingPresetId: z.string().optional() });
async function authorizeMusicPath(path: string): Promise<string> {
  const candidate = await realpath(path).catch(() => null);
  if (!candidate || !(await stat(candidate).then((value) => value.isFile()).catch(() => false))) throw new Error('MUSIC_PATH_INVALID');
  const roots = (process.env.CONTENTOS_MUSIC_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean);
  const authorized = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)));
  if (!authorized.some((root) => root && (candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())))) throw new Error('MUSIC_PATH_UNAUTHORIZED');
  return candidate;
}
async function authorizeLocalFile(path: string): Promise<string> {
  const candidate = await realpath(path).catch(() => null); if (!candidate || !(await stat(candidate).then((value) => value.isFile()).catch(() => false))) throw new Error('LOCAL_MEDIA_FILE_NOT_FOUND');
  const roots = (process.env.CONTENTOS_LOCAL_MEDIA_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean);
  const authorized = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)));
  if (!authorized.some((root) => root && (candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())))) throw new Error('LOCAL_MEDIA_FILE_UNAUTHORIZED');
  return candidate;
}

export function registerScriptEditingV2Routes(app: FastifyInstance, dependencies: { db: Pool; jobs: JobService; video?: VideoService; assets?: AssetCatalogService; presets?: VideoEditPresetService; storage?: LocalStorageProvider }): void {
  app.post('/api/v1/edit/script-plans', async (request, reply) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } });
    const input = parsed.data;
    try { if (input.backgroundMusic) input.backgroundMusic.path = await authorizeMusicPath(input.backgroundMusic.path); if (input.voicePath) input.voicePath = await authorizeLocalFile(input.voicePath); for (const priority of input.priorityAssets) if (priority.path) priority.path = await authorizeLocalFile(priority.path); }
    catch (error) { return reply.code(422).send({ error: { code: error instanceof Error ? error.message : 'MUSIC_PATH_UNAUTHORIZED' } }); }
    const sentences = (input.sentences ?? segmentScriptSentences(input.script)).map((sentence) => {
      const value = sentence as { index: number; text: string; normalizedText: string; voiceStartMs?: number; voiceEndMs?: number; durationMs?: number };
      return { index: value.index, text: value.text, normalizedText: value.normalizedText, ...(typeof value.voiceStartMs === 'number' ? { voiceStartMs: value.voiceStartMs } : {}), ...(typeof value.voiceEndMs === 'number' ? { voiceEndMs: value.voiceEndMs } : {}), ...(typeof value.durationMs === 'number' ? { durationMs: value.durationMs } : {}) };
    });
    const draft = planEditorialScript({ sentences, template: input.template, ...(input.pace ? { pace: input.pace } : {}), ...(input.shotDensity !== undefined ? { shotDensity: input.shotDensity } : {}), ...(input.subtitleStyle ? { subtitleStyle: input.subtitleStyle } : {}), heroText: input.heroText, ...(input.heroTextPolicy ? { heroTextPolicy: input.heroTextPolicy } : {}), knownEntities: input.knownEntities, manualKeywords: input.manualKeywords, audioPlan: { backgroundMusicMode: input.backgroundMusicMode, ...(input.backgroundMusicCategory ? { category: input.backgroundMusicCategory } : {}), ...(input.backgroundMusic ? { path: input.backgroundMusic.path, volume: input.backgroundMusic.volume, duckingEnabled: input.backgroundMusic.ducking?.enabled ?? true } : {}) }, brandingPlan: { ...(input.introEnabled !== undefined ? { introEnabled: input.introEnabled } : {}), ...(input.outroEnabled !== undefined ? { outroEnabled: input.outroEnabled } : {}), ...(input.brandingPresetId ? { brandingPresetId: input.brandingPresetId } : {}) } });
    const priorityAssets = input.priorityAssets.map((item) => ({ assetId: item.assetId, mode: item.mode, ...(item.path ? { path: item.path } : {}) }));
    let resolved: ReturnType<typeof resolveEditorialPlan> | null = null;
    try { if (input.assets.length) resolved = resolveEditorialPlan(draft, input.assets as EditorialAssetV1[], input.seed, { priorityAssets }); }
    catch (error) { return reply.code(422).send({ error: { code: error instanceof Error ? error.message.split(':')[0] : 'EDIT_PLAN_RESOLVE_FAILED' } }); }
    const id = randomUUID();
    const needsVoicePlanning = Boolean(input.voicePath || input.voiceAssetId);
    await dependencies.db.query("insert into video_workspaces (id, type, project_id) values ($1, 'STANDALONE', null) on conflict (id) do nothing", [input.workspaceId]);
    await dependencies.db.query('insert into edit_script_plans (id, workspace_id, script, voice_asset_id, template_id, settings, source_roots, editorial_plan, resolved_plan, status, revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, input.workspaceId, input.script, input.voiceAssetId ?? null, input.template, { pace: input.pace, shotDensity: input.shotDensity, heroText: input.heroText, heroTextPolicy: input.heroTextPolicy, subtitleStyle: input.subtitleStyle, seed: input.seed, voiceAssetId: input.voiceAssetId, voicePath: input.voicePath, assets: input.assets, sourceRoots: input.sourceRoots, usePexels: input.usePexels, priorityAssets: priorityAssets, knownEntities: input.knownEntities, manualKeywords: input.manualKeywords, backgroundMusicMode: input.backgroundMusicMode, backgroundMusicCategory: input.backgroundMusicCategory, backgroundMusic: input.backgroundMusic, branding: { introEnabled: input.introEnabled, outroEnabled: input.outroEnabled, brandingPresetId: input.brandingPresetId } }, input.sourceRoots, draft, needsVoicePlanning ? null : resolved, resolved && !needsVoicePlanning ? 'READY' : 'DRAFT', 1]);
    const job = await dependencies.jobs.createIdempotent({ id: `job-${id}`, type: 'EDIT_SCRIPT_PLAN', projectId: input.projectId ?? null, workspaceId: input.workspaceId, payload: { schemaVersion: 'EDIT_SCRIPT_PLAN_V1', planId: id }, idempotencyKey: `edit-script-plan:${id}`, maxAttempts: 3 });
    await dependencies.db.query('update edit_script_plans set job_id = $2, status = case when status = \'READY\' then status else \'QUEUED\' end where id = $1', [id, job.id]);
    return reply.code(201).send({ id, status: resolved && !needsVoicePlanning ? 'READY' : 'QUEUED', revision: 1, editorialPlan: draft, resolvedPlan: resolved && !needsVoicePlanning ? resolved : null });
  });
  app.get('/api/v1/edit/script-plans', async (request) => {
    const limit = Math.min(100, Math.max(1, Number((request.query as { limit?: string } | undefined)?.limit || 50)));
    const result = await dependencies.db.query('select id,status,revision,template_id,script,editorial_plan,resolved_plan,created_at,updated_at,current_manifest_id from edit_script_plans order by updated_at desc limit $1', [limit]);
    return { items: result.rows.map((row) => {
      const editorial = row.editorial_plan && typeof row.editorial_plan === 'object' ? row.editorial_plan as { scenes?: unknown[]; textOverlays?: unknown[]; subtitles?: unknown[]; audioPlan?: { path?: string } } : {};
      const resolved = row.resolved_plan && typeof row.resolved_plan === 'object' ? row.resolved_plan as { scenes?: Array<{ clipSlots?: Array<{ asset?: { source?: string } }> }> } : {};
      const clips = (resolved.scenes || []).flatMap((scene) => scene.clipSlots || []);
      return { id: String(row.id), status: String(row.status), revision: Number(row.revision), templateId: String(row.template_id), script: String(row.script), sceneCount: Number(editorial.scenes?.length || 0), clipCount: clips.length, localCount: clips.filter((clip) => clip.asset?.source === 'LOCAL').length, pexelsCount: clips.filter((clip) => clip.asset?.source === 'PEXELS' || clip.asset?.source === 'FAKE_PEXELS').length, subtitleEnabled: Boolean(editorial.subtitles?.length), bgmEnabled: Boolean(editorial.audioPlan?.path), currentManifestId: row.current_manifest_id ? String(row.current_manifest_id) : undefined, createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
    }) };
  });
  app.post('/api/v1/edit/script-plans/:id/copy', async (request, reply) => {
    const sourceId = (request.params as { id: string }).id;
    const source = (await dependencies.db.query('select workspace_id,script,voice_asset_id,template_id,settings,source_roots,editorial_plan from edit_script_plans where id=$1', [sourceId])).rows[0] as Record<string, unknown> | undefined;
    if (!source) return reply.code(404).send({ error: { code: 'SCRIPT_PLAN_NOT_FOUND' } });
    const id = randomUUID();
    await dependencies.db.query('insert into edit_script_plans (id,workspace_id,script,voice_asset_id,template_id,settings,source_roots,editorial_plan,resolved_plan,status,revision) values ($1,$2,$3,$4,$5,$6,$7,$8,null,$9,1)', [id, source.workspace_id, source.script, source.voice_asset_id ?? null, source.template_id, source.settings || {}, source.source_roots || [], source.editorial_plan || null, 'DRAFT']);
    const job = await dependencies.jobs.createIdempotent({ id: `job-${id}`, type: 'EDIT_SCRIPT_PLAN', projectId: null, workspaceId: String(source.workspace_id), payload: { schemaVersion: 'EDIT_SCRIPT_PLAN_V1', planId: id, operation: 'COPY_PLAN', sourcePlanId: sourceId }, idempotencyKey: `edit-script-plan:${id}`, maxAttempts: 3 });
    await dependencies.db.query("update edit_script_plans set job_id=$2,status='QUEUED',updated_at=now() where id=$1", [id, job.id]);
    return reply.code(201).send({ id, status: 'QUEUED', revision: 1 });
  });
  app.get('/api/v1/edit/script-plans/:id', async (request, reply) => {
    const result = await dependencies.db.query('select * from edit_script_plans where id = $1', [(request.params as { id: string }).id]);
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'SCRIPT_PLAN_NOT_FOUND' } });
    const row = result.rows[0] as Record<string, unknown>;
    return { id: String(row.id), status: row.status, revision: Number(row.revision), editorialPlan: row.editorial_plan, resolvedPlan: row.resolved_plan };
  });
  app.patch('/api/v1/edit/script-plans/:id/clips/:clipId', async (request, reply) => {
    const params = request.params as { id: string; clipId: string }; const body = request.body as { locked?: boolean; assetId?: string };
    const result = await dependencies.db.query('select resolved_plan, settings, revision from edit_script_plans where id=$1', [params.id]); const row = result.rows[0] as { resolved_plan?: Record<string, unknown>; settings?: Record<string, unknown>; revision: number } | undefined;
    if (!row?.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    const plan = structuredClone(row.resolved_plan) as { scenes: Array<{ clipSlots: Array<{ id: string; locked?: boolean; asset?: { id: string; path: string; durationMs: number; source: 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS' } }> }> };
    const slot = plan.scenes.flatMap((scene) => scene.clipSlots).find((candidate) => candidate.id === params.clipId);
    if (!slot) return reply.code(404).send({ error: { code: 'SCRIPT_CLIP_NOT_FOUND' } });
    if (body.locked !== undefined) slot.locked = body.locked;
    if (body.assetId) { const assets = Array.isArray(row.settings?.assets) ? row.settings.assets as Array<{ id: string; path?: string; durationMs?: number; source?: string }> : []; const candidate = assets.find((asset) => asset.id === body.assetId); if (!candidate) return reply.code(422).send({ error: { code: 'SCRIPT_ASSET_NOT_IN_CANDIDATES' } }); if (slot.asset && candidate.path && candidate.durationMs && candidate.source) slot.asset = { ...slot.asset, id: candidate.id, path: candidate.path, durationMs: candidate.durationMs, source: candidate.source as 'LOCAL' | 'PEXELS' | 'FAKE_PEXELS' }; }
    const revision = Number(row.revision) + 1;
    await dependencies.db.query("update edit_script_plans set resolved_plan=$2,revision=$3,status='READY',updated_at=now() where id=$1", [params.id, plan, revision]);
    return { id: params.id, revision, status: 'READY', resolvedPlan: plan };
  });
  app.post('/api/v1/edit/script-plans/:id/reroll', async (request, reply) => {
    const params = request.params as { id: string }; const result = await dependencies.db.query('select resolved_plan, settings, revision, workspace_id from edit_script_plans where id=$1', [params.id]); const row = result.rows[0] as { resolved_plan?: Record<string, unknown>; settings?: Record<string, unknown>; revision: number; workspace_id: string } | undefined;
    if (!row?.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    const settings = row.settings ?? {}; const assets = Array.isArray(settings.assets) ? settings.assets as EditorialAssetV1[] : []; const clipId = (request.body as { clipId?: string } | undefined)?.clipId; let plan = row.resolved_plan as Parameters<typeof rerollEditorialClip>[0];
    if (clipId) plan = rerollEditorialClip(plan, assets, clipId, { localOnly: Boolean((request.body as { localOnly?: boolean } | undefined)?.localOnly) });
    else for (const slot of plan.scenes.flatMap((scene) => scene.clipSlots).filter((slot) => !slot.locked)) { try { plan = rerollEditorialClip(plan, assets, slot.id); } catch { break; } }
    const revision = Number(row.revision) + 1; await dependencies.db.query("update edit_script_plans set resolved_plan=$2,revision=$3,status='QUEUED',updated_at=now() where id=$1", [params.id, plan, revision]);
    const job = await dependencies.jobs.createIdempotent({ id: `job-reroll-${params.id}-${revision}`, type: 'EDIT_SCRIPT_PLAN', projectId: null, workspaceId: row.workspace_id, payload: { schemaVersion: 'EDIT_SCRIPT_PLAN_V1', planId: params.id, operation: 'REROLL_CLIP', clipId }, idempotencyKey: `edit-script-plan:${params.id}:revision:${revision}`, maxAttempts: 3 });
    return { id: params.id, revision, status: 'QUEUED', resolvedPlan: plan };
  });
  app.post('/api/v1/edit/script-plans/:id/render', async (request, reply) => {
    const result = await dependencies.db.query('select * from edit_script_plans where id = $1', [(request.params as { id: string }).id]); const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'SCRIPT_PLAN_NOT_FOUND' } });
    if (row.status !== 'READY' || !row.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    if (!dependencies.video) return reply.code(503).send({ error: { code: 'VIDEO_SERVICE_UNAVAILABLE' } });
    const settings = row.settings && typeof row.settings === 'object' ? row.settings as Record<string, unknown> : {};
    const plan = row.resolved_plan as Parameters<typeof compileEditorialManifest>[0];
    const backgroundMusic = settings.backgroundMusic && typeof settings.backgroundMusic === 'object' ? settings.backgroundMusic as NonNullable<EditManifestV0['audio']['backgroundMusic']> : undefined;
    let intro: Parameters<typeof compileEditorialManifest>[1]['intro']; let outro: Parameters<typeof compileEditorialManifest>[1]['outro'];
    if (dependencies.assets && dependencies.storage && dependencies.presets && (plan.brandingPlan.introEnabled || plan.brandingPlan.outroEnabled)) {
      const preset = plan.brandingPlan.brandingPresetId ? await dependencies.presets.get(plan.brandingPlan.brandingPresetId) : await dependencies.presets.getDefault();
      if (!preset) return reply.code(422).send({ error: { code: 'EDIT_BRANDING_PRESET_NOT_FOUND' } });
      const loadBranding = async (assetId: string | null, role: 'INTRO' | 'OUTRO'): Promise<NonNullable<typeof intro>> => {
        if (!assetId) throw new Error(`EDIT_BRANDING_${role}_MISSING`);
        const content = await dependencies.assets!.getReadyGlobalVideoAssetContent(assetId);
        if (!content) throw new Error(`EDIT_BRANDING_${role}_UNAVAILABLE`);
        return { id: content.id, path: dependencies.storage!.objectPath(content.storageKey), durationMs: Number(content.metadata.durationMs || 0), source: 'LOCAL', originalName: content.originalName };
      };
      try { if (plan.brandingPlan.introEnabled) intro = await loadBranding(preset.introAssetId, 'INTRO'); if (plan.brandingPlan.outroEnabled) outro = await loadBranding(preset.outroAssetId, 'OUTRO'); }
      catch (error) { return reply.code(422).send({ error: { code: error instanceof Error ? error.message : 'EDIT_BRANDING_ASSET_UNAVAILABLE' } }); }
    }
    const manifest = compileEditorialManifest(plan, { workspaceId: String(row.workspace_id), seed: Number(settings.seed || 1), ...(row.voice_asset_id ? { voiceAssetId: String(row.voice_asset_id) } : {}), ...(typeof settings.voicePath === 'string' ? { voicePath: settings.voicePath } : {}), ...(backgroundMusic ? { backgroundMusic } : {}), ...(intro ? { intro } : {}), ...(outro ? { outro } : {}), planId: String(row.id), revision: Number(row.revision) });
    const existing = await dependencies.db.query<{ id: string; revision: number; manifest: EditManifestV0 }>("select id, revision, manifest from edit_manifests where workspace_id=$1 and manifest->'metadata'->>'editorialPlanId'=$2 and (manifest->'metadata'->>'editorialRevision')::int=$3 limit 1", [String(row.workspace_id), String(row.id), Number(row.revision)]);
    const manifestId = existing.rows[0]?.id ?? `manifest-${randomUUID()}`;
    if (!existing.rows[0]) await dependencies.db.query('insert into edit_manifests (id, project_id, workspace_id, revision, schema_version, manifest, manifest_digest, status) values ($1,null,$2,$3,$4,$5,$6,$7)', [manifestId, String(row.workspace_id), Number(row.revision), 'EDIT_MANIFEST_V0', manifest, digestEditManifest(manifest), 'PERSISTED']);
    const job = await dependencies.video.createManifestRenderJobForWorkspace(String(row.workspace_id), manifestId, `editorial-plan:${row.id}:revision:${Number(row.revision)}`);
    await dependencies.db.query("update edit_script_plans set status='RENDERING',current_manifest_id=$2,updated_at=now() where id=$1", [String(row.id), manifestId]);
    return { status: 'RENDERING', revision: Number(row.revision), manifest: manifest, planId: String(row.id) };
  });
}
