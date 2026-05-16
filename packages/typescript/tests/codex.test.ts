import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Codex, type ThreadOptions } from "../src/index";

type FakeCodex = {
  command: string;
  argvPath: string;
};

function createFakeCodex(t: { after: (fn: () => void) => void }): FakeCodex {
  const dir = mkdtempSync(join(tmpdir(), "usetemi-codex-sdk-"));
  const command = join(dir, "codex-fake.mjs");
  const argvPath = join(dir, "argv.json");
  writeFileSync(
    command,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const argvPath = process.env.FAKE_CODEX_ARGV_PATH;
if (!argvPath) {
  console.error("missing FAKE_CODEX_ARGV_PATH");
  process.exit(1);
}

const inputChunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputChunks.push(chunk);
});
process.stdin.on("end", () => {
  writeFileSync(argvPath, JSON.stringify(process.argv.slice(2)), "utf8");
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };
  const events = [
    { type: "thread.started", thread_id: "thread-fake" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item-1", type: "agent_message", text: "ok" } },
    { type: "turn.completed", usage },
  ];
  for (const event of events) {
    console.log(JSON.stringify(event));
  }
});
`,
    "utf8",
  );
  chmodSync(command, 0o755);
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return { command, argvPath };
}

function createCodex(fake: FakeCodex): Codex {
  return new Codex({
    codexPathOverride: fake.command,
    env: {
      FAKE_CODEX_ARGV_PATH: fake.argvPath,
      PATH: process.env.PATH ?? "",
    },
  });
}

function readArgv(fake: FakeCodex): string[] {
  return JSON.parse(readFileSync(fake.argvPath, "utf8")) as string[];
}

test("startThread does not pass --ephemeral by default", async (t) => {
  const fake = createFakeCodex(t);
  const codex = createCodex(fake);

  await codex.startThread().run("hello");

  assert.equal(readArgv(fake).includes("--ephemeral"), false);
});

test("startThread passes --ephemeral when requested", async (t) => {
  const fake = createFakeCodex(t);
  const codex = createCodex(fake);
  const options: ThreadOptions = { ephemeral: true };

  await codex.startThread(options).run("hello");

  assert.equal(readArgv(fake).includes("--ephemeral"), true);
});

test("resumeThread places --ephemeral before the resume subcommand", async (t) => {
  const fake = createFakeCodex(t);
  const codex = createCodex(fake);

  await codex.resumeThread("thread-123", { ephemeral: true }).run("hello");

  const argv = readArgv(fake);
  const ephemeralIndex = argv.indexOf("--ephemeral");
  const resumeIndex = argv.indexOf("resume");
  assert.notEqual(ephemeralIndex, -1);
  assert.notEqual(resumeIndex, -1);
  assert.ok(ephemeralIndex < resumeIndex);
  assert.deepEqual(argv.slice(resumeIndex, resumeIndex + 2), ["resume", "thread-123"]);
});
