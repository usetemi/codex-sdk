from __future__ import annotations

from importlib import import_module
from typing import Any


def _load_upstream(name: str) -> type[Any]:
    try:
        openai_codex = import_module("openai_codex")
    except ImportError as error:
        raise ImportError(
            "The upstream `openai-codex` package is not installed. Install it when "
            "OpenAI publishes the Python SDK package, or use the low-level transport "
            "helpers that ship with `usetemi-codex-sdk`."
        ) from error

    return getattr(openai_codex, name)


class Codex:
    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        upstream = _load_upstream("Codex")
        return upstream(*args, **kwargs)


class AsyncCodex:
    def __new__(cls, *args: Any, **kwargs: Any) -> Any:
        upstream = _load_upstream("AsyncCodex")
        return upstream(*args, **kwargs)
