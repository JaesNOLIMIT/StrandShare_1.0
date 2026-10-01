"""Tiny loopback controller for keeping the local AI worker ready.

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
ALWAYS_ON = ENV.get("AI_ALWAYS_ON", "1").strip().lower() not in {"0", "false", "no", "off"}
IDLE_SECONDS = 0 if ALWAYS_ON else max(60, int(ENV.get("AI_IDLE_TIMEOUT_MINUTES", "15")) * 60)
CONTROL_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
REQUESTED_ACTION: str | None = None
REQUESTED_AT = 0.0
CONTROL_ERROR: str | None = None
MANAGER_BUSY = False


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
    global REQUESTED_ACTION, CONTROL_ERROR
    age = _last_activity_age()
    state = _ai_state()
    with STATE_LOCK:
        if REQUESTED_ACTION == "Start" and state == "ready":
            REQUESTED_ACTION = None
            CONTROL_ERROR = None
        elif REQUESTED_ACTION == "Stop" and state == "off":
            REQUESTED_ACTION = None
            CONTROL_ERROR = None
        elif REQUESTED_ACTION and time.monotonic() - REQUESTED_AT > 300:
            CONTROL_ERROR = "The local AI worker did not finish changing state. Check ai-server/.run logs."
            REQUESTED_ACTION = None
        elif REQUESTED_ACTION == "Start" and not MANAGER_BUSY and state == "off":
            CONTROL_ERROR = "The local AI worker did not start. Check ai-server/.run logs."
            REQUESTED_ACTION = None
        if REQUESTED_ACTION == "Start":
            state = "starting"
        elif REQUESTED_ACTION == "Stop":
            state = "stopping"
        error = CONTROL_ERROR
    return {
        "status": "ok",
        "mode": "local-only",
        "controller": "ready",
        "ai_state": state,
        "always_on": ALWAYS_ON,
        "control_error": error,
        "idle_timeout_seconds": IDLE_SECONDS,
        "idle_seconds": age if state == "ready" else None,
        "active_jobs": _active_jobs() if state == "ready" else 0,
    }


def _run_manager(action: str) -> None:
    global REQUESTED_ACTION, CONTROL_ERROR, MANAGER_BUSY
    with CONTROL_LOCK:
        with STATE_LOCK:
            MANAGER_BUSY = True
        try:
            result = subprocess.run(
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
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                timeout=30,
            )
            failed = result.returncode != 0
        except (OSError, subprocess.TimeoutExpired):
            failed = True
        with STATE_LOCK:
            if REQUESTED_ACTION == action:
                MANAGER_BUSY = False
                if failed:
                    REQUESTED_ACTION = None
                    CONTROL_ERROR = "Could not change local AI power. Check ai-server/.run logs and the local setup."


def _start_action(action: str) -> None:
    global REQUESTED_ACTION, REQUESTED_AT, CONTROL_ERROR, MANAGER_BUSY
    with STATE_LOCK:
        REQUESTED_ACTION = action
        REQUESTED_AT = time.monotonic()
        CONTROL_ERROR = None
        MANAGER_BUSY = True
    threading.Thread(target=_run_manager, args=(action,), daemon=True).start()


def _idle_monitor() -> None:
    while True:
        time.sleep(15)
        if ALWAYS_ON:
            continue
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
    server = ThreadingHTTPServer(("127.0.0.1", 8010), ControllerHandler)
    if ALWAYS_ON:
        _start_action("Start")
    else:
        threading.Thread(target=_idle_monitor, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
