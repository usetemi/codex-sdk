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
