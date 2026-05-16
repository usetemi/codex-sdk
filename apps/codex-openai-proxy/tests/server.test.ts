import assert from "node:assert/strict";
import { type Server } from "node:http";
import test from "node:test";

import { FakeAppServer } from "../../../packages/typescript/tests/support/openai-compat-fixture";
import { parseCliConfig, type CliConfig } from "../src/config.js";
import { createCodexOpenAIProxyServer, openAICompatOptionsFromConfig } from "../src/server.js";

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
): Promise<string> {
  const server = createCodexOpenAIProxyServer(config, { compat: { client: fake } });
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
