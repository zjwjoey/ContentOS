import assert from 'node:assert/strict';
import test from 'node:test';
import { digitalHumanModeLabel, productionRunStatusLabel, productionStageLabel, productionStepStatusLabel, standardProductionTemplateLabel } from '../../apps/web/app/_lib/display-labels.js';

test('operator display labels keep production and digital-human enums out of user-facing text', () => {
  assert.equal(productionRunStatusLabel('RUNNING'), '进行中');
  assert.equal(productionRunStatusLabel('COMPLETED_WITHOUT_PUBLISH'), '已完成（未发布）');
  assert.equal(productionStepStatusLabel('SKIPPED'), '已跳过');
  assert.equal(productionStageLabel('DIGITAL_HUMAN'), '数字人');
  assert.equal(digitalHumanModeLabel('FULL_TALKING_HEAD'), '全程数字人口播');
  assert.equal(standardProductionTemplateLabel('STANDARD_SHORT_VIDEO'), '标准短视频流程');
});
