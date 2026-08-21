# MoneyPrinterTurbo — Phase 1 Report

**Evidence revision:** `8d0e188ea84539d4fcf7dcff5c16b4ab3f2c4c6d` (`main`). The repository’s large shallow clone could not finish within the environment’s 30-second execution limit; the SHA, tree and source files were verified with GitHub’s API/raw endpoints. Exact source paths below refer to that revision.

## 1. Project

A Python application that generates short videos from prompts, local assets, subtitles and TTS, offering FastAPI endpoints, Streamlit UI and CLI paths.

## 2. Technology stack

Python 3.11+, FastAPI/Uvicorn, Streamlit, MoviePy/FFmpeg, OpenAI-compatible and other LLM SDKs, TTS/Whisper, optional Redis, Loguru, and uv dependency locking (`pyproject.toml`).

## 3. Top-level structure

`app/controllers` provides API routes and task managers; `app/services` contains pipeline capabilities; `app/models` holds schemas/constants/providers; `webui` is Streamlit; `cli.py` is the command-line entry. It is a service-oriented directory layout inside one Python deployment.

## 4. Core modules

```text
FastAPI / Streamlit / CLI
  -> app/controllers/v1/video.py
  -> app/controllers/manager/{memory_manager,redis_manager}.py
  -> app/services/task.py
  -> llm / voice / material / subtitle / video / task_artifacts
  -> task directory and result state
```

## 5. Data flow

`controllers/v1/video.py` selects an in-memory or Redis task manager from configuration and accepts a video request. `services/task.py` orchestrates script, material, TTS, subtitle and `services/video.py` composition. Task state/artifacts are exposed back through API endpoints. `video.py` uses MoviePy plus FFmpeg codecs, target-audio-duration logic and material-clip selection.

## 6. Communication

HTTP route -> manager -> thread/future task execution -> filesystem/optional Redis -> HTTP polling. Cross-posting uses a bounded `ThreadPoolExecutor` in `services/task.py`; it is not an externally durable worker.

## 7. Boundaries

Controllers own transport and task-manager selection; services own rendering capabilities. The `llm_provider` model/config (`app/models/llm_provider.py`, `services/llm.py`) prevents script generation from hard-wiring one vendor. The orchestrating `task.py` is nevertheless broad and couples many pipeline stages.

## 8. Extensibility

LLM and music provider maps/configuration allow provider substitution; `services/video_effects.py` is an effect seam. Adding a pipeline stage still changes the central task orchestrator and schema, so it is not a generic workflow-node system.

## 9. Error handling

Task manager limits concurrency/queue depth; cross-post work has bounded slots, a future registry, state-write retries and interruption recovery; video rendering probes hardware codecs and has fallback constants. Task state is observable but Redis durability is optional, making default local operation weaker for ContentOS.

## 10. Data model

`app/models/schema.py` and `const.py` define video parameters/state. A task has id/state/artifacts and may have cross-post state; video parameters include material, transition, codec, voice and subtitle choices. This should inform, but not replace, ContentOS’s explicit Project/Job/Asset/EditManifest model.

## 11. Three designs worth learning

1. Separate HTTP controllers, task managers and stage services; ContentOS can keep API code out of its Video Engine.
2. Store work artifacts under a task-scoped directory and guard task-file access (`file_security.py`); ContentOS should add durable Asset records and retention policy.
3. Use a provider-neutral LLM selection/configuration path so models can be changed without rewriting Director behavior.

## 12. Three designs not to copy

1. `services/task.py` has grown into a central orchestrator for render and publishing concerns; ContentOS must keep Publisher outside Video jobs.
2. In-process futures/thread pools are unsuitable as the only durable job primitive for long-running workers.
3. MoviePy is convenient, but ContentOS V1 should generate/test a direct FFmpeg pipeline for scale and predictable hardware acceleration.

## 13. Reuse grade

**B — extract/adapt selectively.** MIT permits reuse, but only after isolated review of small, dependency-light pieces; do not adopt its application-level task orchestration wholesale.

## 14. License

`LICENSE` and `pyproject.toml` state **MIT**. Direct reuse remains subject to dependency licenses, attribution and security review.
