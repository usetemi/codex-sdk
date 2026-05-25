from __future__ import annotations

import unittest

from scripts.codex_release_prs import (
    CodexReleasePr,
    codex_release_pr,
    superseded_comment,
    superseded_prs,
    version_from_title,
)


class CodexReleasePrsTest(unittest.TestCase):
    def test_parses_release_version_from_automation_title(self) -> None:
        self.assertEqual(
            version_from_title("Update Codex SDK target to 1.2.3"), "1.2.3"
        )
        self.assertIsNone(version_from_title("Update something else"))

    def test_builds_release_pr_from_github_payload(self) -> None:
        pr = codex_release_pr(
            {
                "number": 42,
                "title": "Update Codex SDK target to 1.2.3",
                "url": "https://github.com/usetemi/codex-sdk/pull/42",
            }
        )

        self.assertEqual(pr.number, 42)
        self.assertEqual(pr.version, "1.2.3")

    def test_finds_only_prs_older_than_target(self) -> None:
        prs = [
            CodexReleasePr(1, "Update Codex SDK target to 1.2.3", "", "1.2.3"),
            CodexReleasePr(2, "Update Codex SDK target to 1.2.10", "", "1.2.10"),
            CodexReleasePr(3, "Update Codex SDK target to 1.3.0", "", "1.3.0"),
            CodexReleasePr(4, "Unexpected title", "", None),
        ]

        self.assertEqual([pr.number for pr in superseded_prs(prs, "1.2.10")], [1])

    def test_superseded_comment_mentions_target_version(self) -> None:
        self.assertIn("1.2.10", superseded_comment("v1.2.10"))


if __name__ == "__main__":
    unittest.main()
