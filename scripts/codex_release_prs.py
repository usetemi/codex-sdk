#!/usr/bin/env python3
"""Manage automated Codex release pull requests."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from typing import Any

AUTOMATED_CODEX_RELEASE_LABEL = "automated-codex-release"
CODEX_RELEASE_TITLE = re.compile(r"^Update Codex SDK target to (\d+\.\d+\.\d+)$")


@dataclass(frozen=True)
class CodexReleasePr:
    number: int
    title: str
    url: str
    version: str | None


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    close_superseded = subparsers.add_parser(
        "close-superseded",
        help="Comment on and close open automated release PRs older than a target version.",
    )
    close_superseded.add_argument("--target-version", required=True)
    close_superseded.add_argument(
        "--repo", help="GitHub repository, for example owner/name"
    )
    close_superseded.add_argument(
        "--dry-run",
        action="store_true",
        help="Print PRs that would be closed without mutating GitHub state.",
    )

    args = parser.parse_args()

    if args.command == "close-superseded":
        close_superseded_prs(
            target_version=args.target_version,
            repo=args.repo,
            dry_run=args.dry_run,
        )
        return 0

    raise AssertionError(f"unhandled command {args.command!r}")


def close_superseded_prs(
    *, target_version: str, repo: str | None = None, dry_run: bool = False
) -> None:
    target_version = normalize_version(target_version)
    prs = list_open_release_prs(repo=repo)
    stale_prs = superseded_prs(prs, target_version)

    if not stale_prs:
        print(f"No automated Codex release PRs are older than {target_version}.")
        return

    body = superseded_comment(target_version)
    for pr in stale_prs:
        if dry_run:
            print(f"Would close PR #{pr.number}: {pr.title}")
            continue

        print(f"Closing PR #{pr.number}: {pr.title}")
        gh(["pr", "comment", str(pr.number), "--body", body], repo=repo)
        gh(["pr", "close", str(pr.number), "--delete-branch"], repo=repo)


def list_open_release_prs(*, repo: str | None = None) -> list[CodexReleasePr]:
    output = gh(
        [
            "pr",
            "list",
            "--state",
            "open",
            "--base",
            "main",
            "--label",
            AUTOMATED_CODEX_RELEASE_LABEL,
            "--json",
            "number,title,url",
        ],
        repo=repo,
        capture=True,
    )
    payload = json.loads(output)
    return [codex_release_pr(item) for item in payload]


def codex_release_pr(payload: dict[str, Any]) -> CodexReleasePr:
    title = str(payload["title"])
    return CodexReleasePr(
        number=int(payload["number"]),
        title=title,
        url=str(payload.get("url", "")),
        version=version_from_title(title),
    )


def superseded_prs(
    prs: list[CodexReleasePr], target_version: str
) -> list[CodexReleasePr]:
    target = version_key(normalize_version(target_version))
    return [
        pr for pr in prs if pr.version is not None and version_key(pr.version) < target
    ]


def version_from_title(title: str) -> str | None:
    match = CODEX_RELEASE_TITLE.fullmatch(title)
    return match.group(1) if match else None


def superseded_comment(target_version: str) -> str:
    target_version = normalize_version(target_version)
    return (
        f"Closing this automated Codex release PR because `{target_version}` is now "
        "the latest release target. The release automation keeps only the newest "
        "stable Codex update eligible for auto-merge."
    )


def gh(
    args: list[str],
    *,
    repo: str | None = None,
    capture: bool = False,
) -> str:
    command = ["gh", *args]
    if repo:
        command.extend(["--repo", repo])

    result = subprocess.run(
        command,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        check=True,
    )
    return result.stdout if capture else ""


def normalize_version(version: str) -> str:
    normalized = version.removeprefix("v")
    if not CODEX_RELEASE_TITLE.fullmatch(f"Update Codex SDK target to {normalized}"):
        raise ValueError(f"Expected a stable three-part version, got {version!r}")

    return normalized


def version_key(version: str) -> tuple[int, int, int]:
    major, minor, patch = normalize_version(version).split(".")
    return int(major), int(minor), int(patch)


if __name__ == "__main__":
    sys.exit(main())
