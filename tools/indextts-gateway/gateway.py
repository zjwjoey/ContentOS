"""Local, single-host gateway for the official IndexTTS 2.5 runtime.

The gateway deliberately uses only the Python standard library for HTTP. Model
weights, the Python environment, and generated media stay outside ContentOS.
Bind it to loopback and configure allowlisted reference-audio roots before use.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


LOG = logging.getLogger("contentos.indextts.gateway")
LANGUAGES = {"zh": "ZH", "en": "EN", "ja": "JA", "es": "ES", "ar": "AR"}


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def path_list(value: str) -> tuple[Path, ...]:
    return tuple(Path(item).expanduser().resolve() for item in value.split(";") if item.strip())


class GatewayError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class Runtime:
    def __init__(self) -> None:
        repo = Path(os.environ["INDEXTTS_REPO"]).expanduser().resolve()
        checkpoints = Path(os.environ["INDEXTTS_CHECKPOINTS"]).expanduser().resolve()
        output_root = Path(os.environ.get("INDEXTTS_OUTPUT_ROOT", "F:/ContentOS-AI/temp")).expanduser().resolve()
        allowed = path_list(os.environ.get("INDEXTTS_ALLOWED_INPUT_ROOTS", str(repo)))
        if not repo.is_dir() or not checkpoints.is_dir():
            raise RuntimeError("IndexTTS runtime paths are not configured")
        output_root.mkdir(parents=True, exist_ok=True)

        self.provider = "indextts25"
        self.model_version = os.environ.get("INDEXTTS_MODEL_VERSION", "2.5")
        self.repo = repo
        self.checkpoints = checkpoints
        self.output_root = output_root
        self.allowed_roots = allowed
        self.language_map = LANGUAGES
        self.use_qwen_emo = env_bool("INDEXTTS_LOAD_QWEN_EMO", False)
        self.lock = threading.Lock()

        import sys

        sys.path.insert(0, str(repo))
        import torch
        from indextts.infer_v2_5 import IndexTTS2

        self.torch = torch
        self.device = os.environ.get("INDEXTTS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
        self.tts = IndexTTS2(
            cfg_path=str(checkpoints / "config.yaml"),
            model_dir=str(checkpoints),
            use_bf16=env_bool("INDEXTTS_USE_BF16", True),
            device=self.device,
            use_cuda_kernel=env_bool("INDEXTTS_USE_CUDA_KERNEL", False),
            use_qwen_emo=self.use_qwen_emo,
        )

    def _allowed_input(self, raw_path: str) -> Path:
        candidate = Path(raw_path).expanduser().resolve()
        if not candidate.is_file() or not any(candidate.is_relative_to(root) for root in self.allowed_roots):
            raise GatewayError(HTTPStatus.UNPROCESSABLE_ENTITY, "REFERENCE_AUDIO_NOT_ALLOWED", "Reference audio is not allowlisted")
        return candidate

    def _language(self, raw: Any) -> str:
        value = str(raw or "zh").lower()
        if value not in self.language_map:
            raise GatewayError(HTTPStatus.UNPROCESSABLE_ENTITY, "UNSUPPORTED_LANGUAGE", "Language is not supported")
        return self.language_map[value]

    def generate(self, body: dict[str, Any]) -> dict[str, Any]:
        request_id = str(body.get("requestId") or "")
        text = str(body.get("text") or "").strip()
        if not request_id or len(request_id) > 128:
            raise GatewayError(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST_ID", "requestId is required")
        if not text or len(text) > 5000:
            raise GatewayError(HTTPStatus.BAD_REQUEST, "INVALID_TEXT", "text is required and must be <= 5000 characters")
        reference = self._allowed_input(str(body.get("referenceAudioPath") or ""))
        language = self._language(body.get("language"))
        try:
            speed = float(body.get("speed", 1.0))
        except (TypeError, ValueError) as exc:
            raise GatewayError(HTTPStatus.BAD_REQUEST, "INVALID_SPEED", "speed must be numeric") from exc
        if speed <= 0 or speed > 4:
            raise GatewayError(HTTPStatus.UNPROCESSABLE_ENTITY, "INVALID_SPEED", "speed must be between 0.01 and 4")
        emotion = str(body.get("emotion") or "natural").strip().lower()
        if emotion not in {"", "natural", "neutral"} and not self.use_qwen_emo:
            raise GatewayError(HTTPStatus.UNPROCESSABLE_ENTITY, "EMOTION_UNAVAILABLE", "This runtime was started without emotion guidance")

        # IndexTTS duration_factor is inverse to user-facing playback speed.
        duration_factor = max(0.5, min(2.0, 1.0 / speed))
        output = self.output_root / f"indextts-{uuid.uuid4().hex}.wav"
        started = time.perf_counter()
        with self.lock:
            kwargs: dict[str, Any] = {"duration_factor": duration_factor, "verbose": False}
            if self.use_qwen_emo and emotion not in {"", "natural", "neutral"}:
                kwargs.update(use_emo_text=True, emo_text=emotion)
            self.tts.infer(
                spk_audio_prompt=str(reference),
                text=text,
                lang=language,
                output_path=str(output),
                **kwargs,
            )
        latency_ms = round((time.perf_counter() - started) * 1000, 1)

        import soundfile as sf

        info = sf.info(str(output))
        LOG.info("speech generated request=%s latency_ms=%s duration_ms=%s", request_id, latency_ms, round(info.duration * 1000, 1))
        return {
            "status": "success",
            "provider": self.provider,
            "model": "indextts-2.5",
            "modelVersion": self.model_version,
            "outputPath": str(output),
            "durationMs": round(info.duration * 1000, 1),
            "latencyMs": latency_ms,
        }

    def health(self) -> dict[str, Any]:
        return {"status": "ok", "provider": self.provider, "modelVersion": self.model_version, "modelLoaded": True, "device": self.device}

    def capabilities(self) -> dict[str, Any]:
        return {
            "providerId": self.provider,
            "local": True,
            "voiceClone": True,
            "emotion": self.use_qwen_emo,
            "speed": True,
            "languages": sorted(self.language_map),
            "supportsReferenceAudio": True,
            "requiresReferenceAudio": True,
            "supportsVoiceId": False,
            "maxTextCharacters": 5000,
        }


class Handler(BaseHTTPRequestHandler):
    runtime: Runtime

    def log_message(self, format: str, *args: Any) -> None:
        LOG.info("http %s", format % args)

    def _send(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send(HTTPStatus.OK, self.runtime.health())
        elif self.path == "/capabilities":
            self._send(HTTPStatus.OK, {"capabilities": self.runtime.capabilities()})
        else:
            self._send(HTTPStatus.NOT_FOUND, {"status": "error", "code": "NOT_FOUND", "message": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/v1/speech/generate":
            self._send(HTTPStatus.NOT_FOUND, {"status": "error", "code": "NOT_FOUND", "message": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            if length <= 0 or length > 1_000_000:
                raise GatewayError(HTTPStatus.BAD_REQUEST, "INVALID_BODY", "Request body is invalid")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise GatewayError(HTTPStatus.BAD_REQUEST, "INVALID_BODY", "Request body must be an object")
            self._send(HTTPStatus.OK, self.runtime.generate(body))
        except GatewayError as exc:
            self._send(exc.status, {"status": "error", "code": exc.code, "message": exc.message})
        except Exception:
            LOG.exception("speech generation failed")
            self._send(HTTPStatus.INTERNAL_SERVER_ERROR, {"status": "error", "code": "GENERATION_FAILED", "message": "Speech generation failed"})


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    runtime = Runtime()
    Handler.runtime = runtime
    host = os.environ.get("INDEXTTS_HOST", "127.0.0.1")
    port = int(os.environ.get("INDEXTTS_PORT", "8788"))
    LOG.info("IndexTTS gateway ready host=%s port=%s provider=%s model=%s", host, port, runtime.provider, runtime.model_version)
    with ThreadingHTTPServer((host, port), Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
