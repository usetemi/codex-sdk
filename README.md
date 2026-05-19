# codex-sdk

Temi-owned convenience SDKs and conformance tooling for Codex.

The Codex app-server generated artifacts are the protocol truth:

- `codex app-server generate-json-schema`
- `codex app-server generate-ts`

This repository wraps the upstream TypeScript and Python SDKs where they exist, adds an Elixir SDK, and keeps low-level transport behavior covered by shared conformance fixtures.

## Packages

SDK packages:

- `packages/typescript` - npm package `@usetemi/codex-sdk`
- `packages/python` - PyPI package `usetemi-codex-sdk`
- `packages/elixir` - Hex package `:usetemi_codex_sdk`
- `packages/go` - Go module `github.com/usetemi/codex-sdk/packages/go`

Deployable apps:

- `apps/codex-openai-proxy` - npm package `@usetemi/codex-openai-proxy` and container image `ghcr.io/usetemi/codex-openai-proxy`. This is a standalone OpenAI-compatible HTTP proxy for Codex app-server, not a language SDK.

Shared fixtures:

- `packages/conformance` - shared behavior fixtures

## Install

TypeScript SDK:

```bash
npm install @usetemi/codex-sdk@0.131.0
```

Codex OpenAI proxy from npm:

```bash
npx @usetemi/codex-openai-proxy@0.131.0 --api-key local-proxy-token
```

Python SDK:

```bash
pip install usetemi-codex-sdk==0.130.0.post5
```

Elixir SDK:

```elixir
def deps do
  [
    {:usetemi_codex_sdk, "0.131.0"}
  ]
end
```

```bash
mix deps.get
```

Go SDK:

```bash
go get github.com/usetemi/codex-sdk/packages/go@v0.131.0
```

## Codex OpenAI Proxy

`@usetemi/codex-openai-proxy` runs Codex app-server behind an OpenAI-compatible `/v1` HTTP API for standard OpenAI clients. It also exposes `/auth/*` endpoints so an operator or web app can re-auth the service-wide Codex identity without redeploying.

The GHCR image is public and can be pulled without `docker login`. Run it with managed web re-auth and persisted proxy data:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=local-proxy-token \
  -v codex-openai-proxy-data:/data \
  ghcr.io/usetemi/codex-openai-proxy:0.131.0
```

Open `http://127.0.0.1:8080/auth` for the bundled operator UI, or start the device-login flow directly:

```bash
curl -X POST \
  -H "Authorization: Bearer local-proxy-token" \
  http://127.0.0.1:8080/auth/device
```

Credential changes restart the underlying Codex app-server connection, so active `/v1` requests can fail during re-auth.

You can still run with Codex API-key auth:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=local-proxy-token \
  -e CODEX_API_KEY="$CODEX_API_KEY" \
  ghcr.io/usetemi/codex-openai-proxy:0.131.0
```

Or mount existing `codex login` state:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=local-proxy-token \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  ghcr.io/usetemi/codex-openai-proxy:0.131.0
```

Point OpenAI clients at `http://127.0.0.1:8080/v1` and use `local-proxy-token` as the client API key. That token authenticates callers to the proxy only; Codex auth comes from managed proxy storage, `CODEX_API_KEY`, or an explicit `CODEX_HOME`.

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
