# usetemi-codex-sdk

Temi convenience wrapper around the upstream `openai-codex` Python SDK when it is available, plus low-level transport helpers shared with the TypeScript, Elixir, and Go packages.

## Install

```bash
pip install usetemi-codex-sdk==0.130.0.post5
```

Package versions track the stable Codex version they target. Version `0.130.0-7` targets Codex `0.130.0`.

## Usage

```python
from usetemi_codex_sdk import AppServerClient

with AppServerClient.start() as client:
    result = client.request(
        "initialize",
        {
            "clientInfo": {
                "name": "my-client",
                "title": "My Client",
                "version": "0.1.0",
            },
            "capabilities": {},
        },
    )
    print(result)
```

The `Codex` and `AsyncCodex` wrappers load the upstream `openai-codex` package dynamically. The low-level transport helpers are available without that upstream package.
