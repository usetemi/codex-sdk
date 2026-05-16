from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.release_versions import read_versions, validate_expected_version


class ReleaseVersionsTest(unittest.TestCase):
    def test_reads_all_package_versions(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            self.write_package_files(root, version="1.2.3")

            self.assertEqual(
                read_versions(root),
                {
                    "typescript": "1.2.3",
                    "proxy": "1.2.3",
                    "python": "1.2.3",
                    "elixir": "1.2.3",
                    "go": "1.2.3",
                },
            )

    def test_accepts_leading_v_for_expected_version(self) -> None:
        versions = {
            "typescript": "1.2.3",
            "proxy": "1.2.3",
            "python": "1.2.3",
            "elixir": "1.2.3",
            "go": "1.2.3",
        }

        validate_expected_version("v1.2.3", versions)

    def test_accepts_same_codex_repair_suffix(self) -> None:
        versions = {
            "typescript": "1.2.3-1",
            "proxy": "1.2.3-1",
            "python": "1.2.3-1",
            "elixir": "1.2.3-1",
            "go": "1.2.3-1",
        }

        validate_expected_version("v1.2.3-1", versions)

    def test_rejects_mismatched_versions(self) -> None:
        versions = {
            "typescript": "1.2.3",
            "proxy": "1.2.3",
            "python": "1.2.4",
            "elixir": "1.2.3",
            "go": "1.2.3",
        }

        with self.assertRaisesRegex(ValueError, "python=1.2.4"):
            validate_expected_version("1.2.3", versions)

    def write_package_files(self, root: Path, *, version: str) -> None:
        typescript = root / "packages" / "typescript"
        proxy = root / "apps" / "codex-openai-proxy"
        python = root / "packages" / "python"
        elixir = root / "packages" / "elixir"
        go = root / "packages" / "go"
        typescript.mkdir(parents=True)
        proxy.mkdir(parents=True)
        python.mkdir(parents=True)
        elixir.mkdir(parents=True)
        go.mkdir(parents=True)

        (typescript / "package.json").write_text(
            f'{{"name": "@usetemi/codex-sdk", "version": "{version}"}}\n'
        )
        (proxy / "package.json").write_text(
            f'{{"name": "@usetemi/codex-openai-proxy", "version": "{version}"}}\n'
        )
        (python / "pyproject.toml").write_text(f'[project]\nversion = "{version}"\n')
        (elixir / "mix.exs").write_text(f'version: "{version}",\n')
        (go / "version.go").write_text(
            f'package codexsdk\n\nconst Version = "{version}"\n'
        )


if __name__ == "__main__":
    unittest.main()
