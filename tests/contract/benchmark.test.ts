import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBenchmarkAccountV1,
  validateBenchmarkContentV1,
  validateBenchmarkAnalysisV1,
  type BenchmarkAccountV1,
  type BenchmarkContentV1,
  type BenchmarkAnalysisV1,
} from '../../packages/contracts/src/index.js';

const account: BenchmarkAccountV1 = {
  schemaVersion: 'BENCHMARK_ACCOUNT_V1', id: 'benchmark-account-1', projectId: 'project-1', platform: 'douyin', accountName: '示例账号',
  accountUrl: 'https://example.com/account', positioning: '门店经营', category: '知识', keywords: ['门店', '经营'], notes: '人工录入', createdAt: new Date().toISOString(),
};
const content: BenchmarkContentV1 = {
  schemaVersion: 'BENCHMARK_CONTENT_V1', id: 'benchmark-content-1', projectId: 'project-1', benchmarkAccountId: account.id, platform: account.platform,
  title: '先验证再增长', url: 'https://example.com/post', copy: '先验证真实需求。', publishDate: new Date().toISOString(), metrics: { plays: 100 }, notes: '', createdAt: new Date().toISOString(),
};
const analysis: BenchmarkAnalysisV1 = {
  schemaVersion: 'BENCHMARK_ANALYSIS_V1', id: 'benchmark-analysis-1', projectId: 'project-1', benchmarkContentId: content.id,
  hook: '问题开场', openingStructure: '先抛结论', contentStructure: '三步法', informationDensity: '高', rhythm: '快', emotionalChange: '平→紧', evidenceUsage: '案例', storyOpinionStructure: '观点+证据', endingCta: '收藏', titlePattern: '结果型', reusableStructure: '问题-方法-行动', successReasons: ['清晰'], lessons: ['强化开头'], doNotCopy: ['原句'], aiRunId: 'ai-run-1', createdAt: new Date().toISOString(),
};

test('Benchmark V1 contracts validate account, content and analysis records', () => {
  assert.doesNotThrow(() => validateBenchmarkAccountV1(account));
  assert.doesNotThrow(() => validateBenchmarkContentV1(content));
  assert.doesNotThrow(() => validateBenchmarkAnalysisV1(analysis));
});

test('Benchmark V1 contracts reject missing project ownership and bounded fields', () => {
  assert.throws(() => validateBenchmarkAccountV1({ ...account, projectId: '' }), /projectId/);
  assert.throws(() => validateBenchmarkContentV1({ ...content, benchmarkAccountId: '' }), /benchmarkAccountId/);
  assert.throws(() => validateBenchmarkAnalysisV1({ ...analysis, lessons: [] }), /lessons/);
});
