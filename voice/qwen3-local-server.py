#!/usr/bin/env python3
"""Qwen3-TTS 本地常驻服务。

接口：
- GET  /health
- POST /prewarm   {"text": "..."}
- POST /synthesize {"text": "...", "outputFile": "/abs/path.wav", "language": "Chinese"}
"""

from __future__ import annotations

import argparse
import json
import os
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


def _dtype_from_str(name: str):
    v = (name or "float32").lower().strip()
    if v in ("float32", "fp32"):
        return torch.float32
    if v in ("float16", "fp16"):
        return torch.float16
    if v in ("bfloat16", "bf16"):
        return torch.bfloat16
    return torch.float32


class Qwen3Service:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.lock = threading.Lock()
        self.model = None
        self.voice_clone_prompt = None
        self.loaded = False
        self.load_err = None

    def load(self):
        # 固定随机种子，尽量降低同文本多次合成时的随机漂移
        random.seed(self.args.seed)
        np.random.seed(self.args.seed)
        torch.manual_seed(self.args.seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(self.args.seed)

        device = self.args.device
        if device == "mps" and not torch.backends.mps.is_available():
            print("[Qwen3Local] MPS 不可用，回退 CPU", flush=True)
            device = "cpu"

        dtype = _dtype_from_str(self.args.dtype)
        print(f"[Qwen3Local] loading model={self.args.model_dir} device={device} dtype={dtype}", flush=True)
        self.model = Qwen3TTSModel.from_pretrained(
            self.args.model_dir,
            device_map=device,
            torch_dtype=dtype,
        )

        # 启动时预先构建一次音色提示，后续合成复用，避免每句重新克隆导致音色跳变
        ref_text = None if self.args.x_vector_only_mode else self.args.ref_text
        self.voice_clone_prompt = self.model.create_voice_clone_prompt(
            ref_audio=self.args.ref_audio,
            ref_text=ref_text,
            x_vector_only_mode=self.args.x_vector_only_mode,
        )

        self.loaded = True
        print("[Qwen3Local] model loaded", flush=True)

    def synthesize(self, text: str, output_file: str, language: str | None = None):
        if not self.loaded or self.model is None:
            raise RuntimeError("model not loaded")
        if not text or not text.strip():
            raise ValueError("text is empty")

        lang = language or self.args.language
        out = os.path.abspath(output_file)
        os.makedirs(os.path.dirname(out), exist_ok=True)

        with self.lock:
            t0 = time.perf_counter()
            wavs, sr = self.model.generate_voice_clone(
                text=text.strip(),
                language=lang,
                voice_clone_prompt=self.voice_clone_prompt,
                x_vector_only_mode=self.args.x_vector_only_mode,
                non_streaming_mode=True,
                max_new_tokens=self.args.max_new_tokens,
            )
            sf.write(out, wavs[0], sr)
            elapsed = time.perf_counter() - t0

        return out, elapsed


class Handler(BaseHTTPRequestHandler):
    service: Qwen3Service = None  # type: ignore

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(data.decode("utf-8"))

    def do_GET(self):
        if self.path == "/":
            self._send_json(200, {
                "ok": True,
                "service": "qwen3-local-tts",
                "ready": bool(self.service and self.service.loaded),
            })
            return
        if self.path == "/health":
            self._send_json(200, {
                "ok": True,
                "ready": bool(self.service and self.service.loaded),
                "error": self.service.load_err if self.service else "no service",
            })
            return
        self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path not in ("/prewarm", "/synthesize"):
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        try:
            payload = self._read_json()
            text = payload.get("text") or "你好，这是预热测试。"

            output_dir_abs = os.path.abspath(self.service.args.output_dir)
            output = payload.get("outputFile")
            if not output:
                stamp = int(time.time() * 1000)
                output = os.path.join(output_dir_abs, f"qwen3_{stamp}.wav")
            else:
                output = os.path.abspath(output)
                if not output.startswith(output_dir_abs + os.sep):
                    self._send_json(400, {"ok": False, "error": "outputFile must be inside output_dir"})
                    return

            language = payload.get("language")
            out, elapsed = self.service.synthesize(text, output, language)
            self._send_json(200, {"ok": True, "outputFile": out, "elapsedSec": round(elapsed, 3)})
        except Exception as e:  # pragma: no cover
            self._send_json(500, {"ok": False, "error": str(e)})

    def log_message(self, fmt, *args):
        # / 与 /health 频繁轮询，默认静默，避免日志噪音
        if self.path in ("/", "/health"):
            return
        print(f"[Qwen3Local] {fmt % args}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Qwen3 本地常驻 TTS 服务")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--ref-audio", required=True)
    parser.add_argument("--ref-text", default="This is a reference text for cloning.")
    parser.add_argument("--language", default="Chinese")
    parser.add_argument("--device", default="mps")
    parser.add_argument("--dtype", default="float32")
    parser.add_argument("--port", type=int, default=18789)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--max-new-tokens", type=int, default=768)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--x-vector-only-mode", action="store_true", default=True)
    parser.add_argument("--output-dir", default=os.path.join(os.getcwd(), "temp"))
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    service = Qwen3Service(args)
    try:
        service.load()
    except Exception as e:  # pragma: no cover
        service.load_err = str(e)
        print(f"[Qwen3Local] load failed: {e}", flush=True)

    Handler.service = service
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[Qwen3Local] serving http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
