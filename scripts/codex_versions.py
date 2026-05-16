#!/usr/bin/env python3
"""Print Codex release tags from the previous month plus the latest release."""

from __future__ import annotations

import datetime as dt
import json
import re
import subprocess
import sys

STABLE_CODEX_RELEASE = re.compile(r"^rust-v\d+\.\d+\.\d+$")


def main() -> int:
    payload = subprocess.check_output(
        [
            "gh",
            "release",
            "list",
            "--repo",
            "openai/codex",
            "--limit",
            "100",
            "--json",
            "tagName,publishedAt,isLatest",
        ],
        text=True,
    )
    releases = json.loads(payload)
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=31)
    selected = []

    for release in releases:
        tag_name = release["tagName"]
        if not STABLE_CODEX_RELEASE.fullmatch(tag_name):
            continue

        published_at = dt.datetime.fromisoformat(
            release["publishedAt"].replace("Z", "+00:00")
        )
        if release.get("isLatest") or published_at >= cutoff:
            selected.append(tag_name)

    for tag in sorted(set(selected)):
        print(tag)

    return 0


if __name__ == "__main__":
    sys.exit(main())
