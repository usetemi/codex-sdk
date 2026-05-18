# @usetemi/codex-sdk

TypeScript wrapper around upstream `@openai/codex-sdk`, plus low-level transport helpers for the Codex app-server JSON-RPC protocol.

## Install

```bash
npm install @usetemi/codex-sdk@0.130.0-6
```

Package versions track the stable Codex version they target. Version `0.130.0-6` targets Codex `0.130.0`.

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

## Ephemeral Codex Threads

The `Codex` export is compatible with upstream `@openai/codex-sdk` and adds thread-level ephemeral sessions. Use `ephemeral` for repeated one-shot workloads where persisted session files are not useful.

```ts
import { Codex } from "@usetemi/codex-sdk";

const codex = new Codex();
const thread = codex.startThread({
  ephemeral: true,
  skipGitRepoCheck: true,
});

const turn = await thread.run("Summarize this checkout");
console.log(turn.finalResponse);
```

Ephemeral runs pass `--ephemeral` to `codex exec` and do not persist session files. Callers should not depend on resuming those sessions later.

Transport exports are maintained in this package and covered by the shared conformance fixtures in this repository.
