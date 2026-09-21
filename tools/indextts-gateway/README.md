# IndexTTS 2.5 local gateway

This gateway is a small loopback-only HTTP adapter around the official
IndexTTS 2.5 runtime. It intentionally does not contain model weights, a
virtual environment, or generated media.

Required environment variables:

```powershell
$env:INDEXTTS_REPO = 'F:\ContentOS-AI\runtimes\indextts-2.5\repo'
$env:INDEXTTS_CHECKPOINTS = 'F:\ContentOS-AI\runtimes\indextts-2.5\checkpoints'
$env:INDEXTTS_OUTPUT_ROOT = 'F:\ContentOS-AI\temp'
$env:INDEXTTS_ALLOWED_INPUT_ROOTS = 'F:\ContentOS-AI\runtimes\indextts-2.5\repo\tests;F:\ContentOS-AI\temp'
$env:INDEXTTS_PORT = '8788'
& "$env:INDEXTTS_REPO\.venv\Scripts\python.exe" tools\indextts-gateway\gateway.py
```

Endpoints are `GET /health`, `GET /capabilities`, and
`POST /v1/speech/generate`. The gateway only accepts reference audio under
`INDEXTTS_ALLOWED_INPUT_ROOTS` and chooses output filenames itself below
`INDEXTTS_OUTPUT_ROOT`.
