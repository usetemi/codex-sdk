#!/usr/bin/env python3
"""Decide whether a new upstream Codex npm version needs an update PR."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from scripts.release_versions import read_versions
except ModuleNotFoundError:
    from release_versions import read_versions

CODEX_NPM_PACKAGE = "@openai/codex"
CODEX_SDK_NPM_PACKAGE = "@openai/codex-sdk"
AUTOMATION_BRANCH_PREFIX = "automation/codex-v"
STABLE_VERSION = re.compile(r"^\d+\.\d+\.\d+$")
STABLE_VERSION_IN_SPECIFIER = re.compile(r"\d+\.\d+\.\d+")


@dataclass(frozen=True)
class ReleaseDecision:
    should_update: bool
    version: str
    codex_sdk_version: str
    current_package_version: str
    current_codex_version: str
    branch: str
    reason: str

    def github_outputs(self) -> dict[str, str]:
        return {
            "should_update": str(self.should_update).lower(),
            "version": self.version,
            "codex_version": self.version,
            "codex_sdk_version": self.codex_sdk_version,
            "current_package_version": self.current_package_version,
            "current_codex_version": self.current_codex_version,
            "branch": self.branch,
            "skip_reason": "" if self.should_update else self.reason,
            "pr_title": f"Update Codex SDK target to {self.version}",
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="Repository root")
    parser.add_argument(
        "--version-override",
        help="Use this stable version instead of polling the latest @openai/codex version",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the decision without implying later workflow mutation",
    )
    parser.add_argument(
        "--github-output",
        help="Append GitHub Actions outputs to this file. Defaults to $GITHUB_OUTPUT when set.",
    )
    args = parser.parse_args()

    root = Path(args.root)
    decision = build_decision(root, version_override=args.version_override)

    mode = "dry run" if args.dry_run else "decision"
    print(f"Upstream Codex release {mode}:")
    print(json.dumps(decision.github_outputs(), indent=2))
    if decision.should_update:
        print(f"Will update to Codex {decision.version} on {decision.branch}.")
    else:
        print(f"Skipping update: {decision.reason}.")

    github_output = args.github_output or os.environ.get("GITHUB_OUTPUT")
    if github_output:
        write_github_outputs(Path(github_output), decision.github_outputs())

    return 0


def build_decision(
    root: Path, *, version_override: str | None = None
) -> ReleaseDecision:
    version = (
        normalize_version(version_override)
        if version_override
        else latest_stable_npm_version(CODEX_NPM_PACKAGE)
    )
    codex_sdk_version = npm_package_version(CODEX_SDK_NPM_PACKAGE, version) or ""
    current_package_version = read_versions(root)["typescript"]
    current_codex_version = read_current_codex_dependency(root)
    branch = f"{AUTOMATION_BRANCH_PREFIX}{version}"

    return decide_release(
        version=version,
        codex_sdk_version=codex_sdk_version,
        current_package_version=current_package_version,
        current_codex_version=current_codex_version,
        branch=branch,
        branch_exists=remote_branch_exists(branch),
        pr_exists=open_pr_exists(branch),
    )


def decide_release(
    *,
    version: str,
    codex_sdk_version: str,
    current_package_version: str,
    current_codex_version: str,
    branch: str,
    branch_exists: bool,
    pr_exists: bool,
) -> ReleaseDecision:
    if not codex_sdk_version:
        return ReleaseDecision(
            should_update=False,
            version=version,
            codex_sdk_version="",
            current_package_version=current_package_version,
            current_codex_version=current_codex_version,
            branch=branch,
            reason=f"{CODEX_SDK_NPM_PACKAGE}@{version} is not published",
        )

    if stable_version_at_least(current_codex_version, version):
        return ReleaseDecision(
            should_update=False,
            version=version,
            codex_sdk_version=codex_sdk_version,
            current_package_version=current_package_version,
            current_codex_version=current_codex_version,
            branch=branch,
            reason=f"repository already targets Codex {current_codex_version}",
        )

    reason = f"new stable Codex version {version} is available"
    if branch_exists:
        reason = f"branch {branch} already exists; update and revalidate it"
    elif pr_exists:
        reason = f"open PR already exists for {branch}; update and revalidate it"

    return ReleaseDecision(
        should_update=True,
        version=version,
        codex_sdk_version=codex_sdk_version,
        current_package_version=current_package_version,
        current_codex_version=current_codex_version,
        branch=branch,
        reason=reason,
    )


def latest_stable_npm_version(package: str) -> str:
    versions = npm_package_versions(package)
    stable_versions = [
        normalize_version(version)
        for version in versions
        if STABLE_VERSION.fullmatch(version)
    ]
    if not stable_versions:
        raise ValueError(f"No stable versions found for {package}")

    return max(stable_versions, key=version_key)


def npm_package_versions(package: str) -> list[str]:
    payload = subprocess.check_output(
        ["npm", "view", package, "versions", "--json"], text=True
    )
    versions = json.loads(payload)
    if isinstance(versions, str):
        return [versions]

    return [str(version) for version in versions]


def npm_package_version(package: str, version: str) -> str | None:
    result = subprocess.run(
        ["npm", "view", f"{package}@{version}", "version", "--json"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None

    payload = json.loads(result.stdout)
    if isinstance(payload, str):
        return payload

    if isinstance(payload, list) and payload:
        return str(payload[0])

    return None


def read_current_codex_dependency(root: Path) -> str:
    package_json = root / "packages" / "typescript" / "package.json"
    package = json.loads(package_json.read_text())
    specifier = package["dependencies"][CODEX_NPM_PACKAGE]
    match = STABLE_VERSION_IN_SPECIFIER.search(specifier)
    return match.group(0) if match else specifier


def remote_branch_exists(branch: str) -> bool:
    result = subprocess.run(
        [
            "git",
            "ls-remote",
            "--exit-code",
            "--heads",
            "origin",
            f"refs/heads/{branch}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.returncode == 0


def open_pr_exists(branch: str) -> bool:
    result = subprocess.run(
        ["gh", "pr", "list", "--state", "open", "--head", branch, "--json", "number"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        return False

    return bool(json.loads(result.stdout))


def write_github_outputs(path: Path, values: dict[str, str]) -> None:
    with path.open("a") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def normalize_version(version: str) -> str:
    normalized = version.removeprefix("v")
    if not STABLE_VERSION.fullmatch(normalized):
        raise ValueError(f"Expected a stable three-part version, got {version!r}")

    return normalized


def stable_version_at_least(current: str, target: str) -> bool:
    return bool(STABLE_VERSION.fullmatch(current)) and version_key(
        current
    ) >= version_key(target)


def version_key(version: str) -> tuple[int, int, int]:
    major, minor, patch = version.split(".")
    return int(major), int(minor), int(patch)


if __name__ == "__main__":
    sys.exit(main())
