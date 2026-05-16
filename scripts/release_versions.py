#!/usr/bin/env python3
"""Validate package versions before publishing a release."""

from __future__ import annotations

import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

ELIXIR_VERSION = re.compile(r'version:\s*"([^"]+)"')
GO_VERSION = re.compile(r'const\s+Version\s*=\s*"([^"]+)"')


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--expect", required=True, help="Release version, with or without leading v"
    )
    parser.add_argument("--root", default=".", help="Repository root")
    args = parser.parse_args()

    versions = read_versions(Path(args.root))

    try:
        validate_expected_version(args.expect, versions)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 1

    for package, version in versions.items():
        print(f"{package}={version}")

    return 0


def read_versions(root: Path) -> dict[str, str]:
    return {
        "typescript": read_typescript_version(root),
        "python": read_python_version(root),
        "elixir": read_elixir_version(root),
        "go": read_go_version(root),
    }


def validate_expected_version(expected: str, versions: dict[str, str]) -> None:
    normalized = expected.removeprefix("v")
    mismatches = [
        f"{package}={version}"
        for package, version in versions.items()
        if version != normalized
    ]

    if mismatches:
        joined = ", ".join(mismatches)
        raise ValueError(
            f"Release version {normalized} does not match package versions: {joined}"
        )


def read_typescript_version(root: Path) -> str:
    package_json = root / "packages" / "typescript" / "package.json"
    return json.loads(package_json.read_text())["version"]


def read_python_version(root: Path) -> str:
    pyproject = root / "packages" / "python" / "pyproject.toml"
    return tomllib.loads(pyproject.read_text())["project"]["version"]


def read_elixir_version(root: Path) -> str:
    mix_exs = root / "packages" / "elixir" / "mix.exs"
    match = ELIXIR_VERSION.search(mix_exs.read_text())
    if match is None:
        raise ValueError(f"Could not find Elixir version in {mix_exs}")

    return match.group(1)


def read_go_version(root: Path) -> str:
    version_go = root / "packages" / "go" / "version.go"
    match = GO_VERSION.search(version_go.read_text())
    if match is None:
        raise ValueError(f"Could not find Go version in {version_go}")

    return match.group(1)


if __name__ == "__main__":
    sys.exit(main())
