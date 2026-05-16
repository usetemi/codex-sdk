import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  AppServerClient,
  JsonLineDecoder,
  MessageRouter,
  encodeJsonRpcMessage,
} from "../src/transport";

type Fixture = {
  request: Record<string, unknown>;
  requestLine: string;
  chunks: string[];
  decodedMessages: Record<string, unknown>[];
  malformedLines: string[];
  router: {
    expectedResponseId: string;
    response: Record<string, unknown>;
    notification: Record<string, unknown>;
    orphanResponse: Record<string, unknown>;
  };
};

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../conformance/fixtures/transport_core.json"), "utf8"),
) as Fixture;

type ExpandedFixture = {
  framingCases: {
    chunks: string[];
    decodedMessages: Record<string, unknown>[];
    malformedLines: string[];
    pending: string;
  }[];
  router: {
    expectedResponseIds: (string | number)[];
    messages: Record<string, unknown>[];
    routes: { type: string; id?: string | number }[];
    notifications: Record<string, unknown>[];
  };
};

const expandedFixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../../conformance/fixtures/transport_expanded.json"),
    "utf8",
  ),
) as ExpandedFixture;

const fakeAppServer = join(import.meta.dirname, "../../conformance/fake_app_server.py");

test("encodes JSON-RPC messages as compact newline-delimited JSON", () => {
  assert.equal(encodeJsonRpcMessage(fixture.request), fixture.requestLine);
});

test("decodes complete, partial, notification, and malformed JSON lines", () => {
  const decoder = new JsonLineDecoder();
  const messages: Record<string, unknown>[] = [];
  const malformed: string[] = [];

  for (const chunk of fixture.chunks) {
    const decoded = decoder.feed(chunk);
    messages.push(...decoded.messages);
    malformed.push(...decoded.malformed.map((line) => line.raw));
  }

  assert.deepEqual(messages, fixture.decodedMessages);
  assert.deepEqual(malformed, fixture.malformedLines);
});

test("routes expected responses and preserves unknown notifications", () => {
  const router = new MessageRouter();
  router.expectResponse(fixture.router.expectedResponseId);

  assert.deepEqual(router.route(fixture.router.response), {
    type: "response",
    id: fixture.router.expectedResponseId,
    message: fixture.router.response,
  });

  assert.deepEqual(router.route(fixture.router.notification), {
    type: "notification",
    message: fixture.router.notification,
  });

  assert.deepEqual(router.route(fixture.router.orphanResponse), {
    type: "orphanResponse",
    id: "req-2",
    message: fixture.router.orphanResponse,
  });

  assert.deepEqual(router.notifications, [fixture.router.notification]);
});

test("decodes expanded shared framing cases", () => {
  for (const framingCase of expandedFixture.framingCases) {
    const decoder = new JsonLineDecoder();
    const messages: Record<string, unknown>[] = [];
    const malformed: string[] = [];

    for (const chunk of framingCase.chunks) {
      const decoded = decoder.feed(chunk);
      messages.push(...decoded.messages);
      malformed.push(...decoded.malformed.map((line) => line.raw));
    }

    assert.deepEqual(messages, framingCase.decodedMessages);
    assert.deepEqual(malformed, framingCase.malformedLines);
    assert.equal(decoder.pending, framingCase.pending);
  }
});

test("routes expanded shared message cases", () => {
  const router = new MessageRouter();
  for (const id of expandedFixture.router.expectedResponseIds) {
    router.expectResponse(id);
  }

  const routes = expandedFixture.router.messages.map((message) => router.route(message));
  assert.deepEqual(
    routes.map((route) => ({ type: route.type, id: "id" in route ? route.id : undefined })),
    expandedFixture.router.routes.map((route) => ({ type: route.type, id: route.id })),
  );
  assert.deepEqual(router.notifications, expandedFixture.router.notifications);
});

test("app-server client handles request responses and errors", async () => {
  const client = AppServerClient.start({ command: "python3", args: [fakeAppServer] });
  try {
    assert.deepEqual(await client.request("sdk/echo", { value: 42 }), { value: 42 });

    await assert.rejects(client.request("sdk/error", { retry: false }), /fake failure/);
  } finally {
    await client.close();
  }
});

test("app-server client sends and receives notifications", async () => {
  const client = AppServerClient.start({ command: "python3", args: [fakeAppServer] });
  try {
    await client.notify("sdk/client-notification", { from: "client" });
    assert.deepEqual(await client.nextEvent(), {
      type: "notification",
      message: {
        method: "fake/clientNotificationReceived",
        params: { from: "client" },
      },
    });

    assert.deepEqual(await client.request("sdk/notify-server", { from: "server" }), {
      notified: true,
    });
    assert.deepEqual(await client.nextEvent(), {
      type: "notification",
      message: {
        method: "fake/notification",
        params: { from: "server" },
      },
    });
  } finally {
    await client.close();
  }
});

test("app-server client surfaces server requests and client responses", async () => {
  const client = AppServerClient.start({ command: "python3", args: [fakeAppServer] });
  try {
    assert.deepEqual(await client.request("sdk/request-client", { question: "approve?" }), {
      requested: true,
    });
    const event = await client.nextEvent();
    assert.deepEqual(event, {
      type: "serverRequest",
      id: "server-1",
      message: {
        id: "server-1",
        method: "fake/serverRequest",
        params: { question: "approve?" },
      },
    });

    if (event.type !== "serverRequest") {
      throw new Error("expected server request");
    }
    await client.respond(event.id, { approved: true });
    assert.deepEqual(await client.nextEvent(), {
      type: "notification",
      message: {
        method: "fake/serverRequestResolved",
        params: { id: "server-1", result: { approved: true } },
      },
    });
  } finally {
    await client.close();
  }
});

test("app-server client surfaces malformed output and process exit", async () => {
  const client = AppServerClient.start({ command: "python3", args: [fakeAppServer] });
  try {
    assert.deepEqual(await client.request("sdk/malformed"), { malformed: true });
    assert.deepEqual(await client.nextEvent(), {
      type: "malformed",
      raw: "not-json",
    });

    await assert.rejects(client.request("sdk/exit"), /app-server closed/);
    assert.deepEqual(await client.nextEvent(), {
      type: "exit",
      code: 7,
      signal: null,
    });
    await client.close();
    await client.close();
  } finally {
    await client.close();
  }
});
