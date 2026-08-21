# AnythingLLM: Provider Registry Evidence

## Evidence

The pinned repository exposes independent provider families under `server/utils`: `AiProviders`, `EmbeddingEngines`, `vectorDbProviders`, `TextToSpeech`, `SpeechToText` and `ImageGenerators`. The `AiProviders` directory has concrete provider folders such as `anthropic`, `azureOpenAi`, `deepseek`, `gemini`, `genericOpenAi`, `localAi`, `ollama`, `openAi` and `modelRouter`. This is a provider-factory/registry organization: caller-facing code can select a name while implementation/provider config remains inside the family.

## What applies to ContentOS

1. Keep LLM, embedding, speech and vector storage as **separate provider ports**; a single giant `AIProvider` interface would couple unrelated capabilities.
2. Use a registry keyed by a stable provider key, plus model configuration records. Business use cases request a capability/role, not a vendor name.
3. Centralize credentials/configuration and validate at provider construction time. Avoid scattered `if provider ==` branches.

## What does not apply to V1

ContentOS Director needs no vector database, agent framework, document ingestion or multi-modal provider catalogue. It needs dependable text and JSON generation, streaming for operator experience, and a future vision port. Do not copy the breadth of a general LLM workspace.

## License

Repository metadata reports MIT at the pinned revision. License compatibility does not eliminate the need for a dependency/security review; this report adopts design only, not source.
