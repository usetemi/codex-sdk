from __future__ import annotations

import json
import subprocess
import threading
from dataclasses import dataclass
from queue import Empty, Queue
from types import TracebackType
from typing import Any

JsonRpcMessage = dict[str, Any]
RoutedMessage = dict[str, Any]


@dataclass(frozen=True, slots=True)
class MalformedJsonLine:
    raw: str
    error: Exception


@dataclass(frozen=True, slots=True)
class DecodedJsonLines:
    messages: list[JsonRpcMessage]
    malformed: list[MalformedJsonLine]


def encode_json_rpc_message(message: JsonRpcMessage) -> str:
    return json.dumps(message, separators=(",", ":")) + "\n"


class JsonLineDecoder:
    def __init__(self) -> None:
        self.pending = ""

    def feed(self, chunk: str | bytes) -> DecodedJsonLines:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        combined = self.pending + text
        parts = combined.split("\n")
        self.pending = parts.pop() or ""

        messages: list[JsonRpcMessage] = []
        malformed: list[MalformedJsonLine] = []

        for part in parts:
            raw = part.removesuffix("\r")
            if raw == "":
                continue

            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as error:
                malformed.append(MalformedJsonLine(raw=raw, error=error))
                continue

            if isinstance(parsed, dict):
                messages.append(parsed)
            else:
                malformed.append(
                    MalformedJsonLine(
                        raw=raw,
                        error=ValueError("JSON-RPC line must decode to an object"),
                    )
                )

        return DecodedJsonLines(messages=messages, malformed=malformed)


class MessageRouter:
    def __init__(self) -> None:
        self._expected_response_ids: set[str | int] = set()
        self.notifications: list[JsonRpcMessage] = []

    def expect_response(self, request_id: str | int) -> None:
        self._expected_response_ids.add(request_id)

    def route(self, message: JsonRpcMessage) -> RoutedMessage:
        request_id = message.get("id")

        if isinstance(request_id, (str, int)):
            if isinstance(message.get("method"), str):
                return {"type": "serverRequest", "id": request_id, "message": message}

            if request_id in self._expected_response_ids:
                self._expected_response_ids.remove(request_id)
                if isinstance(message.get("error"), dict):
                    return {"type": "errorResponse", "id": request_id, "message": message}

                return {"type": "response", "id": request_id, "message": message}

            return {"type": "orphanResponse", "id": request_id, "message": message}

        if isinstance(message.get("method"), str):
            self.notifications.append(message)
            return {"type": "notification", "message": message}

        return {"type": "unknown", "message": message}


class JsonRpcResponseError(Exception):
    def __init__(self, error: JsonRpcMessage) -> None:
        self.code = error.get("code", -32000)
        self.data = error.get("data")
        message = error.get("message")
        super().__init__(message if isinstance(message, str) else "JSON-RPC error")


class AppServerClosedError(Exception):
    def __init__(self, code: int | None) -> None:
        self.code = code
        super().__init__(f"app-server closed with code {code}")


class AppServerClient:
    def __init__(self, process: subprocess.Popen[str]) -> None:
        self._process = process
        self._decoder = JsonLineDecoder()
        self._router = MessageRouter()
        self._events: Queue[RoutedMessage] = Queue()
        self._pending: dict[str | int, Queue[tuple[str, Any]]] = {}
        self._request_counter = 0
        self._closed = False
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()

    @classmethod
    def start(
        cls,
        command: list[str] | None = None,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
    ) -> AppServerClient:
        argv = command or ["codex", "app-server", "--listen", "stdio://"]
        process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        return cls(process)

    def __enter__(self) -> AppServerClient:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def request(self, method: str, params: Any = None, *, timeout: float = 5.0) -> Any:
        request_id = self._next_request_id()
        responses: Queue[tuple[str, Any]] = Queue(maxsize=1)

        with self._lock:
            self._pending[request_id] = responses
            self._router.expect_response(request_id)

        self._write(
            {"id": request_id, "method": method, **({} if params is None else {"params": params})}
        )

        try:
            kind, value = responses.get(timeout=timeout)
        except Empty as error:
            with self._lock:
                self._pending.pop(request_id, None)
            raise TimeoutError(f"timed out waiting for response {request_id}") from error

        if kind == "error":
            raise value
        return value

    def notify(self, method: str, params: Any = None) -> None:
        self._write({"method": method, **({} if params is None else {"params": params})})

    def respond(self, request_id: str | int, result: Any) -> None:
        self._write({"id": request_id, "result": result})

    def respond_error(self, request_id: str | int, error: JsonRpcMessage) -> None:
        self._write({"id": request_id, "error": error})

    def next_event(self, *, timeout: float = 5.0) -> RoutedMessage:
        try:
            return self._events.get(timeout=timeout)
        except Empty as error:
            raise TimeoutError("timed out waiting for app-server event") from error

    def close(self) -> None:
        if self._closed:
            return

        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=2)

        self._reader.join(timeout=2)

    def _next_request_id(self) -> str:
        with self._lock:
            self._request_counter += 1
            return f"req-{self._request_counter}"

    def _write(self, message: JsonRpcMessage) -> None:
        with self._lock:
            if self._closed:
                raise AppServerClosedError(self._process.returncode)

            stdin = self._process.stdin
            if stdin is None:
                raise AppServerClosedError(self._process.returncode)

            stdin.write(encode_json_rpc_message(message))
            stdin.flush()

    def _read_stdout(self) -> None:
        stdout = self._process.stdout
        if stdout is not None:
            for chunk in stdout:
                decoded = self._decoder.feed(chunk)
                for malformed in decoded.malformed:
                    self._events.put({"type": "malformed", "raw": malformed.raw})
                for message in decoded.messages:
                    self._handle_message(message)

        code = self._process.wait()
        self._handle_exit(code)

    def _handle_message(self, message: JsonRpcMessage) -> None:
        routed = self._router.route(message)
        route_type = routed["type"]

        if route_type == "response":
            self._resolve_pending(routed["id"], ("result", message.get("result")))
        elif route_type == "errorResponse":
            error = message.get("error")
            self._resolve_pending(
                routed["id"],
                (
                    "error",
                    JsonRpcResponseError(error if isinstance(error, dict) else {}),
                ),
            )
        elif route_type in {"serverRequest", "notification", "unknown"}:
            self._events.put(routed)
        elif route_type == "orphanResponse":
            self._events.put({"type": "unknown", "message": message})

    def _resolve_pending(self, request_id: Any, result: tuple[str, Any]) -> None:
        with self._lock:
            responses = self._pending.pop(request_id, None)

        if responses is not None:
            responses.put(result)

    def _handle_exit(self, code: int | None) -> None:
        with self._lock:
            if self._closed:
                return

            self._closed = True
            pending = list(self._pending.values())
            self._pending.clear()

        error = AppServerClosedError(code)
        for responses in pending:
            responses.put(("error", error))

        self._events.put({"type": "exit", "code": code})
        self._close_streams()

    def _close_streams(self) -> None:
        for stream in (self._process.stdin, self._process.stdout, self._process.stderr):
            if stream is not None and not stream.closed:
                stream.close()
