# AI Module V0

## Boundary

AI provides a provider-neutral generation and evaluation boundary. It owns provider profiles, capability declarations, model registry entries, prompt templates/versions, AI run records, usage and normalized error outcomes. Creative truth remains in Director.

## Provider contract

The only V0 service operations are `supports(capability)`, `generateText`, `generateStructured` and `streamText`. A caller declares capability, input schema, output schema, prompt version, parameters, timeout and correlation ID. The provider adapter returns normalized content, usage, provider/model identifiers and an error category.

| Capability | Example caller | Required behavior |
|---|---|---|
| text generation | Director script draft | return bounded text and provenance |
| structured generation | Director storyboard | validate against caller schema before acceptance |
| embedding/evaluation (future) | Review | capability-gated; no implicit fallback |

## Governance

- `ModelRegistry` decides which enabled provider/model may serve a logical capability.
- `PromptTemplate` has immutable version IDs; runs store the exact version and non-secret rendered-input hash.
- Provider credentials are `CredentialRef`s resolved by infrastructure, never stored in prompts, run records or logs.
- Timeout, maximum cost/token and fallback policy are explicit per profile. Fallback changes are recorded in the run.
- Streaming is a transport convenience, not durable creative acceptance; the final validated result becomes an AI run outcome.

## Dependencies

AI is infrastructure-facing and may depend on secret/config ports and provider SDK adapters. It must not import Director, Video or Publisher. Callers depend on its public application contract rather than a particular provider.
