import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexAuthManager } from "../src/codex-auth.js";
import { parseCliConfig } from "../src/config.js";

test("Codex auth manager parses device login output and detects completed login", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-auth-manager-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const codexHome = path.join(tempDir, "codex-home");
  const codexCommand = path.join(tempDir, "fake-codex.mjs");
  await fs.writeFile(
    codexCommand,
    [
      "#!/usr/bin/env node",
      "import { existsSync } from 'node:fs';",
      "import path from 'node:path';",
      "const args = process.argv.slice(2);",
      "const authPath = path.join(process.env.CODEX_HOME ?? '', 'auth.json');",
      "if (args[0] === 'login' && args[1] === 'status') {",
      "  if (existsSync(authPath)) {",
      "    console.log('Logged in using ChatGPT');",
      "    process.exit(0);",
      "  }",
      "  console.error('Not logged in');",
      "  process.exit(1);",
      "}",
      "if (args[0] === 'login' && args[1] === '--device-auth') {",
      "  console.log('Open https://auth.openai.com/codex/device');",
      "  console.log('Enter ABCD-EFGH');",
      "  console.log('expires in 15 minutes');",
      "  process.exit(0);",
      "}",
      "console.error('unexpected args: ' + args.join(' '));",
      "process.exit(2);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(codexCommand, 0o755);

  let restarts = 0;
  const manager = createCodexAuthManager(
    parseCliConfig(["--codex-command", codexCommand, "--codex-home", codexHome], {}),
    {
      onCredentialsChanged: async () => {
        restarts += 1;
      },
    },
  );
  t.after(async () => {
    await manager.close();
  });

  assert.deepEqual(await manager.status(), {
    authenticated: false,
    message: "Not logged in",
  });

  const started = await manager.startDeviceFlow();
  assert.equal(started.status, "pending");
  assert.equal(started.verification_uri, "https://auth.openai.com/codex/device");
  assert.equal(started.user_code, "ABCD-EFGH");
  assert.equal(restarts, 0);

  await fs.writeFile(path.join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  const completed = await manager.getDeviceFlow(started.flow_id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.message, "Logged in using ChatGPT");
  assert.equal(restarts, 1);

  await manager.getDeviceFlow(started.flow_id);
  assert.equal(restarts, 1);
});

test("Codex auth manager reports login status timeout when Codex does not exit", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-auth-timeout-"));
  t.after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  const codexHome = path.join(tempDir, "codex-home");
  const codexCommand = path.join(tempDir, "hanging-codex.mjs");
  await fs.writeFile(
    codexCommand,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args.join(' ') !== 'login status') {",
      "  console.error('unexpected args: ' + args.join(' '));",
      "  process.exit(2);",
      "}",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  await fs.chmod(codexCommand, 0o755);

  const manager = createCodexAuthManager(
    parseCliConfig(["--codex-command", codexCommand, "--codex-home", codexHome], {}),
    { statusTimeoutMs: 50 },
  );
  t.after(async () => {
    await manager.close();
  });

  const startedAt = Date.now();
  assert.deepEqual(await manager.status(), {
    authenticated: false,
    message: "codex login status timed out after 50ms",
  });
  assert.ok(Date.now() - startedAt < 2_000);
});
