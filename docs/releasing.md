# Releasing

Package versions track the stable Codex CLI version they target. For example, the package release for Codex `0.130.0` is `0.130.0` across npm, PyPI, Hex, and Go.

Use three numeric segments for normal releases. `0.130.0.1` is not portable because npm and Hex reject four-segment versions. If a same-Codex repair release is unavoidable, prefer an exact-pinned suffix such as `0.130.0-1`; note that npm and Hex treat that as a prerelease, while Python packaging normalizes it as a post-release. Avoid this path unless consumers can pin the exact package version.

## Registry Configuration

GitHub environments `npm`, `pypi`, `hex`, and `go` gate publishing. Keep the environments because npm/PyPI trusted publishing and Hex secrets depend on them. For fully automatic Codex update releases, do not configure required reviewers on these environments; required reviewers will leave publish jobs waiting for manual approval.

npm publishes through trusted publishing for package `@usetemi/codex-sdk`:

- GitHub owner: `usetemi`
- Repository: `codex-sdk`
- Workflow filename: `release.yml`
- Environment: `npm`

Set repository variable `NPM_ACCESS` to `public`. Do not use an npm publish token for release automation.

PyPI publishes through trusted publishing for project `usetemi-codex-sdk`:

- GitHub owner: `usetemi`
- Repository: `codex-sdk`
- Workflow filename: `release.yml`
- Environment: `pypi`

Hex publishes package `usetemi_codex_sdk` with the GitHub environment secret `HEX_API_KEY` on the `hex` environment. To rotate the key:

```bash
gh secret set HEX_API_KEY --repo usetemi/codex-sdk --env hex
```

If publishing under a Hex organization, set repository variable `HEX_ORGANIZATION` to the organization name.

Go modules are published by tags, not a package index. Because the Go module is nested under `packages/go`, the release workflow creates a Go module tag named `packages/go/v<version>`, such as `packages/go/v0.130.0`.

## Release Flow

The scheduled `Upstream Codex Release` workflow polls npm for stable `@openai/codex` releases. When a new stable version is available and the matching `@openai/codex-sdk` version is published, it bumps all package manifests, regenerates lock files, runs Codex schema smoke tests, runs `npm run check`, and opens a PR labeled `automated-codex-release`.

After that PR is merged to `main`, `Auto Release After Codex PR` validates that the merged package versions match the PR title, creates a GitHub release tagged `v<version>`, such as `v0.130.0`, and dispatches the existing release workflow. The release workflow then validates the tag, builds package artifacts, publishes to npm, PyPI, and Hex, and creates the Go module tag.

Manual release flow:

1. Update all package versions to the target Codex version.
2. Run `npm run check`.
3. Create and publish a GitHub release tagged `v<version>`, such as `v0.130.0`.
4. The release workflow validates that all package versions match the release tag, builds package artifacts, publishes to npm, PyPI, and Hex, and creates the Go module tag.

The workflow can also be run manually with a `version` input. Manual runs still validate that package manifests match the requested version.
