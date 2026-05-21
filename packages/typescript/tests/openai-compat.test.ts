import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenAICompatServer } from "../src/openai-compat";
import {
  FakeAppServer,
  startImageServer,
  startOpenAICompatFixtureServer,
} from "./support/openai-compat-fixture";

test("GET /v1/models initializes app-server and maps model list pages", async (t) => {
  const fake = new FakeAppServer();
  fake.modelPages = [
    { data: [{ id: "codex-a" }], nextCursor: "1" },
    { data: [{ id: "codex-b", model: "gpt-5.1-codex" }], nextCursor: null },
  ];
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    object: "list",
    data: [
      { id: "codex-a", object: "model", created: 0, owned_by: "codex" },
      { id: "codex-b", object: "model", created: 0, owned_by: "codex" },
    ],
  });
  assert.equal(fake.requests[0]?.method, "initialize");
  assert.deepEqual(recordParam(fake.requests[0]?.params, "capabilities"), {
    experimentalApi: true,
  });
  assert.deepEqual(
    fake.requests
      .filter((request) => request.method === "model/list")
      .map((request) => request.params),
    [{}, { cursor: "1" }],
  );
});

test("optional bearer auth returns OpenAI-style 401 errors", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startOpenAICompatFixtureServer(t, fake, { bearerToken: "local-token" });

  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      message: "Missing or invalid bearer token",
      type: "invalid_request_error",
      param: null,
      code: null,
    },
  });
});

test("POST /v1/chat/completions maps text, images, usage, and runtime options", async (t) => {
  const fake = new FakeAppServer();
  const imageServer = await startImageServer(t);
  const baseUrl = await startOpenAICompatFixtureServer(t, fake, {
    cwd: "/tmp/project",
    modelProvider: "openai",
    sandbox: "read-only",
    approvalPolicy: "never",
  });

  const dataUrl = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      messages: [
        { role: "system", content: "Be precise." },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe these." },
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "image_url", image_url: { url: `${imageServer}/remote.png` } },
          ],
        },
        { role: "assistant", content: "Prior answer." },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const json = assertRecord(await response.json());
  assert.equal(json.object, "chat.completion");
  assert.equal(json.model, "codex-mini");
  assert.deepEqual(json.usage, {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
  const choice = assertRecord(assertArray(json.choices)[0]);
  assert.equal(assertRecord(choice.message).content, "hello");

  const threadStart = fake.requests.find((request) => request.method === "thread/start");
  assert.deepEqual(threadStart?.params, {
    model: "codex-mini",
    modelProvider: "openai",
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "openai-compat",
    ephemeral: true,
    threadSource: "user",
  });

  const turnStart = assertRecord(
    fake.requests.find((request) => request.method === "turn/start")?.params,
  );
  const input = assertArray(turnStart.input);
  assert.equal(assertRecord(input[0]).text, "[system]\nBe precise.");
  assert.equal(assertRecord(input[1]).text, "[user]\nDescribe these.");
  assert.equal(assertRecord(input[2]).type, "localImage");
  assert.equal(assertRecord(input[3]).type, "localImage");
  assert.equal(assertRecord(input[4]).text, "[assistant]\nPrior answer.");
  assert.equal(fake.imagePathsSeenDuringTurn.length, 2);
  for (const imagePath of fake.imagePathsSeenDuringTurn) {
    assert.equal(existsSync(imagePath), false);
  }
});

test("POST /v1/responses maps instructions, input array, images, and output_text", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = "response text";
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);
  const dataUrl = `data:image/png;base64,${Buffer.from("webp").toString("base64")}`;

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      instructions: "Use short sentences.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "What is in the image?" },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      store: false,
    }),
  });

  assert.equal(response.status, 200);
  const json = assertRecord(await response.json());
  assert.equal(json.object, "response");
  assert.equal(json.output_text, "response text");
  assert.deepEqual(json.usage, {
    input_tokens: 5,
    output_tokens: 3,
    total_tokens: 8,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  });

  const turnStart = assertRecord(
    fake.requests.find((request) => request.method === "turn/start")?.params,
  );
  const input = assertArray(turnStart.input);
  assert.equal(assertRecord(input[0]).text, "[instructions]\nUse short sentences.");
  assert.equal(assertRecord(input[1]).text, "[user]\nWhat is in the image?");
  assert.equal(assertRecord(input[2]).type, "localImage");
});

test("POST /v1/responses accepts Agents SDK default no-tool fields", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = "no tools";
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "hello",
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      text: { format: { type: "text" } },
      include: [],
      store: false,
      previous_response_id: null,
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(assertRecord(await response.json()).output_text, "no tools");
});

test("POST /v1/responses recreates app-server after subprocess exit", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "codex-openai-compat-restart-"));
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const markerPath = join(tempDir, "first-turn-exited");
  const scriptPath = join(tempDir, "fake-app-server.cjs");
  await writeFile(
    scriptPath,
    `
const fs = require("node:fs");
const readline = require("node:readline");

const markerPath = process.env.CODEX_FAKE_MARKER;
const lineReader = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function tokenUsage() {
  return {
    totalTokens: 2,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
  };
}

lineReader.on("line", (line) => {
  const message = JSON.parse(line);
  const requestId = message.id;

  if (message.method === "initialize") {
    send({
      id: requestId,
      result: {
        userAgent: "fake-codex",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    send({
      id: requestId,
      result: {
        thread: { id: "thread-1", ephemeral: true },
        model: "codex-mini",
      },
    });
    return;
  }

  if (message.method === "turn/start") {
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, "1");
      process.exit(0);
    }

    const threadId = message.params.threadId;
    const turnId = "turn-1";
    const item = {
      type: "agentMessage",
      id: "item-1",
      text: "recovered",
      phase: null,
      memoryCitation: null,
    };
    send({
      id: requestId,
      result: { turn: { id: turnId, status: "inProgress", items: [], error: null } },
    });
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } },
    });
    send({
      method: "thread/tokenUsage/updated",
      params: {
        threadId,
        turnId,
        tokenUsage: { total: tokenUsage(), last: tokenUsage(), modelContextWindow: null },
      },
    });
    send({
      method: "item/completed",
      params: { threadId, turnId, item, completedAtMs: Date.now() },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: turnId, status: "completed", items: [item], error: null },
      },
    });
    return;
  }

  send({
    id: requestId,
    error: { code: -32000, message: "unexpected method " + message.method },
  });
});
`,
  );

  const server = createOpenAICompatServer({
    appServer: {
      command: process.execPath,
      args: [scriptPath],
      env: { ...process.env, CODEX_FAKE_MARKER: markerPath },
    },
  });
  await listenServer(server);
  t.after(async () => {
    await closeServer(server);
  });

  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const requestBody = {
    model: "codex-mini",
    input: "hello",
    store: false,
  };

  const failedResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  assert.equal(failedResponse.status, 500);
  assert.match(JSON.stringify(await failedResponse.json()), /app-server closed/);

  const recoveredResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  assert.equal(recoveredResponse.status, 200);
  assert.equal(assertRecord(await recoveredResponse.json()).output_text, "recovered");
});

test("POST /v1/responses returns function_call items for local function tools", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = toolEnvelope("get_weather", { city: "Tokyo" });
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "Weather in Tokyo?",
      tools: [weatherTool()],
      tool_choice: "auto",
      parallel_tool_calls: true,
    }),
  });

  assert.equal(response.status, 200);
  const json = assertRecord(await response.json());
  assert.equal(json.output_text, "");
  const output = assertArray(json.output);
  const call = assertRecord(output[0]);
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "get_weather");
  assert.equal(call.status, "completed");
  assert.equal(call.arguments, JSON.stringify({ city: "Tokyo" }));

  const turnStart = assertRecord(
    fake.requests.find((request) => request.method === "turn/start")?.params,
  );
  assert.match(String(assertRecord(assertArray(turnStart.input)[0]).text), /openai_compat_tools/);
});

test("POST /v1/responses continues a proxy response with function_call_output", async (t) => {
  const fake = new FakeAppServer();
  fake.responseTexts = [toolEnvelope("get_weather", { city: "Tokyo" }), "Tokyo is sunny."];
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const first = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "Weather in Tokyo?",
      tools: [weatherTool()],
    }),
  });
  assert.equal(first.status, 200);
  const firstJson = assertRecord(await first.json());
  const call = assertRecord(assertArray(firstJson.output)[0]);

  const second = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      previous_response_id: firstJson.id,
      input: [
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "sunny",
        },
      ],
      tools: [weatherTool()],
    }),
  });

  assert.equal(second.status, 200);
  assert.equal(assertRecord(await second.json()).output_text, "Tokyo is sunny.");
  const turnStarts = fake.requests.filter((request) => request.method === "turn/start");
  assert.equal(fake.requests.filter((request) => request.method === "thread/start").length, 1);
  assert.equal(
    recordParam(turnStarts[0]?.params, "threadId"),
    recordParam(turnStarts[1]?.params, "threadId"),
  );
  const followUpInput = assertArray(assertRecord(turnStarts[1]?.params).input);
  assert.match(String(assertRecord(followUpInput.at(-1)).text), /sunny/);
});

test("POST /v1/responses returns OpenAI-style 404 for unknown previous_response_id", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "hello",
      previous_response_id: "resp_missing",
    }),
  });

  assert.equal(response.status, 404);
  const error = assertRecord(assertRecord(await response.json()).error);
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.param, "previous_response_id");
  assert.equal(error.code, "not_found");
});

test("POST /v1/responses rejects hosted and non-function tools", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "search",
      tools: [{ type: "web_search" }],
    }),
  });

  assert.equal(response.status, 501);
  const error = assertRecord(assertRecord(await response.json()).error);
  assert.equal(error.type, "unsupported_feature");
  assert.equal(error.param, "tools.0.type");
});

test("POST /v1/chat/completions returns tool_calls for function tools", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = toolEnvelope("get_weather", { city: "Tokyo" });
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      messages: [{ role: "user", content: "Weather in Tokyo?" }],
      tools: [{ type: "function", function: weatherTool() }],
    }),
  });

  assert.equal(response.status, 200);
  const choice = assertRecord(assertArray(assertRecord(await response.json()).choices)[0]);
  assert.equal(choice.finish_reason, "tool_calls");
  const message = assertRecord(choice.message);
  const toolCall = assertRecord(assertArray(message.tool_calls)[0]);
  assert.equal(toolCall.type, "function");
  assert.equal(assertRecord(toolCall.function).name, "get_weather");
});

test("unsupported OpenAI-compatible fields return 501 error JSON", async (t) => {
  const fake = new FakeAppServer();
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      n: 2,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(chat.status, 501);
  assert.deepEqual(await chat.json(), {
    error: {
      message: "n > 1 is not supported",
      type: "unsupported_feature",
      param: "n",
      code: "unsupported",
    },
  });

  const responses = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      input: "hello",
      background: true,
    }),
  });
  assert.equal(responses.status, 501);
  assert.equal(assertRecord(assertRecord(await responses.json()).error).param, "background");
});

test("chat streaming emits role chunk, deltas, final usage chunk, and DONE", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = "hello";
  fake.streamDeltas = ["he", "llo"];
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  assert.equal(events.at(-1)?.data, "[DONE]");
  const chunks = events
    .slice(0, -1)
    .map((event) => JSON.parse(event.data) as Record<string, unknown>);
  assert.equal(
    assertRecord(assertRecord(assertArray(chunks[0].choices)[0]).delta).role,
    "assistant",
  );
  assert.equal(assertRecord(assertRecord(assertArray(chunks[1].choices)[0]).delta).content, "he");
  assert.equal(assertRecord(assertRecord(assertArray(chunks[2].choices)[0]).delta).content, "llo");
  const finalChoice = assertRecord(assertArray(chunks[3].choices)[0]);
  assert.equal(finalChoice.finish_reason, "stop");
  assert.deepEqual(chunks[3].usage, {
    prompt_tokens: 5,
    completion_tokens: 3,
    total_tokens: 8,
    prompt_tokens_details: { cached_tokens: 2 },
    completion_tokens_details: { reasoning_tokens: 1 },
  });
});

test("responses streaming emits Responses API event order", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = "hello";
  fake.streamDeltas = ["hel", "lo"];
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      stream: true,
      input: "hello",
    }),
  });

  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "response.created",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.completed",
    ],
  );
  assert.equal(JSON.parse(events[1].data).delta, "hel");
  assert.equal(JSON.parse(events[2].data).delta, "lo");
  assert.equal(JSON.parse(events[3].data).text, "hello");
  assert.equal(JSON.parse(events[4].data).response.output_text, "hello");
});

test("responses streaming emits function_call events and final response output", async (t) => {
  const fake = new FakeAppServer();
  fake.responseText = toolEnvelope("get_weather", { city: "Tokyo" });
  const baseUrl = await startOpenAICompatFixtureServer(t, fake);

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-mini",
      stream: true,
      input: "Weather in Tokyo?",
      tools: [weatherTool()],
    }),
  });

  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ],
  );
  const done = assertRecord(JSON.parse(events[3].data));
  assert.equal(done.name, "get_weather");
  assert.equal(done.arguments, JSON.stringify({ city: "Tokyo" }));
  const completed = assertRecord(JSON.parse(events[5].data));
  const output = assertArray(assertRecord(completed.response).output);
  assert.equal(assertRecord(output[0]).type, "function_call");
});

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

function weatherTool(): Record<string, unknown> {
  return {
    type: "function",
    name: "get_weather",
    description: "Get the weather for a city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    },
    strict: true,
  };
}

function toolEnvelope(name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: "function_call",
    name,
    arguments: args,
  });
}

function recordParam(params: unknown, key: string): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  return (params as Record<string, unknown>)[key];
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

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
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
