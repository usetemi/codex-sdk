#!/usr/bin/env python3
"""Refresh the committed OpenAI OpenAPI snapshot used by compat tests."""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPENAPI_SNAPSHOT = ROOT / "packages/conformance/fixtures/openai-openapi.yaml"
OPENAPI_URL = (
    "https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml"
)


def main() -> int:
    with urllib.request.urlopen(OPENAPI_URL, timeout=60) as response:
        payload = response.read()

    if not payload.startswith(b"openapi:"):
        print("downloaded OpenAPI snapshot did not look like YAML", file=sys.stderr)
        return 1

    OPENAPI_SNAPSHOT.write_bytes(payload)
    print(f"updated {OPENAPI_SNAPSHOT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
