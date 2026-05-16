#!/usr/bin/env python3
"""Deterministic stdio JSON-RPC app-server used by SDK conformance tests."""

from __future__ import annotations

import json
import sys
from typing import Any


def main() -> int:
    for line in sys.stdin:
        raw = line.rstrip("\n")
        if not raw:
            continue

        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            emit_notification("fake/malformedInput", {"raw": raw})
            continue

        if not isinstance(message, dict):
            emit_notification("fake/malformedInput", {"raw": raw})
            continue

        handle_message(message)
        sys.stdout.flush()

    return 0


def handle_message(message: dict[str, Any]) -> None:
    request_id = message.get("id")
    method = message.get("method")
    params = message.get("params")

    if method == "sdk/echo":
        emit_result(request_id, params)
    elif method == "sdk/error":
        emit_error(request_id, -32000, "fake failure", params)
    elif method == "sdk/notify-server":
        emit_notification("fake/notification", params)
        emit_result(request_id, {"notified": True})
    elif method == "sdk/request-client":
        emit_message(
            {
                "id": "server-1",
                "method": "fake/serverRequest",
                "params": params,
            }
        )
        emit_result(request_id, {"requested": True})
    elif method == "sdk/malformed":
        sys.stdout.write("not-json\n")
        emit_result(request_id, {"malformed": True})
    elif method == "sdk/exit":
        sys.exit(7)
    elif method == "sdk/client-notification":
        emit_notification("fake/clientNotificationReceived", params)
    elif request_id == "server-1" and "result" in message:
        emit_notification(
            "fake/serverRequestResolved",
            {"id": request_id, "result": message["result"]},
        )
    elif request_id == "server-1" and "error" in message:
        emit_notification(
            "fake/serverRequestResolved",
            {"id": request_id, "error": message["error"]},
        )
    elif request_id is not None:
        emit_error(request_id, -32601, "method not found", {"method": method})


def emit_result(request_id: Any, result: Any) -> None:
    if request_id is not None:
        emit_message({"id": request_id, "result": result})


def emit_error(request_id: Any, code: int, message: str, data: Any = None) -> None:
    if request_id is None:
        return

    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    emit_message({"id": request_id, "error": error})


def emit_notification(method: str, params: Any) -> None:
    emit_message({"method": method, "params": params})


def emit_message(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    sys.exit(main())
