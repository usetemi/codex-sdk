# codex-sdk

Shared instructions for agents working in this repository.

## Project

This repo contains Temi-owned convenience SDKs and conformance tooling for Codex:

- TypeScript wrapper package around upstream `@openai/codex-sdk`
- Python wrapper package around upstream `openai-codex` when it is available
- Elixir SDK package for Codex app-server
- Go SDK module for Codex app-server
- Shared conformance fixtures for low-level protocol and transport behavior

The Codex generated artifacts are the protocol truth:

- `codex app-server generate-json-schema`
- `codex app-server generate-ts`

Do not treat temporary notes copied from Symphony as canonical when generated Codex protocol artifacts disagree.

## Development

- Use red/green TDD.
- Start with low-level primitives before higher-level SDK ergonomics.
- Keep TypeScript and Python close to upstream SDK behavior unless there is a clear Temi-specific wrapper need.
- Keep Elixir aligned with app-server generated schemas and the shared fixture suite.
- Do not vendor `openai/codex`; clone or fetch it temporarily when reference code is needed.

## Checks

Run the relevant package checks before handoff:

```bash
npm run check
```

## Release Notes

- Package versions usually track the target Codex version exactly. For a same-Codex repair release, use a prerelease suffix such as `0.130.0-1` across all package manifests so `scripts/release_versions.py --expect <version>` passes.
- npm rejects prerelease publishes unless a dist-tag is provided. The release workflow handles this by publishing prerelease versions with `--tag "${NPM_TAG:-next}"`; expect `latest` to remain on the stable version.
- PyPI publishing for `usetemi-codex-sdk` is still pending organization approval/trusted-publisher setup.
- Skip npm publishing for `@usetemi/codex-openai-proxy`; use the GHCR image for proxy distribution.
- If an all-package release partially fails after npm artifact build, rerun `.github/workflows/release.yml` manually with `publish_target=npm` and the same version to publish only npm without retrying PyPI, Hex, or Go.
- Protected release environments may need approval before publish jobs run. Check pending deployments with `gh api repos/usetemi/codex-sdk/actions/runs/<run_id>/pending_deployments`.
