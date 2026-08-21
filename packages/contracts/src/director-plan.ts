export interface DirectorBrief {
  topic: string;
  audience: string;
  objective: string;
  tone: string;
}

export interface DirectorScene {
  id: string;
  title: string;
  narration: string;
  visualIntent: string;
  durationMs: number;
  sourceAssetIds: string[];
}

export interface DirectorPlanV0 {
  schemaVersion: 'DIRECTOR_PLAN_V0';
  projectId: string;
  seed: number;
  brief: DirectorBrief;
  storyboard: DirectorScene[];
  provenance: { author: string; source: 'manual' | 'ai-draft'; promptVersion?: string; modelProfile?: string };
}

function required(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

export function validateDirectorPlan(plan: DirectorPlanV0): void {
  if (plan.schemaVersion !== 'DIRECTOR_PLAN_V0') throw new Error('Unsupported director plan schema');
  required(plan.projectId, 'projectId');
  if (!Number.isInteger(plan.seed)) throw new Error('seed must be an integer');
  required(plan.brief.topic, 'brief.topic');
  required(plan.brief.audience, 'brief.audience');
  required(plan.brief.objective, 'brief.objective');
  required(plan.brief.tone, 'brief.tone');
  required(plan.provenance.author, 'provenance.author');
  if (plan.storyboard.length === 0) throw new Error('storyboard must contain at least one scene');
  const ids = new Set<string>();
  for (const scene of plan.storyboard) {
    required(scene.id, 'scene.id');
    if (ids.has(scene.id)) throw new Error(`duplicate scene id: ${scene.id}`);
    ids.add(scene.id);
    required(scene.title, 'scene.title');
    required(scene.narration, 'scene.narration');
    required(scene.visualIntent, 'scene.visualIntent');
    if (!Number.isInteger(scene.durationMs) || scene.durationMs <= 0) throw new Error('scene.durationMs must be positive');
    if (new Set(scene.sourceAssetIds).size !== scene.sourceAssetIds.length) throw new Error(`duplicate source asset in scene: ${scene.id}`);
  }
}
