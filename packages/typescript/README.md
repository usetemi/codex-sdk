# @usetemi/codex-sdk

TypeScript wrapper around upstream `@openai/codex-sdk`, plus low-level transport helpers for the Codex app-server JSON-RPC protocol.

## Install

```bash
npm install @usetemi/codex-sdk
```

Package versions track the stable Codex version they target. Version `0.130.0` targets Codex `0.130.0`.

## Usage

```ts
import { AppServerClient } from "@usetemi/codex-sdk";

const client = AppServerClient.start();
try {
  const result = await client.request("initialize", {
    clientInfo: {
      name: "my-client",
      title: "My Client",
      version: "0.1.0",
    },
    capabilities: {},
  });

  console.log(result);
} finally {
  await client.close();
}
```

The `Codex` export is re-exported from upstream `@openai/codex-sdk`. Transport exports are maintained in this package and covered by the shared conformance fixtures in this repository.
