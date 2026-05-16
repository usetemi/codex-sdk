import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FakeAppServer } from "../../../packages/typescript/tests/support/openai-compat-fixture";
import {
  CodexAuthConflictError,
  type CodexAuthImportResult,
  type CodexAuthManager,
  type CodexAuthStatus,
  type CodexDeviceFlowSnapshot,
} from "../src/codex-auth.js";
import { parseCliConfig, type CliConfig } from "../src/config.js";
import {
  createCodexOpenAIProxyServer,
  openAICompatOptionsFromConfig,
  type ProxyServerOptions,
} from "../src/server.js";

test("GET /healthz does not initialize Codex", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startProxyFixture(t, fake);

  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.equal(assertRecord(await response.json()).status, "ok");
  assert.deepEqual(fake.requests, []);
});

test("GET /readyz initializes Codex and reports success", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startProxyFixture(t, fake);

  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 200);
  assert.equal(assertRecord(await response.json()).status, "ready");
  assert.equal(fake.requests[0]?.method, "initialize");
});

test("GET /readyz returns non-200 when Codex initialization fails", async (t) => {
  const fake = new FailingInitializeAppServer();
  const baseUrl = await startProxyFixture(t, fake);

  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  assert.equal(assertRecord(assertRecord(await response.json()).error).code, "not_ready");
  assert.equal(fake.requests[0]?.method, "initialize");
});

test("OpenAI-compatible routes work through the proxy wrapper", async (t) => {
  const fake = new FakeAppServer();
  fake.modelPages = [{ data: [{ id: "codex-mini" }], nextCursor: null }];
  fake.responseText = "proxy response";
  const baseUrl = await startProxyFixture(t, fake);

  const models = await fetch(`${baseUrl}/v1/models`);
  assert.equal(models.status, 200);
  assert.deepEqual(assertRecord(await models.json()).data, [
    { id: "codex-mini", object: "model", created: 0, owned_by: "codex" },
  ]);

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(chat.status, 200);
  const chatJson = assertRecord(await chat.json());
  assert.equal(assertRecord(assertArray(chatJson.choices)[0]).finish_reason, "stop");

  const responses = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "hello",
    }),
  });
  assert.equal(responses.status, 200);
  assert.equal(assertRecord(await responses.json()).output_text, "proxy response");
});

test("streaming routes work through the proxy wrapper", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = "hello";
  fake.streamDeltas = ["he", "llo"];
  const baseUrl = await startProxyFixture(t, fake);

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(chat.status, 200);
  const chatEvents = parseSse(await chat.text());
  assert.equal(chatEvents.at(-1)?.data, "[DONE]");

  const responses = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      stream: true,
      input: "hello",
    }),
  });
  assert.equal(responses.status, 200);
  assert.deepEqual(
    parseSse(await responses.text()).map((event) => event.event),
    [
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ],
  );
});

test("static bearer tokens accept valid tokens and reject missing or invalid tokens", async (t) => {
  const fake = new FakeAppServer();
  const config = parseCliConfig(["--api-key", "good-token"], {});
  const baseUrl = await startProxyFixture(t, fake, config);

  const missing = await fetch(`${baseUrl}/v1/models`);
  assert.equal(missing.status, 401);

  const invalid = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: "Bearer bad-token" },
  });
  assert.equal(invalid.status, 401);
  assert.deepEqual(fake.requests, []);

  const valid = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(valid.status, 200);
  assert.equal(fake.requests[0]?.method, "initialize");
});

test("explicit disabled auth permits unauthenticated non-loopback configuration", async (t) => {
  const fake = new FakeAppServer();
  const config = parseCliConfig(["--host", "0.0.0.0", "--auth", "disabled"], {});
  const baseUrl = await startProxyFixture(t, fake, config);

  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
});

test("GET /auth.md is public markdown guidance", async (t) => {
  const fake = new FakeAppServer();
  const config = parseCliConfig(["--api-key", "good-token"], {});
  const baseUrl = await startProxyFixture(t, fake, config);

  const response = await fetch(`${baseUrl}/auth.md`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/markdown/);
  assert.match(await response.text(), /auth\/device/);
});

test("auth management endpoints use proxy bearer auth", async (t) => {
  const fake = new FakeAppServer();
  const authManager = new FakeAuthManager();
  const config = parseCliConfig(["--api-key", "good-token"], {});
  const baseUrl = await startProxyFixture(t, fake, config, { authManager });

  const missing = await fetch(`${baseUrl}/auth/status`);
  assert.equal(missing.status, 401);

  const invalid = await fetch(`${baseUrl}/auth/status`, {
    headers: { authorization: "Bearer bad-token" },
  });
  assert.equal(invalid.status, 401);

  const valid = await fetch(`${baseUrl}/auth/status`, {
    headers: { authorization: "Bearer good-token" },
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    authenticated: false,
    message: "Not logged in",
  });
});

test("device auth flow starts, polls, cancels, and rejects concurrent starts", async (t) => {
  const fake = new FakeAppServer();
  const authManager = new FakeAuthManager();
  const config = parseCliConfig(["--api-key", "good-token"], {});
  const baseUrl = await startProxyFixture(t, fake, config, { authManager });
  const headers = { authorization: "Bearer good-token" };

  const started = await fetch(`${baseUrl}/auth/device`, { method: "POST", headers });
  assert.equal(started.status, 202);
  const startJson = assertRecord(await started.json());
  assert.equal(startJson.status, "pending");
  assert.equal(startJson.verification_uri, "https://auth.openai.com/codex/device");

  authManager.conflictOnStart = true;
  const conflict = await fetch(`${baseUrl}/auth/device`, { method: "POST", headers });
  assert.equal(conflict.status, 409);

  const flowId = String(startJson.flow_id);
  const polled = await fetch(`${baseUrl}/auth/device/${flowId}`, { headers });
  assert.equal(polled.status, 200);
  assert.equal(assertRecord(await polled.json()).user_code, "ABCD-EFGH");

  const cancelled = await fetch(`${baseUrl}/auth/device/${flowId}/cancel`, {
    method: "POST",
    headers,
  });
  assert.equal(cancelled.status, 200);
  assert.equal(assertRecord(await cancelled.json()).status, "cancelled");
});

test("auth import rejects invalid JSON", async (t) => {
  const fake = new FakeAppServer();
  const config = parseCliConfig(["--api-key", "good-token"], {});
  const baseUrl = await startProxyFixture(t, fake, config);

  const response = await fetch(`${baseUrl}/auth/import`, {
    method: "POST",
    headers: {
      authorization: "Bearer good-token",
      "content-type": "application/json",
    },
    body: "{",
  });
  assert.equal(response.status, 400);
});

test("auth import writes managed auth JSON and restarts Codex app-server", async (t) => {
  const first = new CloseCountingFakeAppServer();
  const second = new CloseCountingFakeAppServer();
  const fakes = [first, second];
  let fakeIndex = 0;
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-proxy-auth-"));
  t.after(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
  });
  const config = parseCliConfig(["--api-key", "good-token", "--codex-home", codexHome], {});
  const baseUrl = await startProxyFixture(t, first, config, {
    compat: () => ({ client: fakes[fakeIndex++] ?? new CloseCountingFakeAppServer() }),
  });
  const headers = { authorization: "Bearer good-token" };

  const before = await fetch(`${baseUrl}/v1/models`, { headers });
  assert.equal(before.status, 200);
  assert.equal(first.requests[0]?.method, "initialize");

  const imported = await fetch(`${baseUrl}/auth/import`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({ OPENAI_API_KEY: "secret", refresh_token: "refresh" }),
  });
  assert.equal(imported.status, 200);
  assert.equal(assertRecord(await imported.json()).restarted_codex, true);
  assert.equal(first.closeCount, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(codexHome, "auth.json"), "utf8")), {
    OPENAI_API_KEY: "secret",
    refresh_token: "refresh",
  });

  const after = await fetch(`${baseUrl}/v1/models`, { headers });
  assert.equal(after.status, 200);
  assert.equal(second.requests[0]?.method, "initialize");
});

test("Codex subprocess env passes Codex auth but not proxy client tokens", () => {
  const previousProxyKeys = process.env.CODEX_OPENAI_PROXY_API_KEYS;
  process.env.CODEX_OPENAI_PROXY_API_KEYS = "proxy-secret";
  try {
    const config = parseCliConfig(
      [
        "--api-key",
        "client-token",
        "--codex-home",
        "/tmp/codex-home",
        "--codex-api-key",
        "codex-key",
      ],
      {},
    );
    const env = openAICompatOptionsFromConfig(config).appServer?.env ?? {};

    assert.equal(env.CODEX_OPENAI_PROXY_API_KEYS, undefined);
    assert.equal(env.CODEX_HOME, "/tmp/codex-home");
    assert.equal(env.CODEX_API_KEY, "codex-key");
  } finally {
    if (previousProxyKeys === undefined) {
      delete process.env.CODEX_OPENAI_PROXY_API_KEYS;
    } else {
      process.env.CODEX_OPENAI_PROXY_API_KEYS = previousProxyKeys;
    }
  }
});

async function startProxyFixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  fake: FakeAppServer,
  config: CliConfig = parseCliConfig([], {}),
  options: ProxyServerOptions = {},
): Promise<string> {
  const server = createCodexOpenAIProxyServer(config, {
    compat: { client: fake },
    ...options,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await closeServer(server);
    await fake.close();
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return `http://127.0.0.1:${address.port}`;
}

class FailingInitializeAppServer extends FakeAppServer {
  override async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    throw new Error("initialize failed");
  }
}

class CloseCountingFakeAppServer extends FakeAppServer {
  closeCount = 0;

  override async close(): Promise<void> {
    this.closeCount += 1;
    await super.close();
  }
}

class FakeAuthManager implements CodexAuthManager {
  conflictOnStart = false;
  #flow = {
    flow_id: "flow-1",
    status: "pending" as const,
    started_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    verification_uri: "https://auth.openai.com/codex/device",
    user_code: "ABCD-EFGH",
    expires_at: new Date(15 * 60_000).toISOString(),
    message: "Open the verification URL and enter the device code",
    output_lines: ["Open https://auth.openai.com/codex/device", "Enter ABCD-EFGH"],
  };

  async status(): Promise<CodexAuthStatus> {
    return {
      authenticated: false,
      message: "Not logged in",
    };
  }

  async startDeviceFlow(): Promise<CodexDeviceFlowSnapshot> {
    if (this.conflictOnStart) {
      throw new CodexAuthConflictError("A Codex device login flow is already active");
    }
    return { ...this.#flow, output_lines: [...this.#flow.output_lines] };
  }

  async getDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined> {
    if (flowId !== this.#flow.flow_id) {
      return undefined;
    }
    return { ...this.#flow, output_lines: [...this.#flow.output_lines] };
  }

  async cancelDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined> {
    if (flowId !== this.#flow.flow_id) {
      return undefined;
    }
    return {
      ...this.#flow,
      status: "cancelled",
      message: "Device login flow cancelled",
      output_lines: [...this.#flow.output_lines],
    };
  }

  async importAuthJson(_rawJson: string): Promise<CodexAuthImportResult> {
    return {
      status: "imported",
      restarted_codex: true,
    };
  }

  async close(): Promise<void> {}
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function parseSse(text: string): { event: string | null; data: string }[] {
  return text
    .trim()
    .split(/\n\n/)
    .filter(Boolean)
    .map((block) => {
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
          data.push(line.slice("data: ".length));
        }
      }

      return {
        event,
        data: data.join("\n"),
      };
    });
}

function assertRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

function assertArray(value: unknown): unknown[] {
  assert.equal(Array.isArray(value), true);
  return value as unknown[];
}
