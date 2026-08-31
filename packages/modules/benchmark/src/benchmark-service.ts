import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  validateBenchmarkAccountV1,
  validateBenchmarkAnalysisV1,
  validateBenchmarkContentV1,
  type BenchmarkAccountV1,
  type BenchmarkAnalysisV1,
  type BenchmarkContentV1,
} from '../../../contracts/src/index.js';
import { BenchmarkJobService, type BenchmarkAnalyzeJobPayload } from './benchmark-job-service.js';
import type { JobAttemptScope, JobRecord, JobService } from '../../job/src/index.js';

function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function nullableIso(value: unknown): string | undefined { return value ? iso(value) : undefined; }
function list(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }

function mapAccount(row: Record<string, unknown>): BenchmarkAccountV1 {
  return { schemaVersion: 'BENCHMARK_ACCOUNT_V1', id: String(row.id), projectId: String(row.project_id), platform: String(row.platform), accountName: String(row.account_name), ...(row.account_url ? { accountUrl: String(row.account_url) } : {}), positioning: String(row.positioning), category: String(row.category), keywords: list(row.keywords), notes: String(row.notes || ''), createdAt: iso(row.created_at) };
}
function mapContent(row: Record<string, unknown>): BenchmarkContentV1 {
  return { schemaVersion: 'BENCHMARK_CONTENT_V1', id: String(row.id), projectId: String(row.project_id), benchmarkAccountId: String(row.benchmark_account_id), platform: String(row.platform), title: String(row.title), ...(row.url ? { url: String(row.url) } : {}), copy: String(row.copy), ...(row.publish_date ? { publishDate: iso(row.publish_date) } : {}), ...(row.metrics ? { metrics: row.metrics as Record<string, number> } : {}), notes: String(row.notes || ''), createdAt: iso(row.created_at) };
}
function mapAnalysis(row: Record<string, unknown>): BenchmarkAnalysisV1 {
  const value = row.analysis as Record<string, unknown>;
  return { schemaVersion: 'BENCHMARK_ANALYSIS_V1', id: String(row.id), projectId: String(row.project_id), benchmarkContentId: String(row.benchmark_content_id), hook: String(value.hook), openingStructure: String(value.openingStructure), contentStructure: String(value.contentStructure), informationDensity: String(value.informationDensity), rhythm: String(value.rhythm), emotionalChange: String(value.emotionalChange), evidenceUsage: String(value.evidenceUsage), storyOpinionStructure: String(value.storyOpinionStructure), endingCta: String(value.endingCta), titlePattern: String(value.titlePattern), reusableStructure: String(value.reusableStructure), successReasons: list(value.successReasons), lessons: list(value.lessons), doNotCopy: list(value.doNotCopy), aiRunId: String(row.ai_run_id), createdAt: iso(row.created_at) };
}

export interface CreateBenchmarkAccountInput { projectId: string; platform: string; accountName: string; accountUrl?: string; positioning: string; category: string; keywords: string[]; notes?: string; }
export interface CreateBenchmarkContentInput { projectId: string; benchmarkAccountId: string; platform: string; title: string; url?: string; copy: string; publishDate?: string; metrics?: Record<string, number>; notes?: string; }

export class BenchmarkService {
  readonly jobs: BenchmarkJobService;
  constructor(private readonly db: Pool, jobService: JobService) { this.jobs = new BenchmarkJobService(jobService); }

  async createAccount(input: CreateBenchmarkAccountInput): Promise<BenchmarkAccountV1> {
    const account: BenchmarkAccountV1 = { schemaVersion: 'BENCHMARK_ACCOUNT_V1', id: `benchmark-account-${randomUUID()}`, projectId: input.projectId, platform: input.platform, accountName: input.accountName, ...(input.accountUrl ? { accountUrl: input.accountUrl } : {}), positioning: input.positioning, category: input.category, keywords: input.keywords, notes: input.notes || '', createdAt: new Date().toISOString() };
    validateBenchmarkAccountV1(account);
    const result = await this.db.query('insert into benchmark_accounts (id, project_id, platform, account_name, account_url, positioning, category, keywords, notes, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *', [account.id, account.projectId, account.platform, account.accountName, account.accountUrl || null, account.positioning, account.category, JSON.stringify(account.keywords), account.notes, account.createdAt]);
    return mapAccount(result.rows[0] as Record<string, unknown>);
  }
  async listAccounts(projectId: string): Promise<BenchmarkAccountV1[]> { const result = await this.db.query('select * from benchmark_accounts where project_id = $1 order by created_at desc', [projectId]); return result.rows.map((row) => mapAccount(row as Record<string, unknown>)); }
  async createContent(input: CreateBenchmarkContentInput): Promise<BenchmarkContentV1> {
    const account = await this.db.query('select id from benchmark_accounts where id = $1 and project_id = $2', [input.benchmarkAccountId, input.projectId]);
    if (!account.rowCount) throw new Error('Benchmark account not found for project');
    const content: BenchmarkContentV1 = { schemaVersion: 'BENCHMARK_CONTENT_V1', id: `benchmark-content-${randomUUID()}`, projectId: input.projectId, benchmarkAccountId: input.benchmarkAccountId, platform: input.platform, title: input.title, ...(input.url ? { url: input.url } : {}), copy: input.copy, ...(input.publishDate ? { publishDate: input.publishDate } : {}), ...(input.metrics ? { metrics: input.metrics } : {}), notes: input.notes || '', createdAt: new Date().toISOString() };
    validateBenchmarkContentV1(content);
    const result = await this.db.query('insert into benchmark_contents (id, project_id, benchmark_account_id, platform, title, url, copy, publish_date, metrics, notes, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *', [content.id, content.projectId, content.benchmarkAccountId, content.platform, content.title, content.url || null, content.copy, content.publishDate || null, content.metrics ? JSON.stringify(content.metrics) : null, content.notes, content.createdAt]);
    return mapContent(result.rows[0] as Record<string, unknown>);
  }
  async getContent(projectId: string, contentId: string): Promise<BenchmarkContentV1 | null> { const result = await this.db.query('select * from benchmark_contents where project_id = $1 and id = $2', [projectId, contentId]); return result.rows[0] ? mapContent(result.rows[0] as Record<string, unknown>) : null; }
  async listContents(projectId: string): Promise<Array<BenchmarkContentV1 & { accountName: string; analysisCount: number; referenced: boolean }>> {
    const result = await this.db.query('select c.*, a.account_name, (select count(*) from benchmark_analyses an where an.benchmark_content_id = c.id)::int as analysis_count, exists(select 1 from benchmark_references r where r.project_id = c.project_id and r.benchmark_content_id = c.id) as referenced from benchmark_contents c join benchmark_accounts a on a.id = c.benchmark_account_id and a.project_id = c.project_id where c.project_id = $1 order by c.created_at desc', [projectId]);
    return result.rows.map((row) => ({ ...mapContent(row as Record<string, unknown>), accountName: String(row.account_name), analysisCount: Number(row.analysis_count), referenced: Boolean(row.referenced) }));
  }
  async attach(projectId: string, contentId: string): Promise<void> { const exists = await this.db.query('select 1 from benchmark_contents where id = $1 and project_id = $2', [contentId, projectId]); if (!exists.rowCount) throw new Error('Benchmark content not found for project'); await this.db.query('insert into benchmark_references (project_id, benchmark_content_id) values ($1,$2) on conflict do nothing', [projectId, contentId]); }
  async listReferences(projectId: string): Promise<BenchmarkContentV1[]> { const result = await this.db.query('select c.* from benchmark_references r join benchmark_contents c on c.id = r.benchmark_content_id and c.project_id = r.project_id where r.project_id = $1 order by r.created_at desc', [projectId]); return result.rows.map((row) => mapContent(row as Record<string, unknown>)); }
  async listReferenceAnalyses(projectId: string): Promise<BenchmarkAnalysisV1[]> { const result = await this.db.query('select an.* from benchmark_references r join benchmark_analyses an on an.benchmark_content_id = r.benchmark_content_id and an.project_id = r.project_id where r.project_id = $1 order by an.created_at desc', [projectId]); return result.rows.map((row) => mapAnalysis(row as Record<string, unknown>)); }
  async recordAnalysis(input: Omit<BenchmarkAnalysisV1, 'schemaVersion'>, scope?: JobAttemptScope): Promise<BenchmarkAnalysisV1> { const analysis: BenchmarkAnalysisV1 = { schemaVersion: 'BENCHMARK_ANALYSIS_V1', ...input }; validateBenchmarkAnalysisV1(analysis); const query = scope ? scope.query.bind(scope) : this.db.query.bind(this.db); const result = await query('insert into benchmark_analyses (id, project_id, benchmark_content_id, ai_run_id, analysis, created_at) values ($1,$2,$3,$4,$5,$6) returning *', [analysis.id, analysis.projectId, analysis.benchmarkContentId, analysis.aiRunId, JSON.stringify({ hook: analysis.hook, openingStructure: analysis.openingStructure, contentStructure: analysis.contentStructure, informationDensity: analysis.informationDensity, rhythm: analysis.rhythm, emotionalChange: analysis.emotionalChange, evidenceUsage: analysis.evidenceUsage, storyOpinionStructure: analysis.storyOpinionStructure, endingCta: analysis.endingCta, titlePattern: analysis.titlePattern, reusableStructure: analysis.reusableStructure, successReasons: analysis.successReasons, lessons: analysis.lessons, doNotCopy: analysis.doNotCopy }), analysis.createdAt]); return mapAnalysis(result.rows[0] as Record<string, unknown>); }
  async listAnalyses(projectId: string, contentId: string): Promise<BenchmarkAnalysisV1[]> { const result = await this.db.query('select * from benchmark_analyses where project_id = $1 and benchmark_content_id = $2 order by created_at desc', [projectId, contentId]); return result.rows.map((row) => mapAnalysis(row as Record<string, unknown>)); }
  createAnalysisJob(input: Omit<BenchmarkAnalyzeJobPayload, 'schemaVersion'>): Promise<JobRecord> { return this.jobs.createAnalysisJob(input); }
}
