import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReviewAnalysisReportV1 } from '../../packages/contracts/src/index.js';
import { FakeAIProvider } from '../../packages/modules/ai/src/fake-provider.js';
import { PromptRegistry } from '../../packages/modules/ai/src/prompt-registry.js';

test('review analysis prompt renders required variables and FakeAIProvider returns structured output', async () => {
  const registry = new PromptRegistry();
  const rendered = registry.render('review.analysis.v1', {
    platformId: 'fake-platform',
    publishedAt: '2026-08-30T12:00:00.000Z',
    metrics: '{"plays":100}',
    history: '[]',
  });
  assert.equal(rendered.promptVersion.key, 'review.analysis.v1');
  const result = await new FakeAIProvider().generateStructured({
    requestId: 'request',
    promptKey: 'review.analysis.v1',
    promptVersion: 1,
    modelProfileId: 'profile',
    input: rendered.input,
    maxOutputTokens: 1000,
  });
  const output = result.output as Record<string, unknown>;
  assert.equal(typeof output.summary, 'string');
  assert.ok(Array.isArray(output.recommendations));
  validateReviewAnalysisReportV1({
    schemaVersion: 'REVIEW_ANALYSIS_REPORT_V1',
    id: 'report',
    projectId: 'project',
    externalPostId: 'post',
    metricSnapshotIds: ['snapshot'],
    summary: String(output.summary),
    highlights: output.highlights as never,
    risks: output.risks as never,
    recommendations: output.recommendations as never,
    aiRunId: 'run',
    createdAt: '2026-08-30T12:00:00.000Z',
  });
});

test('review analysis prompt requires all declared variables', () => {
  const registry = new PromptRegistry();
  assert.throws(() => registry.render('review.analysis.v1', { platformId: 'fake-platform', publishedAt: '', metrics: '{}', history: '[]' }), /publishedAt/);
});
