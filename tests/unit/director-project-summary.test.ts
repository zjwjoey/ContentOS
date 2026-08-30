import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectorV1Service } from '../../packages/modules/director/src/index.js';

test('Director V1 project summary reads targets and readiness from one state snapshot', async () => {
  const statements: string[] = [];
  const db = {
    query: async (statement: string) => {
      statements.push(statement);
      if (statement.includes('left join director_script_revisions')) {
        return {
          rows: [{
            active_script_aggregate_id: 'script-aggregate-current',
            active_script_revision_id: 'script-revision-current',
            active_storyboard_aggregate_id: 'storyboard-aggregate-current',
            active_storyboard_revision_id: 'storyboard-revision-current',
            brief_id: 'brief-current',
            script_id: 'script-revision-current',
            script_status: 'ACCEPTED',
            storyboard_id: 'storyboard-revision-current',
            storyboard_status: 'APPROVED',
          }],
        };
      }
      return { rows: [{ active_brief_id: null, active_script_revision_id: null, active_storyboard_revision_id: null }] };
    },
  };

  const summary = await new DirectorV1Service(db as never).getProjectSummary('project-summary');

  assert.deepEqual(summary, {
    source: 'V1',
    hasRevision: true,
    readyForVideo: true,
    activeScript: { aggregateId: 'script-aggregate-current', revisionId: 'script-revision-current' },
    activeStoryboard: { aggregateId: 'storyboard-aggregate-current', revisionId: 'storyboard-revision-current' },
    legacyRevisionId: null,
  });
  assert.equal(statements.length, 1);
});
