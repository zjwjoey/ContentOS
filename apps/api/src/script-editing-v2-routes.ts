import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { compileEditorialManifest, planEditorialScript, resolveEditorialPlan, type EditorialAssetV1 } from '../../../packages/modules/video/src/index.js';
import type { JobService } from '../../../packages/modules/job/src/index.js';

const inputSchema = z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1).optional(), script: z.string().min(1), sentences: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string().min(1), normalizedText: z.string().min(1), voiceStartMs: z.number().nonnegative().optional(), voiceEndMs: z.number().positive().optional(), durationMs: z.number().positive().optional() })).optional(), assets: z.array(z.object({ id: z.string().min(1), path: z.string().min(1), durationMs: z.number().positive(), source: z.enum(['LOCAL', 'PEXELS', 'FAKE_PEXELS']), entity: z.string().optional(), keywords: z.array(z.string()).optional() })).default([]), template: z.enum(['COMMERCIAL_OPINION', 'NEWS', 'STORE_PROMOTION', 'PRODUCT_INTRO']).default('COMMERCIAL_OPINION'), pace: z.enum(['SLOW', 'NORMAL', 'FAST']).default('NORMAL'), shotDensity: z.number().min(.5).max(2).default(1), heroText: z.boolean().default(true), seed: z.number().int().default(1), voiceAssetId: z.string().optional(), voicePath: z.string().optional(), backgroundMusic: z.object({ path: z.string().min(1), volume: z.number().min(0).max(1).default(.12), ducking: z.object({ enabled: z.boolean(), voiceVolume: z.number().min(0).max(1).optional(), musicVolume: z.number().min(0).max(1).optional() }).optional() }).optional() });
async function authorizeMusicPath(path: string): Promise<string> {
  const candidate = await realpath(path).catch(() => null);
  if (!candidate || !(await stat(candidate).then((value) => value.isFile()).catch(() => false))) throw new Error('MUSIC_PATH_INVALID');
  const roots = (process.env.CONTENTOS_MUSIC_ROOTS || '').split(';').map((value) => value.trim()).filter(Boolean);
  const authorized = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)));
  if (!authorized.some((root) => root && (candidate.toLowerCase() === root.toLowerCase() || candidate.toLowerCase().startsWith(`${root}${sep}`.toLowerCase())))) throw new Error('MUSIC_PATH_UNAUTHORIZED');
  return candidate;
}

export function registerScriptEditingV2Routes(app: FastifyInstance, dependencies: { db: Pool; jobs: JobService }): void {
  app.post('/api/v1/edit/script-plans', async (request, reply) => {
    const parsed = inputSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(422).send({ error: { code: 'VALIDATION_ERROR', details: parsed.error.issues } });
    const input = parsed.data; if (input.backgroundMusic) input.backgroundMusic.path = await authorizeMusicPath(input.backgroundMusic.path);
    const sentences = (input.sentences ?? [{ index: 0, text: input.script, normalizedText: input.script.normalize('NFKC').toLowerCase() }]).map((sentence) => ({ index: sentence.index, text: sentence.text, normalizedText: sentence.normalizedText, ...(sentence.voiceStartMs !== undefined ? { voiceStartMs: sentence.voiceStartMs } : {}), ...(sentence.voiceEndMs !== undefined ? { voiceEndMs: sentence.voiceEndMs } : {}), ...(sentence.durationMs !== undefined ? { durationMs: sentence.durationMs } : {}) }));
    const draft = planEditorialScript({ sentences, template: input.template, pace: input.pace, shotDensity: input.shotDensity, heroText: input.heroText });
    const resolved = input.assets.length ? resolveEditorialPlan(draft, input.assets as EditorialAssetV1[], input.seed) : null;
    const id = randomUUID();
    await dependencies.db.query('insert into edit_script_plans (id, workspace_id, script, template_id, settings, editorial_plan, resolved_plan, status, revision) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, input.workspaceId, input.script, input.template, { pace: input.pace, shotDensity: input.shotDensity, heroText: input.heroText, seed: input.seed, voiceAssetId: input.voiceAssetId, voicePath: input.voicePath, backgroundMusic: input.backgroundMusic }, draft, resolved, resolved ? 'READY' : 'DRAFT', 1]);
    const job = await dependencies.jobs.createIdempotent({ id: `job-${id}`, type: 'EDIT_SCRIPT_PLAN', projectId: input.projectId ?? null, workspaceId: input.workspaceId, payload: { schemaVersion: 'EDIT_SCRIPT_PLAN_V1', planId: id }, idempotencyKey: `edit-script-plan:${id}`, maxAttempts: 3 });
    await dependencies.db.query('update edit_script_plans set job_id = $2, status = case when status = \'READY\' then status else \'QUEUED\' end where id = $1', [id, job.id]);
    return reply.code(201).send({ id, status: resolved ? 'READY' : 'QUEUED', revision: 1, editorialPlan: draft, resolvedPlan: resolved });
  });
  app.get('/api/v1/edit/script-plans/:id', async (request, reply) => {
    const result = await dependencies.db.query('select * from edit_script_plans where id = $1', [(request.params as { id: string }).id]);
    if (!result.rows[0]) return reply.code(404).send({ error: { code: 'SCRIPT_PLAN_NOT_FOUND' } });
    const row = result.rows[0] as Record<string, unknown>;
    return { id: String(row.id), status: row.status, revision: Number(row.revision), editorialPlan: row.editorial_plan, resolvedPlan: row.resolved_plan, jobId: row.job_id };
  });
  app.patch('/api/v1/edit/script-plans/:id/clips/:clipId', async (request, reply) => {
    const params = request.params as { id: string; clipId: string }; const body = request.body as { locked?: boolean; assetId?: string };
    const result = await dependencies.db.query('select resolved_plan, revision from edit_script_plans where id=$1', [params.id]); const row = result.rows[0] as { resolved_plan?: Record<string, unknown>; revision: number } | undefined;
    if (!row?.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    const plan = structuredClone(row.resolved_plan) as { scenes: Array<{ clipSlots: Array<{ id: string; locked?: boolean; asset?: { id: string } }> }> };
    const slot = plan.scenes.flatMap((scene) => scene.clipSlots).find((candidate) => candidate.id === params.clipId);
    if (!slot) return reply.code(404).send({ error: { code: 'SCRIPT_CLIP_NOT_FOUND' } });
    if (body.locked !== undefined) slot.locked = body.locked;
    if (body.assetId && slot.asset) slot.asset = { ...slot.asset, id: body.assetId };
    const revision = Number(row.revision) + 1;
    await dependencies.db.query('update edit_script_plans set resolved_plan=$2,revision=$3,updated_at=now() where id=$1', [params.id, plan, revision]);
    return { id: params.id, revision, resolvedPlan: plan };
  });
  app.post('/api/v1/edit/script-plans/:id/reroll', async (request, reply) => {
    const params = request.params as { id: string }; const result = await dependencies.db.query('select resolved_plan, revision from edit_script_plans where id=$1', [params.id]); const row = result.rows[0] as { resolved_plan?: Record<string, unknown>; revision: number } | undefined;
    if (!row?.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    const plan = structuredClone(row.resolved_plan) as { scenes: Array<{ clipSlots: Array<{ id: string; locked?: boolean; asset?: unknown }> }> }; const clipId = (request.body as { clipId?: string } | undefined)?.clipId;
    const slots = plan.scenes.flatMap((scene) => scene.clipSlots).filter((slot) => !clipId || slot.id === clipId); for (const slot of slots) if (!slot.locked) slot.asset = undefined;
    const revision = Number(row.revision) + 1; await dependencies.db.query('update edit_script_plans set resolved_plan=$2,revision=$3,status=\'DRAFT\',updated_at=now() where id=$1', [params.id, plan, revision]); return { id: params.id, revision, status: 'DRAFT', resolvedPlan: plan };
  });
  app.post('/api/v1/edit/script-plans/:id/render', async (request, reply) => {
    const result = await dependencies.db.query('select * from edit_script_plans where id = $1', [(request.params as { id: string }).id]); const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: { code: 'SCRIPT_PLAN_NOT_FOUND' } });
    if (row.status !== 'READY' || !row.resolved_plan) return reply.code(409).send({ error: { code: 'SCRIPT_PLAN_NOT_READY' } });
    const body = (request.body || {}) as { voicePath?: string; voiceAssetId?: string; backgroundMusic?: { path: string; volume: number; ducking?: { enabled: boolean; voiceVolume?: number; musicVolume?: number } } };
    const plan = row.resolved_plan as Parameters<typeof compileEditorialManifest>[0];
    const manifest = compileEditorialManifest(plan, { workspaceId: String(row.workspace_id), seed: Number((row.settings as Record<string, unknown> | null)?.seed || 1), ...(body.voicePath ? { voicePath: body.voicePath } : {}), ...(body.voiceAssetId ? { voiceAssetId: body.voiceAssetId } : {}), ...(body.backgroundMusic ? { backgroundMusic: body.backgroundMusic } : {}) });
    return { status: 'RENDERING', revision: Number(row.revision), manifest };
  });
}
