import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  validateMetricSnapshotV1,
  validateReviewAnalysisReportV1,
  type MetricSnapshotV1,
  type ReviewAnalysisReportV1,
} from '../../../contracts/src/index.js';
import { ReviewJobService, type PublisherExternalPostReader } from './review-job-service.js';
import type { JobRecord, JobService } from '../../job/src/index.js';

function iso(value: unknown): string { return new Date(String(value)).toISOString(); }
function nullableIso(value: unknown): string | null { return value ? iso(value) : null; }

function mapSnapshot(row: Record<string, unknown>): MetricSnapshotV1 {
  return {
    schemaVersion: 'METRIC_SNAPSHOT_V1',
    id: String(row.id),
    projectId: String(row.project_id),
    externalPostId: String(row.external_post_id),
    platformId: String(row.platform_id),
    capturedAt: iso(row.captured_at),
    publishedAt: nullableIso(row.published_at),
    metrics: row.metrics as MetricSnapshotV1['metrics'],
    source: String(row.source) as MetricSnapshotV1['source'],
    sourceReference: String(row.source_reference),
    createdAt: iso(row.created_at),
  };
}

function mapReport(row: Record<string, unknown>): ReviewAnalysisReportV1 {
  return {
    schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1',
    id: String(row.id),
    projectId: String(row.project_id),
    externalPostId: String(row.external_post_id),
    metricSnapshotIds: (row.metric_snapshot_ids as string[]) || [],
    summary: String(row.summary),
    highlights: (row.highlights as ReviewAnalysisReportV1['highlights']) || [],
    risks: (row.risks as ReviewAnalysisReportV1['risks']) || [],
    recommendations: (row.recommendations as ReviewAnalysisReportV1['recommendations']) || [],
    aiRunId: String(row.ai_run_id),
    createdAt: iso(row.created_at),
  };
}

export interface RecordMetricSnapshotInput extends Omit<MetricSnapshotV1, 'id' | 'createdAt' | 'schemaVersion'> {
  id?: string;
  createdAt?: string;
}

export class ReviewAnalyticsService {
  readonly jobs: ReviewJobService;

  constructor(private readonly db: Pool, jobService: JobService, posts: PublisherExternalPostReader) {
    this.jobs = new ReviewJobService(jobService, posts);
  }

  createMetricCollectionJob(input: Parameters<ReviewJobService['createMetricCollectionJob']>[0]): Promise<JobRecord> {
    return this.jobs.createMetricCollectionJob(input);
  }

  createAnalysisJob(input: Parameters<ReviewJobService['createAnalysisJob']>[0]): Promise<JobRecord> {
    return this.jobs.createAnalysisJob(input);
  }

  async recordMetricSnapshot(input: RecordMetricSnapshotInput): Promise<MetricSnapshotV1> {
    const snapshot: MetricSnapshotV1 = {
      schemaVersion: 'METRIC_SNAPSHOT_V1',
      id: input.id || `review-snapshot-${randomUUID()}`,
      projectId: input.projectId,
      externalPostId: input.externalPostId,
      platformId: input.platformId,
      capturedAt: input.capturedAt,
      publishedAt: input.publishedAt,
      metrics: input.metrics,
      source: input.source,
      sourceReference: input.sourceReference,
      createdAt: input.createdAt || new Date().toISOString(),
    };
    validateMetricSnapshotV1(snapshot);
    const result = await this.db.query(
      'insert into review_metric_snapshots (id, project_id, external_post_id, platform_id, captured_at, published_at, metrics, source, source_reference, schema_version, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) on conflict (external_post_id, source, captured_at) do update set id = review_metric_snapshots.id returning *',
      [snapshot.id, snapshot.projectId, snapshot.externalPostId, snapshot.platformId, snapshot.capturedAt, snapshot.publishedAt, snapshot.metrics, snapshot.source, snapshot.sourceReference, snapshot.schemaVersion, snapshot.createdAt],
    );
    return mapSnapshot(result.rows[0] as Record<string, unknown>);
  }

  async listMetricSnapshots(projectId: string, externalPostId: string): Promise<MetricSnapshotV1[]> {
    const result = await this.db.query('select * from review_metric_snapshots where project_id = $1 and external_post_id = $2 order by captured_at desc, id desc', [projectId, externalPostId]);
    return result.rows.map((row) => mapSnapshot(row as Record<string, unknown>));
  }

  async getMetricSnapshots(projectId: string, externalPostId: string, ids: string[]): Promise<MetricSnapshotV1[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query('select * from review_metric_snapshots where project_id = $1 and external_post_id = $2 and id = any($3::text[]) order by captured_at asc, id asc', [projectId, externalPostId, ids]);
    return result.rows.map((row) => mapSnapshot(row as Record<string, unknown>));
  }

  async recordAnalysisReport(report: ReviewAnalysisReportV1): Promise<ReviewAnalysisReportV1> {
    validateReviewAnalysisReportV1(report);
    const result = await this.db.query(
      'insert into review_analysis_reports (id, project_id, external_post_id, metric_snapshot_ids, schema_version, summary, highlights, risks, recommendations, ai_run_id, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning *',
      [report.id, report.projectId, report.externalPostId, report.metricSnapshotIds, report.schemaVersion, report.summary, report.highlights, report.risks, report.recommendations, report.aiRunId, report.createdAt],
    );
    return mapReport(result.rows[0] as Record<string, unknown>);
  }

  async listAnalysisReports(projectId: string, externalPostId: string): Promise<ReviewAnalysisReportV1[]> {
    const result = await this.db.query('select * from review_analysis_reports where project_id = $1 and external_post_id = $2 order by created_at desc, id desc', [projectId, externalPostId]);
    return result.rows.map((row) => mapReport(row as Record<string, unknown>));
  }
}
