#!/usr/bin/env python3
"""Bump all package manifests to a new stable Codex target version."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

try:
    from scripts.release_versions import read_versions
except ModuleNotFoundError:
    from release_versions import read_versions

STABLE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
ELIXIR_VERSION = re.compile(r'(version:\s*")([^"]+)(")')
GO_VERSION = re.compile(r'(const\s+Version\s*=\s*")([^"]+)(")')
PYPROJECT_VERSION = re.compile(r'(^version\s*=\s*")([^"]+)(")', re.MULTILINE)
UV_LOCK_PROJECT_VERSION = re.compile(
    r'(\[\[package\]\]\nname = "usetemi-codex-sdk"\nversion = ")([^"]+)(")'
)
TARGET_CODEX_SENTENCE = re.compile(r"Version `[^`]+` targets Codex `\d+\.\d+\.\d+`")

README_FILES = [
    Path("README.md"),
    Path("packages/typescript/README.md"),
    Path("packages/python/README.md"),
    Path("packages/elixir/README.md"),
    Path("packages/go/README.md"),
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="Stable Codex version, for example 0.131.0")
    parser.add_argument("--root", default=".", help="Repository root")
    parser.add_argument(
        "--skip-locks",
        action="store_true",
        help="Update manifests and docs without regenerating lock files",
    )
    args = parser.parse_args()

    root = Path(args.root)
    version = args.version.removeprefix("v")
    if not STABLE_VERSION.fullmatch(version):
        print(
            f"Expected a stable three-part version, got {args.version!r}",
            file=sys.stderr,
        )
        return 1

    bump(root, version, update_locks=not args.skip_locks)
    return 0


def bump(root: Path, version: str, *, update_locks: bool = True) -> None:
    current_versions = read_versions(root)
    current_package_version = current_versions["typescript"]

    update_typescript_package(root, version)
    update_python_project(root, version)
    update_elixir_mix(root, version)
    update_go_version(root, version)
    update_readmes(root, current_package_version, version)

    if update_locks:
        regenerate_locks(root)
    else:
        update_uv_lock_project_version(root, version)


def update_typescript_package(root: Path, version: str) -> None:
    package_json = root / "packages" / "typescript" / "package.json"
    package = json.loads(package_json.read_text())
    package["version"] = version
    package["dependencies"]["@openai/codex"] = version
    package["dependencies"]["@openai/codex-sdk"] = f"^{version}"
    package_json.write_text(json.dumps(package, indent=2) + "\n")


def update_python_project(root: Path, version: str) -> None:
    pyproject = root / "packages" / "python" / "pyproject.toml"
    pyproject.write_text(
        replace_once(PYPROJECT_VERSION, pyproject.read_text(), rf"\g<1>{version}\3")
    )


def update_elixir_mix(root: Path, version: str) -> None:
    mix_exs = root / "packages" / "elixir" / "mix.exs"
    mix_exs.write_text(
        replace_once(ELIXIR_VERSION, mix_exs.read_text(), rf"\g<1>{version}\3")
    )


def update_go_version(root: Path, version: str) -> None:
    version_go = root / "packages" / "go" / "version.go"
    version_go.write_text(
        replace_once(GO_VERSION, version_go.read_text(), rf"\g<1>{version}\3")
    )


def update_readmes(root: Path, current_package_version: str, version: str) -> None:
    for readme in README_FILES:
        path = root / readme
        text = path.read_text()
        text = text.replace(current_package_version, version)
        text = TARGET_CODEX_SENTENCE.sub(
            f"Version `{version}` targets Codex `{version}`", text
        )
        path.write_text(text)


def update_uv_lock_project_version(root: Path, version: str) -> None:
    uv_lock = root / "packages" / "python" / "uv.lock"
    if not uv_lock.exists():
        return

    text = uv_lock.read_text()
    uv_lock.write_text(
        replace_once(UV_LOCK_PROJECT_VERSION, text, rf"\g<1>{version}\3")
    )


def regenerate_locks(root: Path) -> None:
    subprocess.run(
        ["npm", "install", "--package-lock-only", "--ignore-scripts"],
        cwd=root,
        check=True,
    )

    if (root / "packages" / "python" / "uv.lock").exists():
        subprocess.run(
            ["uv", "lock", "--project", "packages/python"], cwd=root, check=True
        )


def replace_once(pattern: re.Pattern[str], text: str, replacement: str) -> str:
    updated, count = pattern.subn(replacement, text, count=1)
    if count != 1:
        raise ValueError(f"Expected exactly one match for {pattern.pattern!r}")
    return updated


if __name__ == "__main__":
    sys.exit(main())
