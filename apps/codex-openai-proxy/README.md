# @usetemi/codex-openai-proxy

OpenAI-compatible HTTP proxy for Codex app-server. Run the proxy, point standard OpenAI clients at `/v1`, and the proxy translates supported requests to Codex turns.

Version `0.130.0-2` targets Codex `0.130.0`.

## Run

```bash
npx @usetemi/codex-openai-proxy --api-key local-proxy-token
```

Use the proxy with normal OpenAI clients:

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "local-proxy-token",
  baseURL: "http://127.0.0.1:8080/v1",
});

const response = await client.responses.create({
  model: "codex-mini",
  input: "Summarize this repository.",
});

console.log(response.output_text);
```

The client API key authenticates the caller to this proxy only. It is not forwarded to Codex as an OpenAI API key.

## Codex Auth

The proxy starts `codex app-server --listen stdio://`. Codex itself can authenticate in either mode:

- Login mode: run `codex login` as the service user before starting the proxy. For containers, mount a persisted `CODEX_HOME`.
- API-key mode: set `CODEX_API_KEY`; the proxy passes it through to the Codex subprocess.

## Configuration

Flags override environment variables.

| Flag | Environment | Default |
| --- | --- | --- |
| `--host` | `CODEX_OPENAI_PROXY_HOST` | `127.0.0.1` |
| `--port` | `CODEX_OPENAI_PROXY_PORT`, then `PORT` | `8080` |
| `--api-key` | `CODEX_OPENAI_PROXY_API_KEYS` | none |
| `--auth disabled` | `CODEX_OPENAI_PROXY_AUTH=disabled` | local loopback only when no keys are set |
| `--codex-command` | `CODEX_OPENAI_PROXY_CODEX_COMMAND` | `codex` |
| `--codex-home` | `CODEX_HOME` | inherited |
| `--codex-api-key` | `CODEX_API_KEY` | inherited |
| `--cwd` | `CODEX_OPENAI_PROXY_CWD` | none |
| `--model` | `CODEX_OPENAI_PROXY_MODEL` | request model |
| `--model-provider` | `CODEX_OPENAI_PROXY_MODEL_PROVIDER` | Codex default |
| `--sandbox` | `CODEX_OPENAI_PROXY_SANDBOX` | `read-only` |
| `--approval-policy` | `CODEX_OPENAI_PROXY_APPROVAL_POLICY` | `never` |

When binding to a non-loopback host, configure `CODEX_OPENAI_PROXY_API_KEYS` or explicitly set `CODEX_OPENAI_PROXY_AUTH=disabled` if another layer handles authentication.

## Docker

The container listens on `0.0.0.0:8080`.

Persisted login state:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=proxy-token \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  ghcr.io/usetemi/codex-openai-proxy:0.130.0-2
```

API-key mode:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=proxy-token \
  -e CODEX_API_KEY="$CODEX_API_KEY" \
  ghcr.io/usetemi/codex-openai-proxy:0.130.0-2
```

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Streaming chat completions and responses are supported with server-sent events. Unsupported OpenAI features return `501 unsupported_feature`.
