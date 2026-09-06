#!/usr/bin/env python3
"""Serve the prototype UI and MTP fixtures with only the stdlib."""

from __future__ import annotations

import argparse
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
TRACE_DIR = ROOT / "trace"


def read_trace(run_id: str) -> dict:
    path = TRACE_DIR / f"sample-{run_id}.json"
    if run_id not in {"normal", "failure"} or not path.exists():
        raise FileNotFoundError(run_id)
    return json.loads(path.read_text(encoding="utf-8"))


class MicroscopeHandler(SimpleHTTPRequestHandler):
    """Static file handler plus three tiny JSON endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self) -> None:  # noqa: N802 (stdlib API)
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self.path = "/app/index.html"
        elif parsed.path in {"/styles.css", "/app.js"}:
            # The same index is served from / for this prototype and from the
            # app/ directory when bundled by Tauri.
            self.path = "/app" + parsed.path
        elif parsed.path == "/api/runs":
            self._json([
                read_trace("normal")["run"],
                read_trace("failure")["run"],
            ])
            return
        elif parsed.path.startswith("/api/trace/"):
            run_id = parsed.path.rsplit("/", 1)[-1]
            try:
                self._json(read_trace(run_id))
            except FileNotFoundError:
                self.send_error(404, "unknown run")
            return
        elif parsed.path.startswith("/api/summary/"):
            # Keep this endpoint intentionally small; the browser can use it for a future live card.
            from analysis.trace_engine import summarize

            run_id = parsed.path.rsplit("/", 1)[-1]
            try:
                self._json(summarize(read_trace(run_id)))
            except FileNotFoundError:
                self.send_error(404, "unknown run")
            return
        super().do_GET()

    def _json(self, value: object) -> None:
        payload = json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        sys.stderr.write(f"[microscope] {self.address_string()} - {format % args}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve Program Microscope v0.1")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    # The import above is intentionally local so serving static UI never requires package installation.
    sys.path.insert(0, str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), MicroscopeHandler)
    print(f"Program Microscope: http://{args.host}:{args.port}")
    print("Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
