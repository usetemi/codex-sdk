import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { FakeAppServer, startOpenAICompatFixtureServer } from "../support/openai-compat-fixture";

const execFileAsync = promisify(execFile);

const NODE_OPENAI_VERSION = process.env.OPENAI_COMPAT_NODE_VERSION ?? "6.38.0";
const PYTHON_OPENAI_VERSION = process.env.OPENAI_COMPAT_PYTHON_VERSION ?? "2.37.0";
const GO_OPENAI_VERSION = process.env.OPENAI_COMPAT_GO_VERSION ?? "v3.36.0";
const COMPAT_API_KEY = "compat-token";

test("openai-node release works against the Codex OpenAI-compatible facade", async (t) => {
  const baseUrl = await startSdkCompatServer(t);
  await runOpenAINodeClient(baseUrl, NODE_OPENAI_VERSION);
});

test("openai-python release works against the Codex OpenAI-compatible facade", async (t) => {
  const baseUrl = await startSdkCompatServer(t);
  await runOpenAIPythonClient(baseUrl, PYTHON_OPENAI_VERSION);
});

test("openai-go release works against the Codex OpenAI-compatible facade", async (t) => {
  const baseUrl = await startSdkCompatServer(t);
  await runOpenAIGoClient(baseUrl, GO_OPENAI_VERSION);
});

test("raw Elixir HTTP works against the Codex OpenAI-compatible facade", async (t) => {
  const baseUrl = await startSdkCompatServer(t);
  await runOpenAIElixirClient(baseUrl);
});

async function startSdkCompatServer(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<string> {
  const fake = new FakeAppServer();
  fake.modelPages = [{ data: [{ id: "codex-mini" }], nextCursor: null }];
  fake.responseText = "compat response";
  fake.streamDeltas = ["compat ", "response"];
  const baseUrl = await startOpenAICompatFixtureServer(t, fake, { bearerToken: COMPAT_API_KEY });
  return `${baseUrl}/v1`;
}

async function runOpenAINodeClient(baseUrl: string, version: string): Promise<void> {
  await withTempDir("codex-openai-node-", async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
      "utf8",
    );
    await copyFile(
      path.join(import.meta.dirname, "openai-node-client.mjs"),
      path.join(dir, "client.mjs"),
    );
    await execChecked(
      "npm",
      ["install", "--no-audit", "--no-fund", "--silent", nodePackage(version)],
      {
        cwd: dir,
      },
    );
    await execChecked(process.execPath, ["client.mjs"], {
      cwd: dir,
      env: compatEnv(baseUrl),
    });
  });
}

async function runOpenAIPythonClient(baseUrl: string, version: string): Promise<void> {
  await withTempDir("codex-openai-python-", async (dir) => {
    await copyFile(
      path.join(import.meta.dirname, "openai-python-client.py"),
      path.join(dir, "client.py"),
    );
    await execChecked(
      "uv",
      ["run", "--no-project", "--with", pythonPackage(version), "python", "client.py"],
      {
        cwd: dir,
        env: compatEnv(baseUrl),
      },
    );
  });
}

async function runOpenAIGoClient(baseUrl: string, version: string): Promise<void> {
  await withTempDir("codex-openai-go-", async (dir) => {
    await writeFile(
      path.join(dir, "go.mod"),
      ["module example.com/codex-openai-compat", "", "go 1.22", ""].join("\n"),
      "utf8",
    );
    await copyFile(
      path.join(import.meta.dirname, "openai-go-client.go"),
      path.join(dir, "main.go"),
    );
    await execChecked("go", ["get", goPackage(version)], {
      cwd: dir,
    });
    await execChecked("go", ["run", "."], {
      cwd: dir,
      env: compatEnv(baseUrl),
    });
  });
}

async function runOpenAIElixirClient(baseUrl: string): Promise<void> {
  await withTempDir("codex-openai-elixir-", async (dir) => {
    await copyFile(
      path.join(import.meta.dirname, "openai-elixir-client.exs"),
      path.join(dir, "client.exs"),
    );
    await execChecked("elixir", ["client.exs"], {
      cwd: dir,
      env: compatEnv(baseUrl),
    });
  });
}

function nodePackage(version: string): string {
  return version === "latest" ? "openai@latest" : `openai@${version}`;
}

function pythonPackage(version: string): string {
  return version === "latest" ? "openai" : `openai==${version}`;
}

function goPackage(version: string): string {
  return version === "latest"
    ? "github.com/openai/openai-go/v3@latest"
    : `github.com/openai/openai-go/v3@${version}`;
}

function compatEnv(baseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENAI_COMPAT_BASE_URL: baseUrl,
    OPENAI_COMPAT_API_KEY: COMPAT_API_KEY,
  };
}

async function withTempDir(prefix: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false, `${dir} should be removed after compat run`);
}

async function execChecked(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(typeof result.stdout, "string");
  } catch (error) {
    if (error && typeof error === "object") {
      const record = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
      const message = typeof record.message === "string" ? record.message : "command failed";
      const stdout = typeof record.stdout === "string" ? record.stdout : "";
      const stderr = typeof record.stderr === "string" ? record.stderr : "";
      throw new Error(`${command} ${args.join(" ")} failed: ${message}\n${stdout}\n${stderr}`, {
        cause: error,
      });
    }
    throw error;
  }
}
