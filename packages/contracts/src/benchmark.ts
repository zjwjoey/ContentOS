export interface BenchmarkAccountV1 {
  schemaVersion: 'BENCHMARK_ACCOUNT_V1';
  id: string;
  projectId: string;
  platform: string;
  accountName: string;
  accountUrl?: string;
  positioning: string;
  category: string;
  keywords: string[];
  notes: string;
  createdAt: string;
}

export interface BenchmarkContentV1 {
  schemaVersion: 'BENCHMARK_CONTENT_V1';
  id: string;
  projectId: string;
  benchmarkAccountId: string;
  platform: string;
  title: string;
  url?: string;
  copy: string;
  publishDate?: string;
  metrics?: Record<string, number>;
  notes: string;
  createdAt: string;
}

export interface BenchmarkAnalysisV1 {
  schemaVersion: 'BENCHMARK_ANALYSIS_V1';
  id: string;
  projectId: string;
  benchmarkContentId: string;
  hook: string;
  openingStructure: string;
  contentStructure: string;
  informationDensity: string;
  rhythm: string;
  emotionalChange: string;
  evidenceUsage: string;
  storyOpinionStructure: string;
  endingCta: string;
  titlePattern: string;
  reusableStructure: string;
  successReasons: string[];
  lessons: string[];
  doNotCopy: string[];
  aiRunId: string;
  createdAt: string;
}

function text(value: unknown, field: string, max = 20_000): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
  if (value.length > max) throw new Error(`${field} exceeds maximum length`);
}
function id(value: unknown, field: string): void { text(value, field, 200); }
function notes(value: unknown, field: string): void { if (typeof value !== 'string' || value.length > 5_000) throw new Error(`${field} must be text`); }
function list(value: unknown, field: string, maxItems = 32): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new Error(`${field} must contain between 1 and ${maxItems} items`);
  value.forEach((item, index) => text(item, `${field}[${index}]`, 2_000));
}
function optionalUrl(value: unknown, field: string): void { if (value !== undefined) text(value, field, 2_000); }

export function validateBenchmarkAccountV1(account: BenchmarkAccountV1): void {
  if (account.schemaVersion !== 'BENCHMARK_ACCOUNT_V1') throw new Error('Unsupported BenchmarkAccount schema');
  id(account.id, 'id'); id(account.projectId, 'projectId'); text(account.platform, 'platform', 100); text(account.accountName, 'accountName', 500); optionalUrl(account.accountUrl, 'accountUrl'); text(account.positioning, 'positioning'); text(account.category, 'category', 200); list(account.keywords, 'keywords'); notes(account.notes, 'notes'); text(account.createdAt, 'createdAt', 100);
}
export function validateBenchmarkContentV1(content: BenchmarkContentV1): void {
  if (content.schemaVersion !== 'BENCHMARK_CONTENT_V1') throw new Error('Unsupported BenchmarkContent schema');
  id(content.id, 'id'); id(content.projectId, 'projectId'); id(content.benchmarkAccountId, 'benchmarkAccountId'); text(content.platform, 'platform', 100); text(content.title, 'title', 1_000); optionalUrl(content.url, 'url'); text(content.copy, 'copy'); if (content.publishDate !== undefined) text(content.publishDate, 'publishDate', 100); if (content.metrics !== undefined && (typeof content.metrics !== 'object' || Array.isArray(content.metrics) || Object.values(content.metrics).some((value) => typeof value !== 'number' || value < 0 || !Number.isFinite(value)))) throw new Error('metrics must contain non-negative numbers'); notes(content.notes, 'notes'); text(content.createdAt, 'createdAt', 100);
}
export function validateBenchmarkAnalysisV1(analysis: BenchmarkAnalysisV1): void {
  if (analysis.schemaVersion !== 'BENCHMARK_ANALYSIS_V1') throw new Error('Unsupported BenchmarkAnalysis schema');
  id(analysis.id, 'id'); id(analysis.projectId, 'projectId'); id(analysis.benchmarkContentId, 'benchmarkContentId');
  for (const [field, value] of Object.entries({ hook: analysis.hook, openingStructure: analysis.openingStructure, contentStructure: analysis.contentStructure, informationDensity: analysis.informationDensity, rhythm: analysis.rhythm, emotionalChange: analysis.emotionalChange, evidenceUsage: analysis.evidenceUsage, storyOpinionStructure: analysis.storyOpinionStructure, endingCta: analysis.endingCta, titlePattern: analysis.titlePattern, reusableStructure: analysis.reusableStructure })) text(value, field);
  list(analysis.successReasons, 'successReasons'); list(analysis.lessons, 'lessons'); list(analysis.doNotCopy, 'doNotCopy'); id(analysis.aiRunId, 'aiRunId'); text(analysis.createdAt, 'createdAt', 100);
}
