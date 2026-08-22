export type AIProviderCapability = 'TEXT' | 'STRUCTURED' | 'EMBEDDING';
export type ProviderErrorCode = 'UNAVAILABLE' | 'RATE_LIMITED' | 'AUTHENTICATION_FAILED' | 'INVALID_REQUEST' | 'INVALID_STRUCTURED_OUTPUT' | 'UNKNOWN';

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AIRequest {
  requestId: string;
  promptKey: string;
  promptVersion: number;
  modelProfileId: string;
  input: string;
  maxOutputTokens: number;
  temperature?: number;
}

export interface AIResult<T> {
  requestId: string;
  providerId: string;
  modelId: string;
  output: T;
  usage: AIUsage;
}

export interface AIProvider {
  readonly providerId: string;
  supports(capability: AIProviderCapability): boolean;
  generateText(request: AIRequest): Promise<AIResult<string>>;
  generateStructured<T>(request: AIRequest): Promise<AIResult<T>>;
}

export interface ModelProfile {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  capabilities: AIProviderCapability[];
  maxInputCharacters: number;
  maxOutputTokens: number;
  enabled: boolean;
}

export interface PromptVersion {
  id: string;
  key: string;
  version: number;
  templateHash: string;
  requiredVariables: string[];
}

function required(value: unknown, field: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
  if (value.length > max) throw new Error(`${field} exceeds maximum length`);
}

export function validateAIRequest(request: AIRequest): void {
  required(request.requestId, 'requestId'); required(request.promptKey, 'promptKey'); required(request.modelProfileId, 'modelProfileId');
  required(request.input, 'input', 20_000); if (!Number.isInteger(request.promptVersion) || request.promptVersion <= 0) throw new Error('promptVersion must be positive');
  if (!Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0 || request.maxOutputTokens > 16_000) throw new Error('maxOutputTokens must be between 1 and 16000');
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new Error('temperature must be between 0 and 2');
}

export function validateModelProfile(profile: ModelProfile): void {
  required(profile.id, 'id'); required(profile.providerId, 'providerId'); required(profile.modelId, 'modelId'); required(profile.displayName, 'displayName');
  if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) throw new Error('capabilities must be non-empty');
  if (!Number.isInteger(profile.maxInputCharacters) || profile.maxInputCharacters <= 0 || profile.maxInputCharacters > 100_000) throw new Error('maxInputCharacters is out of range');
  if (!Number.isInteger(profile.maxOutputTokens) || profile.maxOutputTokens <= 0 || profile.maxOutputTokens > 16_000) throw new Error('maxOutputTokens is out of range');
}

export function validatePromptVersion(prompt: PromptVersion): void {
  required(prompt.id, 'id'); required(prompt.key, 'key'); required(prompt.templateHash, 'templateHash', 200);
  if (!Number.isInteger(prompt.version) || prompt.version <= 0) throw new Error('version must be positive');
  if (!Array.isArray(prompt.requiredVariables) || prompt.requiredVariables.some((variable) => typeof variable !== 'string' || variable.trim().length === 0)) throw new Error('requiredVariables must contain non-empty strings');
}
