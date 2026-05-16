#!/usr/bin/env python3
"""Validate the OpenAI-compatible facade's supported subset against OpenAPI."""

from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path
from typing import Any

import yaml  # ty: ignore[unresolved-import]

ROOT = Path(__file__).resolve().parents[1]
OPENAPI_SNAPSHOT = ROOT / "packages/conformance/fixtures/openai-openapi.yaml"


REQUEST_EXAMPLES: dict[tuple[str, str], Any] = {
    ("/chat/completions", "post"): {
        "model": "codex-mini",
        "messages": [{"role": "user", "content": "Say hello."}],
    },
    ("/responses", "post"): {
        "model": "codex-mini",
        "input": "Say hello.",
    },
}

RESPONSE_EXAMPLES: dict[tuple[str, str], Any] = {
    ("/models", "get"): {
        "object": "list",
        "data": [
            {
                "id": "codex-mini",
                "object": "model",
                "created": 0,
                "owned_by": "codex",
            }
        ],
    },
    ("/chat/completions", "post"): {
        "id": "chatcmpl_test",
        "object": "chat.completion",
        "created": 0,
        "model": "codex-mini",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "compat response",
                    "refusal": None,
                    "annotations": [],
                },
                "logprobs": None,
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 5,
            "completion_tokens": 3,
            "total_tokens": 8,
            "prompt_tokens_details": {
                "cached_tokens": 2,
            },
            "completion_tokens_details": {
                "reasoning_tokens": 1,
            },
        },
    },
    ("/responses", "post"): {
        "id": "resp_test",
        "object": "response",
        "created_at": 0,
        "completed_at": 0,
        "status": "completed",
        "model": "codex-mini",
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": "compat response",
                        "annotations": [],
                        "logprobs": [],
                    }
                ],
            }
        ],
        "output_text": "compat response",
        "usage": {
            "input_tokens": 5,
            "output_tokens": 3,
            "total_tokens": 8,
            "input_tokens_details": {
                "cached_tokens": 2,
            },
            "output_tokens_details": {
                "reasoning_tokens": 1,
            },
        },
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "tools": [],
        "parallel_tool_calls": False,
        "metadata": None,
        "tool_choice": "auto",
        "temperature": None,
        "top_p": None,
    },
}


def main() -> int:
    warnings.filterwarnings(
        "ignore",
        message="jsonschema.RefResolver is deprecated.*",
        category=DeprecationWarning,
    )
    from jsonschema import RefResolver  # ty: ignore[unresolved-import]

    spec = load_spec()
    resolver = RefResolver.from_schema(spec)
    errors: list[str] = []

    for (path, method), example in REQUEST_EXAMPLES.items():
        schema = request_schema(spec, path, method)
        errors.extend(
            validate_example(
                schema, example, resolver, f"{method.upper()} {path} request"
            )
        )

    for (path, method), example in RESPONSE_EXAMPLES.items():
        schema = response_schema(spec, path, method)
        errors.extend(
            validate_example(
                schema, example, resolver, f"{method.upper()} {path} response"
            )
        )

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print("OpenAI OpenAPI supported subset verified")
    return 0


def load_spec() -> dict[str, Any]:
    with OPENAPI_SNAPSHOT.open("r", encoding="utf8") as handle:
        payload = yaml.safe_load(handle)
    if not isinstance(payload, dict):
        raise TypeError(f"{OPENAPI_SNAPSHOT} did not contain an OpenAPI object")
    return payload


def request_schema(spec: dict[str, Any], path: str, method: str) -> dict[str, Any]:
    operation = operation_spec(spec, path, method)
    content = operation["requestBody"]["content"]
    return content["application/json"]["schema"]


def response_schema(spec: dict[str, Any], path: str, method: str) -> dict[str, Any]:
    operation = operation_spec(spec, path, method)
    content = operation["responses"]["200"]["content"]
    return content["application/json"]["schema"]


def operation_spec(spec: dict[str, Any], path: str, method: str) -> dict[str, Any]:
    try:
        operation = spec["paths"][path][method]
    except KeyError as exc:
        raise KeyError(f"OpenAPI snapshot missing {method.upper()} {path}") from exc
    if not isinstance(operation, dict):
        raise TypeError(
            f"OpenAPI operation for {method.upper()} {path} is not an object"
        )
    return operation


def validate_example(
    schema: dict[str, Any],
    example: Any,
    resolver: Any,
    label: str,
) -> list[str]:
    from jsonschema import Draft202012Validator  # ty: ignore[unresolved-import]

    validator = Draft202012Validator(schema, resolver=resolver)
    failures: list[str] = []
    for error in sorted(
        validator.iter_errors(example), key=lambda item: list(item.path)
    ):
        failures.append(format_validation_error(label, error, example))
    return failures


def format_validation_error(label: str, error: Any, example: Any) -> str:
    instance_path = ".".join(str(part) for part in error.path) or "<root>"
    schema_path = ".".join(str(part) for part in error.schema_path) or "<root>"
    instance = json.dumps(error.instance, sort_keys=True)
    return (
        f"{label} failed OpenAPI validation at {instance_path}: {error.message} "
        f"(schema {schema_path}, instance {instance}, example keys {example_keys(example)})"
    )


def example_keys(example: Any) -> str:
    if isinstance(example, dict):
        return ",".join(sorted(example.keys()))
    return type(example).__name__


if __name__ == "__main__":
    sys.exit(main())
