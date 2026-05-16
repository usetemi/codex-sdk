from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.bump_codex_version import bump
from scripts.release_versions import read_versions


class BumpCodexVersionTest(unittest.TestCase):
    def test_updates_manifests_dependencies_docs_and_python_lock(self) -> None:
        with tempfile.TemporaryDirectory() as workspace:
            root = Path(workspace)
            self.write_repo_files(root)

            bump(root, "1.2.4", update_locks=False)

            self.assertEqual(
                read_versions(root),
                {
                    "typescript": "1.2.4",
                    "proxy": "1.2.4",
                    "python": "1.2.4",
                    "elixir": "1.2.4",
                    "go": "1.2.4",
                },
            )

            package = json.loads(
                (root / "packages/typescript/package.json").read_text()
            )
            self.assertEqual(package["dependencies"]["@openai/codex"], "1.2.4")
            self.assertEqual(package["dependencies"]["@openai/codex-sdk"], "^1.2.4")

            proxy_package = json.loads(
                (root / "apps/codex-openai-proxy/package.json").read_text()
            )
            self.assertEqual(proxy_package["version"], "1.2.4")
            self.assertEqual(proxy_package["dependencies"]["@openai/codex"], "1.2.4")
            self.assertEqual(
                proxy_package["dependencies"]["@usetemi/codex-sdk"], "1.2.4"
            )

            root_readme = (root / "README.md").read_text()
            self.assertIn("@usetemi/codex-sdk@1.2.4", root_readme)
            self.assertIn('{:usetemi_codex_sdk, "1.2.4"}', root_readme)
            self.assertIn("packages/go@v1.2.4", root_readme)

            package_readme = (root / "packages/typescript/README.md").read_text()
            self.assertIn("Version `1.2.4` targets Codex `1.2.4`.", package_readme)
            self.assertIn('version: "0.1.0"', package_readme)

            uv_lock = (root / "packages/python/uv.lock").read_text()
            self.assertIn('name = "usetemi-codex-sdk"\nversion = "1.2.4"', uv_lock)

    def write_repo_files(self, root: Path) -> None:
        for path in [
            "apps/codex-openai-proxy",
            "packages/typescript",
            "packages/python",
            "packages/elixir",
            "packages/go",
        ]:
            (root / path).mkdir(parents=True)

        (root / "packages/typescript/package.json").write_text(
            json.dumps(
                {
                    "name": "@usetemi/codex-sdk",
                    "version": "1.2.3-1",
                    "dependencies": {
                        "@openai/codex": "1.2.3",
                        "@openai/codex-sdk": "^1.2.3",
                    },
                },
                indent=2,
            )
            + "\n"
        )
        (root / "apps/codex-openai-proxy/package.json").write_text(
            json.dumps(
                {
                    "name": "@usetemi/codex-openai-proxy",
                    "version": "1.2.3-1",
                    "dependencies": {
                        "@openai/codex": "1.2.3",
                        "@usetemi/codex-sdk": "1.2.3-1",
                    },
                },
                indent=2,
            )
            + "\n"
        )
        (root / "packages/python/pyproject.toml").write_text(
            '[project]\nname = "usetemi-codex-sdk"\nversion = "1.2.3-1"\n'
        )
        (root / "packages/elixir/mix.exs").write_text('version: "1.2.3-1",\n')
        (root / "packages/go/version.go").write_text(
            'package codexsdk\n\nconst Version = "1.2.3-1"\n'
        )
        (root / "packages/python/uv.lock").write_text(
            'version = 1\n\n[[package]]\nname = "usetemi-codex-sdk"\nversion = "1.2.3-1"\n'
        )

        root_readme = """
# codex-sdk

```bash
npm install @usetemi/codex-sdk@1.2.3-1
# Elixir: add {:usetemi_codex_sdk, "1.2.3-1"} to mix.exs, then:
go get github.com/usetemi/codex-sdk/packages/go@v1.2.3-1
```

{:usetemi_codex_sdk, "1.2.3-1"}
"""
        (root / "README.md").write_text(root_readme)

        package_readme = """
Package versions track the stable Codex version they target. Version `1.2.3-1` targets Codex `1.2.3`.

```ts
version: "0.1.0",
```
"""
        for package in ["typescript", "python", "elixir", "go"]:
            (root / f"packages/{package}/README.md").write_text(package_readme)
        (root / "apps/codex-openai-proxy/README.md").write_text(package_readme)


if __name__ == "__main__":
    unittest.main()
