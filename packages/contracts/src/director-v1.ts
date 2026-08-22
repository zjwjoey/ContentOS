export type DirectorRevisionOrigin = 'AI' | 'MANUAL' | 'IMPORTED';
export type ScriptRevisionStatus = 'DRAFT' | 'ACCEPTED' | 'SUPERSEDED';
export type StoryboardRevisionStatus = 'DRAFT' | 'APPROVED' | 'SUPERSEDED';

export interface ContentBriefV1 {
  schemaVersion: 'CONTENT_BRIEF_V1';
  id: string;
  projectId: string;
  revision: number;
  topic: string;
  targetPlatform: string;
  channelPositioning: string;
  targetDurationSeconds: number;
  contentType: string;
  audience: string;
  coreThesis: string;
  tone: string;
  ctaGoal?: string;
  referenceMaterial: string;
  mustInclude: string[];
  mustAvoid: string[];
  requirements: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptRevisionV1 {
  schemaVersion: 'SCRIPT_REVISION_V1';
  id: string;
  projectId: string;
  briefId: string;
  revision: number;
  parentRevisionId?: string;
  origin: DirectorRevisionOrigin;
  status: ScriptRevisionStatus;
  title: string;
  titleCandidates: string[];
  coverText: string;
  topicKeywords: string[];
  hook: string;
  body: string;
  cta?: string;
  sourceJobId?: string;
  aiRunId?: string;
  promptVersionId?: string;
  createdBy: string;
  createdAt: string;
}

export interface StoryboardSceneV1 {
  sceneIndex: number;
  voiceoverText: string;
  durationHintSeconds: number;
  visualInstruction: string;
  assetKeywords: string[];
}

export interface StoryboardRevisionV1 {
  schemaVersion: 'STORYBOARD_REVISION_V1';
  id: string;
  projectId: string;
  scriptRevisionId: string;
  revision: number;
  origin: DirectorRevisionOrigin;
  status: StoryboardRevisionStatus;
  scenes: StoryboardSceneV1[];
  sourceJobId?: string;
  aiRunId?: string;
  promptVersionId?: string;
  createdBy: string;
  createdAt: string;
}

const MAX_TEXT_LENGTH = 20_000;

function text(value: unknown, field: string, max = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
  if (value.length > max) throw new Error(`${field} exceeds maximum length`);
}

function positiveRevision(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
}

function boundedDuration(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 1 || value > 600) throw new Error(`${field} must be between 1 and 600 seconds`);
}

function nonEmptyList(values: string[], field: string, maxItems = 32): void {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems) throw new Error(`${field} must contain between 1 and ${maxItems} items`);
  values.forEach((value, index) => text(value, `${field}[${index}]`, 2_000));
}

function commonIds(value: { id: string; projectId: string; createdBy: string; createdAt: string }): void {
  text(value.id, 'id', 200); text(value.projectId, 'projectId', 200); text(value.createdBy, 'createdBy', 200); text(value.createdAt, 'createdAt', 100);
}

export function validateContentBriefV1(brief: ContentBriefV1): void {
  if (brief.schemaVersion !== 'CONTENT_BRIEF_V1') throw new Error('Unsupported ContentBrief schema');
  commonIds(brief); positiveRevision(brief.revision, 'revision');
  text(brief.topic, 'topic'); text(brief.targetPlatform, 'targetPlatform', 100); text(brief.channelPositioning, 'channelPositioning');
  boundedDuration(brief.targetDurationSeconds, 'targetDurationSeconds'); text(brief.contentType, 'contentType', 100);
  text(brief.audience, 'audience'); text(brief.coreThesis, 'coreThesis'); text(brief.tone, 'tone');
  if (brief.ctaGoal !== undefined) text(brief.ctaGoal, 'ctaGoal');
  text(brief.referenceMaterial, 'referenceMaterial'); nonEmptyList(brief.mustInclude, 'mustInclude'); nonEmptyList(brief.mustAvoid, 'mustAvoid');
  if (brief.requirements === null || typeof brief.requirements !== 'object' || Array.isArray(brief.requirements)) throw new Error('requirements must be an object');
  text(brief.updatedAt, 'updatedAt', 100);
}

export function validateScriptRevisionV1(script: ScriptRevisionV1): void {
  if (script.schemaVersion !== 'SCRIPT_REVISION_V1') throw new Error('Unsupported ScriptRevision schema');
  commonIds(script); text(script.briefId, 'briefId', 200); positiveRevision(script.revision, 'revision');
  if (!['AI', 'MANUAL', 'IMPORTED'].includes(script.origin)) throw new Error('origin is invalid');
  if (!['DRAFT', 'ACCEPTED', 'SUPERSEDED'].includes(script.status)) throw new Error('status is invalid');
  if (script.parentRevisionId !== undefined) text(script.parentRevisionId, 'parentRevisionId', 200);
  text(script.title, 'title', 500); nonEmptyList(script.titleCandidates, 'titleCandidates', 8); text(script.coverText, 'coverText', 500);
  nonEmptyList(script.topicKeywords, 'topicKeywords', 32); text(script.hook, 'hook'); text(script.body, 'body');
  if (script.cta !== undefined) text(script.cta, 'cta');
  for (const [field, value] of [['sourceJobId', script.sourceJobId], ['aiRunId', script.aiRunId], ['promptVersionId', script.promptVersionId]] as const) {
    if (value !== undefined) text(value, field, 200);
  }
}

export function validateStoryboardRevisionV1(storyboard: StoryboardRevisionV1): void {
  if (storyboard.schemaVersion !== 'STORYBOARD_REVISION_V1') throw new Error('Unsupported StoryboardRevision schema');
  commonIds(storyboard); text(storyboard.scriptRevisionId, 'scriptRevisionId', 200); positiveRevision(storyboard.revision, 'revision');
  if (!['AI', 'MANUAL', 'IMPORTED'].includes(storyboard.origin)) throw new Error('origin is invalid');
  if (!['DRAFT', 'APPROVED', 'SUPERSEDED'].includes(storyboard.status)) throw new Error('status is invalid');
  if (!Array.isArray(storyboard.scenes) || storyboard.scenes.length === 0 || storyboard.scenes.length > 100) throw new Error('scenes must contain between 1 and 100 items');
  const indexes = new Set<number>();
  for (const scene of storyboard.scenes) {
    if (!Number.isInteger(scene.sceneIndex) || scene.sceneIndex <= 0) throw new Error('sceneIndex must be positive');
    if (indexes.has(scene.sceneIndex)) throw new Error(`duplicate sceneIndex: ${scene.sceneIndex}`);
    indexes.add(scene.sceneIndex); text(scene.voiceoverText, 'voiceoverText'); boundedDuration(scene.durationHintSeconds, 'durationHintSeconds'); text(scene.visualInstruction, 'visualInstruction'); nonEmptyList(scene.assetKeywords, 'assetKeywords', 16);
  }
  for (const [field, value] of [['sourceJobId', storyboard.sourceJobId], ['aiRunId', storyboard.aiRunId], ['promptVersionId', storyboard.promptVersionId]] as const) {
    if (value !== undefined) text(value, field, 200);
  }
}
