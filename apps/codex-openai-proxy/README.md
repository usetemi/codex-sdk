# @usetemi/codex-openai-proxy

OpenAI-compatible HTTP proxy for Codex app-server. Run the proxy, point standard OpenAI clients at `/v1`, and the proxy translates supported requests to Codex turns.

Version `0.132.0` targets Codex `0.132.0`.

## Run

```bash
npx @usetemi/codex-openai-proxy@0.132.0 --api-key local-proxy-token
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

- Managed login mode: let the proxy manage a writable Codex home. Operators can re-auth through `/auth/*` without redeploying.
- Login mode: run `codex login` as the service user before starting the proxy, then pass `CODEX_HOME`.
- API-key mode: set `CODEX_API_KEY`; the proxy passes it through to the Codex subprocess.

Client API keys protect both `/v1/*` and `/auth/*` when proxy auth is enabled. `GET /` is a public landing page, `GET /auth` is a public browser operator UI, and `GET /AGENTS.md` is public guidance for humans and coding agents.

Changing Codex credentials restarts the underlying Codex app-server connection. Active `/v1` requests can fail during that restart.

Web re-auth flow:

```text
http://127.0.0.1:8080/auth
```

API flow:

```bash
curl -H "Authorization: Bearer proxy-token" http://127.0.0.1:8080/auth/status

curl -X POST \
  -H "Authorization: Bearer proxy-token" \
  http://127.0.0.1:8080/auth/device
```

Open the returned `verification_uri`, enter the returned `user_code`, then poll `GET /auth/device/{flow_id}` until `status` is `completed`.

Restart Codex without changing credentials:

```bash
curl -X POST \
  -H "Authorization: Bearer proxy-token" \
  http://127.0.0.1:8080/auth/restart
```

To import local Codex login state instead:

```bash
curl -X POST \
  -H "Authorization: Bearer proxy-token" \
  -H "Content-Type: application/json" \
  --data-binary @${CODEX_HOME:-$HOME/.codex}/auth.json \
  http://127.0.0.1:8080/auth/import
```

## Configuration

Flags override environment variables.

| Flag | Environment | Default |
| --- | --- | --- |
| `--host` | `CODEX_OPENAI_PROXY_HOST` | `127.0.0.1` |
| `--port` | `CODEX_OPENAI_PROXY_PORT`, then `PORT` | `8080` |
| `--api-key` | `CODEX_OPENAI_PROXY_API_KEYS` | none |
| `--auth disabled` | `CODEX_OPENAI_PROXY_AUTH=disabled` | local loopback only when no keys are set |
| `--codex-command` | `CODEX_OPENAI_PROXY_CODEX_COMMAND` | `codex` |
| `--codex-home` | `CODEX_HOME` | `<data-dir>/codex-home` |
| `--codex-api-key` | `CODEX_API_KEY` | inherited |
| `--data-dir` | `CODEX_OPENAI_PROXY_DATA_DIR` | `~/.local/share/codex-openai-proxy` |
| `--cwd` | `CODEX_OPENAI_PROXY_CWD` | none |
| `--model` | `CODEX_OPENAI_PROXY_MODEL` | request model |
| `--model-provider` | `CODEX_OPENAI_PROXY_MODEL_PROVIDER` | Codex default |
| `--sandbox` | `CODEX_OPENAI_PROXY_SANDBOX` | `read-only` |
| `--approval-policy` | `CODEX_OPENAI_PROXY_APPROVAL_POLICY` | `never` |

When binding to a non-loopback host, configure `CODEX_OPENAI_PROXY_API_KEYS` or explicitly set `CODEX_OPENAI_PROXY_AUTH=disabled` if another layer handles authentication.

## Docker

The container listens on `0.0.0.0:8080` and defaults `CODEX_OPENAI_PROXY_DATA_DIR=/data`.

Managed web re-auth with persisted proxy data:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=proxy-token \
  -v codex-openai-proxy-data:/data \
  ghcr.io/usetemi/codex-openai-proxy:0.132.0
```

Then visit `http://127.0.0.1:8080/auth` or call `/auth/device` from your web app.

Existing persisted login state:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=proxy-token \
  -e CODEX_HOME=/codex-home \
  -v codex-home:/codex-home \
  ghcr.io/usetemi/codex-openai-proxy:0.132.0
```

API-key mode:

```bash
docker run --rm -p 8080:8080 \
  -e CODEX_OPENAI_PROXY_API_KEYS=proxy-token \
  -e CODEX_API_KEY="$CODEX_API_KEY" \
  ghcr.io/usetemi/codex-openai-proxy:0.132.0
```

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `GET /`
- `GET /auth`
- `GET /AGENTS.md`
- `GET /auth/status`
- `POST /auth/restart`
- `POST /auth/device`
- `GET /auth/device/{flow_id}`
- `POST /auth/device/{flow_id}/cancel`
- `POST /auth/import`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Streaming chat completions and responses are supported with server-sent events. Unsupported OpenAI features return `501 unsupported_feature`.
