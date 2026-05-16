#!/usr/bin/env python3
"""Validate release package artifacts that are easy to publish incorrectly."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_NPM_FILES = {
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/transport.js",
    "dist/transport.d.ts",
}
FORBIDDEN_NPM_PREFIXES = ("src/", "tests/")


def main() -> int:
    errors: list[str] = []
    npm_files = read_npm_pack_files()

    missing = sorted(REQUIRED_NPM_FILES - npm_files)
    if missing:
        errors.append("npm package is missing required files: " + ", ".join(missing))

    forbidden = sorted(
        path for path in npm_files if path.startswith(FORBIDDEN_NPM_PREFIXES)
    )
    if forbidden:
        errors.append("npm package includes non-release files: " + ", ".join(forbidden))

    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1

    print("npm package files verified")
    return 0


def read_npm_pack_files() -> set[str]:
    output = subprocess.check_output(
        [
            "npm",
            "pack",
            "--workspace",
            "@usetemi/codex-sdk",
            "--dry-run",
            "--json",
        ],
        cwd=ROOT,
        text=True,
    )
    payload = json.loads(output)
    if not isinstance(payload, list) or len(payload) != 1:
        raise ValueError(f"unexpected npm pack payload: {payload!r}")

    files = payload[0].get("files")
    if not isinstance(files, list):
        raise ValueError(f"unexpected npm pack files payload: {payload!r}")

    return {entry["path"] for entry in files}


if __name__ == "__main__":
    sys.exit(main())
