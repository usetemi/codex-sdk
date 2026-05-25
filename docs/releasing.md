# Releasing

Package versions track the stable Codex CLI version they target. For example, the package release for Codex `0.130.0` is `0.130.0` across npm, PyPI, Hex, Go, and the proxy container image.

Use three numeric segments for normal releases. `0.130.0.1` is not portable because npm and Hex reject four-segment versions. If a same-Codex repair release is unavoidable, prefer an exact-pinned suffix such as `0.130.0-1`; note that npm and Hex treat that as a prerelease, while Python packaging normalizes it as a post-release. Avoid this path unless consumers can pin the exact package version.

## Registry Configuration

GitHub environments `npm`, `pypi`, `hex`, and `go` gate publishing. Keep the environments because npm/PyPI trusted publishing and Hex secrets depend on them. For fully automatic Codex update releases, do not configure required reviewers on these environments; required reviewers will leave publish jobs waiting for manual approval.

npm publishes through trusted publishing for packages `@usetemi/codex-sdk` and `@usetemi/codex-openai-proxy`:

- GitHub owner: `usetemi`
- Repository: `codex-sdk`
- Workflow filename: `release.yml`
- Environment: `npm`

Set repository variable `NPM_ACCESS` to `public`. Do not use an npm publish token for release automation.

The proxy image publishes to GHCR as `ghcr.io/usetemi/codex-openai-proxy:<version>`. Stable releases also update `ghcr.io/usetemi/codex-openai-proxy:latest`; prereleases only publish the exact version tag.

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

The scheduled `Upstream Codex Release` workflow polls npm for stable `@openai/codex` releases. When a new stable version is available and the matching `@openai/codex-sdk` version is published, it bumps all package manifests, regenerates lock files, runs Codex schema smoke tests, runs `npm run check`, and opens or updates a PR labeled `automated-codex-release`.

Set repository secret `CODEX_RELEASE_AUTOMATION_TOKEN` to a GitHub App token or fine-grained PAT with contents and pull request write access. The release workflow uses that token for the release PR commit and auto-merge setup so normal `pull_request` CI runs before the PR can merge. Keep repository auto-merge enabled and branch protection requiring the CI jobs that must pass before automated Codex release PRs merge.

The workflow closes older open `automated-codex-release` PRs once a newer stable target exists. The newest eligible PR is configured for squash auto-merge after the release workflow's own validation passes; GitHub completes the merge only after required PR checks pass.

After that PR is merged to `main`, `Auto Release After Codex PR` validates that the merged package versions match the PR title, creates a GitHub release tagged `v<version>`, such as `v0.130.0`, and dispatches the existing release workflow. The release workflow then validates the tag, builds package artifacts, publishes to npm, PyPI, Hex, and GHCR, and creates the Go module tag.

Manual release flow:

1. Update all package versions to the target Codex version.
2. Run `npm run check`.
3. Create and publish a GitHub release tagged `v<version>`, such as `v0.130.0`.
4. The release workflow validates that all package versions match the release tag, builds package artifacts, publishes to npm, PyPI, Hex, and GHCR, and creates the Go module tag.

The workflow can also be run manually with a `version` input. Manual runs still validate that package manifests match the requested version.
