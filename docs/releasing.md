# Releasing

Package versions track the stable Codex CLI version they target. For example, the package release for Codex `0.130.0` is `0.130.0` across npm, PyPI, Hex, and Go.

Use three numeric segments for normal releases. `0.130.0.1` is not portable because npm and Hex reject four-segment versions. If a same-Codex repair release is unavoidable, prefer an exact-pinned suffix such as `0.130.0-1`; note that npm and Hex treat that as a prerelease, while Python packaging normalizes it as a post-release. Avoid this path unless consumers can pin the exact package version.

## Registry Setup

Create GitHub environments named `npm`, `pypi`, `hex`, and `go`. Use required reviewers for these environments before enabling real publishing. If GitHub rejects required reviewers while the repository is private, make the repository public first and add the reviewers before creating the release.

For npm trusted publishing, configure package `@usetemi/codex-sdk` with:

- GitHub owner: `usetemi`
- Repository: `codex-sdk`
- Workflow filename: `release.yml`
- Environment: `npm`

Set repository variable `NPM_ACCESS` to `public`.

If npm does not allow trusted publishing to be configured before the first package version exists, create a one-time granular npm token with publish access and add it as GitHub environment secret `NPM_TOKEN` on the `npm` environment. After the first release, configure the trusted publisher from package settings and delete `NPM_TOKEN`.

For PyPI trusted publishing, configure project `usetemi-codex-sdk` with:

- GitHub owner: `usetemi`
- Repository: `codex-sdk`
- Workflow filename: `release.yml`
- Environment: `pypi`

For Hex, publish package `usetemi_codex_sdk`. Hex 2.4 uses browser-based OAuth for local authentication and no longer exposes `mix hex.user key generate` in all clients. For CI, create an API key from the Hex.pm dashboard and add it as GitHub environment secret `HEX_API_KEY` on the `hex` environment:

```bash
gh secret set HEX_API_KEY --repo usetemi/codex-sdk --env hex
```

If publishing under a Hex organization, set repository variable `HEX_ORGANIZATION` to the organization name.

Go modules are published by tags, not a package index. Because the Go module is nested under `packages/go`, the release workflow creates a Go module tag named `packages/go/v<version>`, such as `packages/go/v0.130.0`.

## Release Flow

1. Update all package versions to the target Codex version.
2. Run `npm run check`.
3. Confirm the repository is public and the registry trusted publishers are configured.
4. Create and publish a GitHub release tagged `v<version>`, such as `v0.130.0`.
5. The release workflow validates that all package versions match the release tag, builds package artifacts, publishes to npm, PyPI, and Hex, and creates the Go module tag.

The workflow can also be run manually with a `version` input. Manual runs still validate that package manifests match the requested version.

## First Public Release Checklist

Before the first public release:

1. Verify registry ownership and trusted publishing:
   - npm package `@usetemi/codex-sdk`
   - PyPI project `usetemi-codex-sdk`
   - Hex package `usetemi_codex_sdk`
2. Run release-readiness checks:

   ```bash
   npm ci
   cd packages/elixir && mix deps.get
   cd ../..
   npm run check
   ```

3. Rewrite private Git history into one public root commit while the repository is still private:

   ```bash
   git status --short
   git checkout --orphan public-main
   git add -A
   git commit -m "Initial public Codex SDK release"
   git branch -M main
   git push --force origin main
   ```

4. Make the repository public:

   ```bash
   gh repo edit usetemi/codex-sdk --visibility public --accept-visibility-change-consequences
   ```

5. Add required reviewers to the publishing environments if they were not available while the repository was private.

6. Create the release:

   ```bash
   gh release create v0.130.0 --repo usetemi/codex-sdk --title "v0.130.0" --notes "Initial public release for Codex 0.130.0."
   ```
