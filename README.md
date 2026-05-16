# codex-sdk

Temi-owned convenience SDKs and conformance tooling for Codex.

The Codex app-server generated artifacts are the protocol truth:

- `codex app-server generate-json-schema`
- `codex app-server generate-ts`

This repository wraps the upstream TypeScript and Python SDKs where they exist, adds an Elixir SDK, and keeps low-level transport behavior covered by shared conformance fixtures.

## Packages

- `packages/typescript` - npm package `@usetemi/codex-sdk`
- `packages/python` - PyPI package `usetemi-codex-sdk`
- `packages/elixir` - Hex package `:usetemi_codex_sdk`
- `packages/go` - Go module `github.com/usetemi/codex-sdk/packages/go`
- `packages/conformance` - shared behavior fixtures

## Install

```bash
npm install @usetemi/codex-sdk@0.130.0-2
pip install usetemi-codex-sdk
# Elixir: add {:usetemi_codex_sdk, "0.130.0-2"} to mix.exs, then:
mix deps.get
go get github.com/usetemi/codex-sdk/packages/go@v0.130.0-2
```

For Elixir, add the package to `mix.exs`:

```elixir
def deps do
  [
    {:usetemi_codex_sdk, "0.130.0-2"}
  ]
end
```

## Compatibility

Until Codex reaches `1.0.0`, CI tests latest Codex plus releases from the previous month. Compatibility claims should cite tested Codex versions, not broad semver ranges.

## Development

Run each package's local checks:

```bash
npm run check
```

## Releases

Package versions track the stable Codex version they target. Publishing is handled by the GitHub release workflow; see `docs/releasing.md`.

## License

MIT
