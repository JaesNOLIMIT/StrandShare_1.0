"""Tiny loopback controller for turning the local AI worker on and off.

This process starts at Windows sign-in but deliberately imports no ML package.
The Vercel frontend reaches it through the specialist's browser at 127.0.0.1.
"""

from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import urllib.request
import ctypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

AI_ROOT = Path(__file__).resolve().parent.parent
RUN_ROOT = AI_ROOT / ".run"
MANAGER = AI_ROOT / "manage-local-ai.ps1"
AI_PID_FILE = RUN_ROOT / "ai.pid"
LAST_ACTIVITY_FILE = RUN_ROOT / "last-ai-activity"
CONTROL_HEADER = "X-Donivra-Local-Control"
DEFAULT_ORIGINS = {
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://donivra.vercel.app",
}


def _read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    path = AI_ROOT / ".env"
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


ENV = _read_env()
ALLOWED_ORIGINS = DEFAULT_ORIGINS | {
    item.strip()
    for item in ENV.get("ALLOWED_ORIGINS", "").split(",")
    if item.strip()
}
IDLE_SECONDS = max(60, int(ENV.get("AI_IDLE_TIMEOUT_MINUTES", "15")) * 60)
CONTROL_LOCK = threading.Lock()


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _tracked_pid() -> int | None:
    try:
        pid = int(AI_PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    # os.kill(pid, 0) is unreliable on Windows and can raise WinError 87.
    process_query_limited_information = 0x1000
    handle = ctypes.windll.kernel32.OpenProcess(
        process_query_limited_information, False, pid
    )
    if not handle:
        return None
    ctypes.windll.kernel32.CloseHandle(handle)
    return pid


def _ai_state() -> str:
    pid = _tracked_pid()
    if _port_open(8000):
        return "ready"
    return "starting" if pid else "off"


def _last_activity_age() -> int | None:
    try:
        timestamp = float(LAST_ACTIVITY_FILE.read_text(encoding="utf-8").strip())
        return max(0, int(time.time() - timestamp))
    except (OSError, ValueError):
        return None


def _active_jobs() -> int:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=1) as response:
            data = json.loads(response.read().decode("utf-8"))
            return max(0, int(data.get("active_jobs", 0)))
    except Exception:
        return 0


def _status() -> dict[str, Any]:
    age = _last_activity_age()
    state = _ai_state()
    return {
        "status": "ok",
        "mode": "local-only",
        "controller": "ready",
        "ai_state": state,
        "idle_timeout_seconds": IDLE_SECONDS,
        "idle_seconds": age if state == "ready" else None,
        "active_jobs": _active_jobs() if state == "ready" else 0,
    }


def _run_manager(action: str) -> None:
    with CONTROL_LOCK:
        subprocess.run(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(MANAGER),
                action,
            ],
            cwd=str(AI_ROOT.parent),
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=30,
        )


def _start_action(action: str) -> None:
    threading.Thread(target=_run_manager, args=(action,), daemon=True).start()


def _idle_monitor() -> None:
    while True:
        time.sleep(15)
        if _ai_state() != "ready" or _active_jobs() > 0:
            continue
        age = _last_activity_age()
        if age is not None and age >= IDLE_SECONDS:
            _run_manager("Stop")


class ControllerHandler(BaseHTTPRequestHandler):
    server_version = "DonivraLocalController/1.0"

    def _origin_allowed(self) -> bool:
        return self.headers.get("Origin", "") in ALLOWED_ORIGINS

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {CONTROL_HEADER}")
        self.send_header("Access-Control-Max-Age", "600")

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Origin is not allowed."})
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors_headers()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/health", "/status"}:
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found."})
            return
        self._json(HTTPStatus.OK, _status())

    def do_POST(self) -> None:  # noqa: N802
        if not self._origin_allowed() or self.headers.get(CONTROL_HEADER) != "1":
            self._json(HTTPStatus.FORBIDDEN, {"error": "Local AI control request was rejected."})
            return
        if self.path == "/ai/on":
            _start_action("Start")
            self._json(HTTPStatus.ACCEPTED, {**_status(), "ai_state": "starting"})
            return
        if self.path == "/ai/off":
            _start_action("Stop")
            self._json(HTTPStatus.ACCEPTED, {**_status(), "ai_state": "stopping"})
            return
        self._json(HTTPStatus.NOT_FOUND, {"error": "Not found."})

    def log_message(self, format: str, *args: Any) -> None:
        return


def main() -> None:
    RUN_ROOT.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=_idle_monitor, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", 8010), ControllerHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
