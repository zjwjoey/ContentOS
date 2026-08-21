# AI Provider Contract V0

## Boundary

AI is provider-neutral infrastructure. Director and Review call this contract; they never import vendor SDKs or credentials.

## Operations

```text
supports(capability, modelProfile) -> CapabilityResult
generateText(request) -> TextResult
generateStructured(request, outputSchema) -> StructuredResult
streamText(request) -> bounded stream + final validated result
```

Each request declares capability, prompt version, input/output schema, model profile, timeout, cost/token limits and correlation ID. Each result records provider/model identifiers, usage bucket, prompt version and normalized outcome.

## Rules

- Structured output is schema-validated before Director acceptance.
- Prompt versions are immutable and AI runs retain provenance and a non-secret rendered-input hash.
- Provider credentials are opaque `CredentialRef`s resolved only by infrastructure.
- Provider errors are normalized; fallback changes are explicit and recorded.
- Streaming is transport only; creative truth is the final validated accepted revision.
