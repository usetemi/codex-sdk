import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";

import { createOpenAICompatServer, type OpenAICompatOptions } from "../../src/openai-compat";
import type { AppServerEvent, JsonRpcErrorBody } from "../../src/transport";

export type RequestRecord = {
  method: string;
  params: unknown;
};

export type TokenUsage = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export const defaultUsage: TokenUsage = {
  totalTokens: 8,
  inputTokens: 5,
  cachedInputTokens: 2,
  outputTokens: 3,
  reasoningOutputTokens: 1,
};

export class FakeAppServer {
  readonly requests: RequestRecord[] = [];
  readonly imagePathsSeenDuringTurn: string[] = [];
  modelPages: { data: Record<string, unknown>[]; nextCursor: string | null }[] = [
    {
      data: [{ id: "codex-mini" }],
      nextCursor: null,
    },
  ];
  responseText = "hello";
  responseTexts: string[] = [];
  streamDeltas: string[] = [];
  streamDeltasByTurn: string[][] = [];
  usage: TokenUsage = defaultUsage;
  #events: AppServerEvent[] = [];
  #waiters: ((result: IteratorResult<AppServerEvent>) => void)[] = [];
  #closed = false;
  #threadCounter = 0;
  #turnCounter = 0;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });

    if (method === "initialize") {
      return {
        userAgent: "fake-codex",
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      };
    }

    if (method === "model/list") {
      const cursor = recordParam(params, "cursor");
      const index = typeof cursor === "string" ? Number.parseInt(cursor, 10) : 0;
      return this.modelPages[index] ?? { data: [], nextCursor: null };
    }

    if (method === "thread/start") {
      const threadId = `thread-${++this.#threadCounter}`;
      return {
        thread: {
          id: threadId,
          ephemeral: true,
        },
        model: recordParam(params, "model") ?? "codex-mini",
      };
    }

    if (method === "turn/start") {
      const record = assertRecord(params);
      const threadId = String(record.threadId);
      const turnId = `turn-${++this.#turnCounter}`;
      const input = Array.isArray(record.input) ? record.input : [];
      for (const item of input) {
        if (assertRecord(item).type === "localImage") {
          const imagePath = String(assertRecord(item).path);
          assert.equal(existsSync(imagePath), true);
          this.imagePathsSeenDuringTurn.push(imagePath);
        }
      }

      queueMicrotask(() => {
        const responseText = this.responseTexts.shift() ?? this.responseText;
        const streamDeltas = this.streamDeltasByTurn.shift() ?? this.streamDeltas;
        this.#emitTurnEvents(threadId, turnId, responseText, streamDeltas);
      });

      return {
        turn: {
          id: turnId,
          status: "inProgress",
          items: [],
          error: null,
        },
      };
    }

    if (method === "turn/interrupt") {
      return {};
    }

    throw new Error(`Unexpected fake app-server method: ${method}`);
  }

  async respond(_id: string | number, _result: unknown): Promise<void> {}

  async respondError(_id: string | number, _error: JsonRpcErrorBody): Promise<void> {}

  events(): AsyncIterable<AppServerEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this.#nextEvent(),
      }),
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter({ done: true, value: undefined });
    }
  }

  #emitTurnEvents(
    threadId: string,
    turnId: string,
    responseText: string,
    streamDeltas: string[],
  ): void {
    this.#emitNotification("turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [], error: null },
    });
    for (const delta of streamDeltas) {
      this.#emitNotification("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "item-1",
        delta,
      });
    }
    this.#emitNotification("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        total: this.usage,
        last: this.usage,
        modelContextWindow: null,
      },
    });
    const item = {
      type: "agentMessage",
      id: "item-1",
      text: responseText,
      phase: null,
      memoryCitation: null,
    };
    this.#emitNotification("item/completed", {
      threadId,
      turnId,
      item,
      completedAtMs: Date.now(),
    });
    this.#emitNotification("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status: "completed",
        items: [item],
        error: null,
      },
    });
  }

  #emitNotification(method: string, params: Record<string, unknown>): void {
    this.#emit({
      type: "notification",
      message: {
        method,
        params,
      },
    });
  }

  #emit(event: AppServerEvent): void {
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: event });
      return;
    }

    this.#events.push(event);
  }

  #nextEvent(): Promise<IteratorResult<AppServerEvent>> {
    const event = this.#events.shift();
    if (event) {
      return Promise.resolve({ done: false, value: event });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }

    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

export async function startOpenAICompatFixtureServer(
  t: { after: (fn: () => void | Promise<void>) => void },
  fake: FakeAppServer,
  options: Omit<OpenAICompatOptions, "client"> = {},
): Promise<string> {
  const server = createOpenAICompatServer({ ...options, client: fake });
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

export async function startImageServer(t: {
  after: (fn: () => void | Promise<void>) => void;
}): Promise<string> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(Buffer.from("remote-png"));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await closeServer(server);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return `http://127.0.0.1:${address.port}`;
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
