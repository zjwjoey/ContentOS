# Open WebUI: Multi-Provider Evidence

## C1 — one UI, many providers

Open WebUI uses API-family adapters rather than embedding provider branches in the UI. `backend/open_webui/routers/openai.py` and `routers/ollama.py` normalize outbound headers, payload parameters, model listing and stream responses while preserving upstream-specific authentication/configuration. Both return `StreamingResponse` through a wrapper when streaming is requested and emit provider-request-failed events on upstream errors.

## C2 — provider/model persistence

`backend/open_webui/models/models.py` defines a persistent `model` record: `id`, `base_model_id`, display `name`, JSON `params`, JSON `meta`, active flag and owner/timestamps. This lets one stored model entry wrap an upstream model with custom settings.

## C3 — capability representation

`ModelMeta` includes a flexible `capabilities` JSON field. That is a useful pattern, but it is too permissive as a ContentOS contract. ContentOS should use a finite enum set (`text`, `structured_output`, `streaming`, `vision`, `tools`) plus provider-specific extension metadata.

## C4 — change surface

A new API family requires a server-side transport/normalization adapter and model discovery/config handling; the UI remains generic because models are stored/served as records. This is the correct direction. ContentOS needs less: Director requires text and structured JSON first, not a general chat gateway.

## Takeaway

Borrow the separation of model registry from request adapters and the careful streaming/error boundary. Do not inherit Open WebUI’s broad chat/tool/function ecosystem or use untyped provider config blobs as the Director domain contract.
