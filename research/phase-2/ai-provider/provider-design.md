# ContentOS AI Provider V0

## Architecture

```text
Director use case
  -> AIService (role selection, prompt rendering, audit)
  -> ModelRegistry (role -> enabled model config)
  -> LLMProviderRegistry (provider key -> implementation)
  -> OpenAI | Anthropic | Gemini | DeepSeek | Qwen | Local provider
```

## V0 interface

```text
supports(capability) -> boolean
generateText(request) -> TextResult
generateStructured(request, schema) -> StructuredResult<T>
streamText(request, onDelta) -> StreamResult
```

Every request contains `model_config_id`, prompt version/reference, messages, generation options, correlation/project ID and an idempotency key. Every result records provider/model identifier, usage if available, latency, finish reason and request-safe diagnostic metadata. Providers never expose API keys in request logs or job outputs.

## Capabilities and registry

V0 capabilities: `text`, `structured_output`, `streaming`. Reserve `vision` and `tools` but do not require providers to implement them. A `ModelConfig` stores provider key, external model id, enabled status, capabilities, limits and non-secret parameters. Director roles (`copy`, `storyboard`, `review`, later `vision`) map to a config ID, allowing different models without business-code conditions.

## Structured output

`generateStructured` is mandatory for storyboards. The AIService validates returned JSON against the requested schema, attempts at most one provider-agnostic repair prompt only when policy permits, then fails with a non-ambiguous validation error. Do not silently coerce malformed output into a render job.

## Prompt system

Persist `PromptTemplate(key, version, body, variable_schema, status)` and immutable `PromptRun(prompt_key, version, rendered_hash, job_id/project_id)`. Start with source-controlled seed templates plus database records for approved overrides; version, never mutate, an already-used prompt. This supports traceability and later A/B experiments without building a prompt-management SaaS.

## Error policy

Retry transient network, rate-limit and provider 5xx errors under bounded backoff. Do not retry invalid credentials, capability mismatch, invalid input/schema or policy refusal automatically. Normalize all provider errors into `ProviderError(category, retryable, provider_request_id, safe_message)`.
