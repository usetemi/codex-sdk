from __future__ import annotations

import unittest

from scripts.upstream_codex_release import decide_release, latest_stable_npm_version


class UpstreamCodexReleaseTest(unittest.TestCase):
    def test_selects_highest_stable_npm_version(self) -> None:
        def fake_versions(_package: str) -> list[str]:
            return ["1.2.9", "1.2.10-beta.1", "1.2.10", "1.3.0-alpha.1"]

        original = latest_stable_npm_version.__globals__["npm_package_versions"]
        latest_stable_npm_version.__globals__["npm_package_versions"] = fake_versions
        try:
            self.assertEqual(latest_stable_npm_version("@openai/codex"), "1.2.10")
        finally:
            latest_stable_npm_version.__globals__["npm_package_versions"] = original

    def test_decides_new_version_needs_pr(self) -> None:
        decision = decide_release(
            version="1.2.4",
            codex_sdk_version="1.2.4",
            current_package_version="1.2.3",
            current_codex_version="1.2.3",
            branch="automation/codex-v1.2.4",
            branch_exists=False,
            pr_exists=False,
        )

        self.assertTrue(decision.should_update)
        self.assertEqual(decision.branch, "automation/codex-v1.2.4")
        self.assertEqual(decision.github_outputs()["should_update"], "true")

    def test_skips_when_repo_already_targets_version(self) -> None:
        decision = decide_release(
            version="1.2.4",
            codex_sdk_version="1.2.4",
            current_package_version="1.2.4-1",
            current_codex_version="1.2.4",
            branch="automation/codex-v1.2.4",
            branch_exists=False,
            pr_exists=False,
        )

        self.assertFalse(decision.should_update)
        self.assertIn("already targets", decision.reason)

    def test_skips_when_repo_already_targets_newer_version(self) -> None:
        decision = decide_release(
            version="1.2.4",
            codex_sdk_version="1.2.4",
            current_package_version="1.2.5",
            current_codex_version="1.2.5",
            branch="automation/codex-v1.2.4",
            branch_exists=False,
            pr_exists=False,
        )

        self.assertFalse(decision.should_update)
        self.assertIn("already targets Codex 1.2.5", decision.reason)

    def test_updates_when_automation_branch_exists(self) -> None:
        decision = decide_release(
            version="1.2.4",
            codex_sdk_version="1.2.4",
            current_package_version="1.2.3",
            current_codex_version="1.2.3",
            branch="automation/codex-v1.2.4",
            branch_exists=True,
            pr_exists=False,
        )

        self.assertTrue(decision.should_update)
        self.assertIn("update and revalidate", decision.reason)

    def test_updates_when_open_pr_exists(self) -> None:
        decision = decide_release(
            version="1.2.4",
            codex_sdk_version="1.2.4",
            current_package_version="1.2.3",
            current_codex_version="1.2.3",
            branch="automation/codex-v1.2.4",
            branch_exists=False,
            pr_exists=True,
        )

        self.assertTrue(decision.should_update)
        self.assertIn("update and revalidate", decision.reason)


if __name__ == "__main__":
    unittest.main()
