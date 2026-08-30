import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { validateModelProfile, type AIRequest, type AIResult, type ModelProfile } from '../../../contracts/src/index.js';
import { AIProviderError, normalizeProviderError, type AIProvider } from './ai-provider.js';
import { PromptRegistry } from './prompt-registry.js';

export type AIOperation = 'DIRECTOR_GENERATE_SCRIPT' | 'DIRECTOR_GENERATE_STORYBOARD' | 'REVIEW_GENERATE_ANALYSIS';
export interface AIGenerationInput {
  projectId: string;
  jobId: string;
  attemptId: string;
  correlationId: string;
  operation: AIOperation;
  promptKey: string;
  variables: Record<string, string>;
  maxOutputTokens?: number;
  temperature?: number;
}
export interface AIServiceResult<T> extends AIResult<T> {
  aiRunId: string;
  promptVersionId: string;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class AIService {
  constructor(
    private readonly db: Pool,
    private readonly provider: AIProvider,
    private readonly registry: PromptRegistry,
    private readonly modelProfile: ModelProfile,
  ) {
    validateModelProfile(modelProfile);
  }

  async generateText(input: AIGenerationInput): Promise<AIServiceResult<string>> {
    return this.execute(input, 'TEXT', (value) => String(value));
  }

  async generateStructured<T>(input: AIGenerationInput, validator: (value: unknown) => T | void): Promise<AIServiceResult<T>> {
    return this.execute(input, 'STRUCTURED', validator);
  }

  private async execute<T>(input: AIGenerationInput, capability: 'TEXT' | 'STRUCTURED', validator: (value: unknown) => T | void): Promise<AIServiceResult<T>> {
    if (this.modelProfile.providerId !== this.provider.providerId) throw new AIProviderError('INVALID_REQUEST', 'Model profile provider mismatch', false);
    if (!this.modelProfile.enabled || !this.provider.supports(capability))
      throw new AIProviderError('INVALID_REQUEST', `Provider does not support ${capability}`, false);
    const rendered = this.registry.render(input.promptKey, input.variables);
    const catalogProfileId = await this.ensureCatalog(rendered.promptVersion, rendered.template);
    const request: AIRequest = {
      requestId: randomUUID(),
      promptKey: input.promptKey,
      promptVersion: rendered.promptVersion.version,
      modelProfileId: catalogProfileId,
      input: rendered.input,
      maxOutputTokens: input.maxOutputTokens ?? this.modelProfile.maxOutputTokens,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    };
    const aiRunId = randomUUID();
    const baseSnapshot = {
      promptKey: input.promptKey,
      promptVersion: rendered.promptVersion.version,
      variables: input.variables,
      renderedInput: rendered.input,
    };
    try {
      const result = capability === 'TEXT' ? ((await this.provider.generateText(request)) as AIResult<T>) : await this.provider.generateStructured<T>(request);
      const validated = validator(result.output);
      const output = validated === undefined ? result.output : validated;
      await this.persistRun(aiRunId, input, request, rendered.promptVersion.id, baseSnapshot, result, 'SUCCEEDED');
      return { ...result, output, aiRunId, promptVersionId: rendered.promptVersion.id };
    } catch (error) {
      const normalized =
        error instanceof AIProviderError
          ? error
          : new AIProviderError(
              capability === 'STRUCTURED' ? 'INVALID_STRUCTURED_OUTPUT' : 'UNKNOWN',
              error instanceof Error ? error.message : 'AI generation failed',
              false,
            );
      await this.persistRun(aiRunId, input, request, rendered.promptVersion.id, baseSnapshot, null, 'FAILED', {
        code: normalized.code,
        message: normalized.message,
      });
      throw normalized;
    }
  }

  private async ensureCatalog(
    prompt: { id: string; key: string; version: number; templateHash: string; requiredVariables: string[] },
    template: string,
  ): Promise<string> {
    await this.db.query(
      'insert into ai_prompt_versions (id, key, version, template_hash, template, required_variables) values ($1, $2, $3, $4, $5, $6) on conflict (key, version) do nothing',
      [prompt.id, prompt.key, prompt.version, prompt.templateHash, template, JSON.stringify(prompt.requiredVariables)],
    );
    await this.db.query(
      'insert into ai_model_profiles (id, provider_id, model_id, display_name, capabilities, max_input_characters, max_output_tokens, enabled) values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (provider_id, model_id) do update set display_name = excluded.display_name, capabilities = excluded.capabilities, max_input_characters = excluded.max_input_characters, max_output_tokens = excluded.max_output_tokens, enabled = excluded.enabled, updated_at = now()',
      [
        this.modelProfile.id,
        this.modelProfile.providerId,
        this.modelProfile.modelId,
        this.modelProfile.displayName,
        JSON.stringify(this.modelProfile.capabilities),
        this.modelProfile.maxInputCharacters,
        this.modelProfile.maxOutputTokens,
        this.modelProfile.enabled,
      ],
    );
    const result = await this.db.query<{ id: string }>('select id from ai_model_profiles where provider_id = $1 and model_id = $2', [
      this.modelProfile.providerId,
      this.modelProfile.modelId,
    ]);
    if (!result.rows[0]) throw new Error('AI model profile was not persisted');
    return result.rows[0].id;
  }

  private async persistRun<T>(
    aiRunId: string,
    input: AIGenerationInput,
    request: AIRequest,
    promptVersionId: string,
    baseSnapshot: unknown,
    result: AIResult<T> | null,
    status: 'SUCCEEDED' | 'FAILED',
    error?: { code: string; message: string },
  ): Promise<void> {
    const output = result?.output ?? null;
    await this.db.query(
      'insert into ai_runs (id, project_id, job_id, attempt_id, run_number, request_id, correlation_id, operation, provider_id, model_profile_id, prompt_version_id, input_hash, input_snapshot, output_hash, output_snapshot, status, usage, error, finished_at) values ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())',
      [
        aiRunId,
        input.projectId,
        input.jobId,
        input.attemptId,
        request.requestId,
        input.correlationId,
        input.operation,
        result?.providerId ?? this.provider.providerId,
        request.modelProfileId,
        promptVersionId,
        hash(baseSnapshot),
        JSON.stringify(baseSnapshot),
        output === null ? null : hash(output),
        output === null ? null : JSON.stringify(output),
        status,
        JSON.stringify(result?.usage ?? {}),
        error ? JSON.stringify(error) : null,
      ],
    );
  }
}
