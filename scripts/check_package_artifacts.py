#!/usr/bin/env python3
"""Validate release package artifacts that are easy to publish incorrectly."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

REQUIRED_SDK_NPM_FILES = {
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/openai-compat.js",
    "dist/openai-compat.d.ts",
    "dist/transport.js",
    "dist/transport.d.ts",
}
REQUIRED_PROXY_NPM_FILES = {
    "package.json",
    "README.md",
    "Dockerfile",
    "dist/cli.js",
    "dist/index.js",
    "dist/index.d.ts",
}
FORBIDDEN_NPM_PREFIXES = ("src/", "tests/")
NPM_WORKSPACE_BY_PACKAGE = {
    "sdk": "@usetemi/codex-sdk",
    "proxy": "@usetemi/codex-openai-proxy",
}
REQUIRED_NPM_FILES_BY_PACKAGE = {
    "sdk": REQUIRED_SDK_NPM_FILES,
    "proxy": REQUIRED_PROXY_NPM_FILES,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--package", choices=sorted(NPM_WORKSPACE_BY_PACKAGE), default="sdk"
    )
    args = parser.parse_args()

    errors: list[str] = []
    npm_files = read_npm_pack_files(args.package)
    required = REQUIRED_NPM_FILES_BY_PACKAGE[args.package]

    missing = sorted(required - npm_files)
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

    print(f"{args.package} npm package files verified")
    return 0


def read_npm_pack_files(package: str) -> set[str]:
    output = subprocess.check_output(
        [
            "npm",
            "pack",
            "--workspace",
            NPM_WORKSPACE_BY_PACKAGE[package],
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
