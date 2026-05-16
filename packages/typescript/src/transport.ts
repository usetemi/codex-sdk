import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonRpcMessage = Record<string, unknown>;

export type MalformedJsonLine = {
  raw: string;
  error: unknown;
};

export type DecodedJsonLines = {
  messages: JsonRpcMessage[];
  malformed: MalformedJsonLine[];
};

export function encodeJsonRpcMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export class JsonLineDecoder {
  #pending = "";

  feed(chunk: string | Buffer): DecodedJsonLines {
    const combined = this.#pending + chunk.toString();
    const parts = combined.split("\n");
    this.#pending = parts.pop() ?? "";

    const messages: JsonRpcMessage[] = [];
    const malformed: MalformedJsonLine[] = [];

    for (const part of parts) {
      const raw = part.endsWith("\r") ? part.slice(0, -1) : part;
      if (raw === "") {
        continue;
      }

      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          messages.push(parsed as JsonRpcMessage);
        } else {
          malformed.push({ raw, error: new Error("JSON-RPC line must decode to an object") });
        }
      } catch (error) {
        malformed.push({ raw, error });
      }
    }

    return { messages, malformed };
  }

  get pending(): string {
    return this.#pending;
  }
}

export type RoutedMessage =
  | {
      type: "response";
      id: string | number;
      message: JsonRpcMessage;
    }
  | {
      type: "errorResponse";
      id: string | number;
      message: JsonRpcMessage;
    }
  | {
      type: "serverRequest";
      id: string | number;
      message: JsonRpcMessage;
    }
  | {
      type: "orphanResponse";
      id: string | number;
      message: JsonRpcMessage;
    }
  | {
      type: "notification";
      message: JsonRpcMessage;
    }
  | {
      type: "unknown";
      message: JsonRpcMessage;
    };

export class MessageRouter {
  #expectedResponseIds = new Set<string | number>();
  #notifications: JsonRpcMessage[] = [];

  expectResponse(id: string | number): void {
    this.#expectedResponseIds.add(id);
  }

  route(message: JsonRpcMessage): RoutedMessage {
    const id = message.id;

    if (typeof id === "string" || typeof id === "number") {
      if (typeof message.method === "string") {
        return { type: "serverRequest", id, message };
      }

      if (this.#expectedResponseIds.delete(id)) {
        if (message.error && typeof message.error === "object") {
          return { type: "errorResponse", id, message };
        }

        return { type: "response", id, message };
      }

      return { type: "orphanResponse", id, message };
    }

    if (typeof message.method === "string") {
      this.#notifications.push(message);
      return { type: "notification", message };
    }

    return { type: "unknown", message };
  }

  get notifications(): JsonRpcMessage[] {
    return [...this.#notifications];
  }
}

export type AppServerClientOptions = {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type JsonRpcErrorBody = {
  code: number;
  message: string;
  data?: unknown;
};

export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: JsonRpcErrorBody) {
    super(error.message);
    this.name = "JsonRpcResponseError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerClosedError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(code: number | null, signal: NodeJS.Signals | null) {
    super(`app-server closed with code ${code ?? "null"}`);
    this.name = "AppServerClosedError";
    this.code = code;
    this.signal = signal;
  }
}

export type AppServerEvent =
  | {
      type: "notification";
      message: JsonRpcMessage;
    }
  | {
      type: "serverRequest";
      id: string | number;
      message: JsonRpcMessage;
    }
  | {
      type: "malformed";
      raw: string;
    }
  | {
      type: "unknown";
      message: JsonRpcMessage;
    }
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
    };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export class AppServerClient {
  #process: ChildProcessWithoutNullStreams;
  #decoder = new JsonLineDecoder();
  #router = new MessageRouter();
  #pending = new Map<string | number, PendingRequest>();
  #events: AppServerEvent[] = [];
  #eventWaiters: ((event: AppServerEvent) => void)[] = [];
  #requestCounter = 0;
  #closed = false;
  #exitPromise: Promise<void>;
  #resolveExit!: () => void;

  private constructor(process: ChildProcessWithoutNullStreams) {
    this.#process = process;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    process.stdout.on("data", (chunk: Buffer) => this.#handleStdout(chunk));
    process.on("error", (error) => this.#handleProcessError(error));
    process.on("exit", (code, signal) => this.#handleExit(code, signal));
  }

  static start(options: AppServerClientOptions = {}): AppServerClient {
    const command = options.command ?? "codex";
    const args = options.args ?? ["app-server", "--listen", "stdio://"];
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
    });

    return new AppServerClient(child);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = `req-${++this.#requestCounter}`;
    this.#router.expectResponse(id);

    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });

    this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    return promise;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    this.#write({ id, result });
  }

  async respondError(id: string | number, error: JsonRpcErrorBody): Promise<void> {
    this.#write({ id, error });
  }

  nextEvent(): Promise<AppServerEvent> {
    const event = this.#events.shift();
    if (event) {
      return Promise.resolve(event);
    }

    return new Promise((resolve) => {
      this.#eventWaiters.push(resolve);
    });
  }

  events(): AsyncIterable<AppServerEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<AppServerEvent>> => {
          if (this.#closed && this.#events.length === 0) {
            return { done: true, value: undefined };
          }

          return { done: false, value: await this.nextEvent() };
        },
      }),
    };
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#process.stdin.end();
      this.#process.kill();
    }

    await this.#exitPromise;
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closed) {
      throw new AppServerClosedError(null, null);
    }

    this.#process.stdin.write(encodeJsonRpcMessage(message));
  }

  #handleStdout(chunk: Buffer): void {
    const decoded = this.#decoder.feed(chunk);
    for (const malformed of decoded.malformed) {
      this.#pushEvent({ type: "malformed", raw: malformed.raw });
    }

    for (const message of decoded.messages) {
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: JsonRpcMessage): void {
    const routed = this.#router.route(message);
    switch (routed.type) {
      case "response": {
        const pending = this.#pending.get(routed.id);
        this.#pending.delete(routed.id);
        pending?.resolve(message.result);
        break;
      }
      case "errorResponse": {
        const pending = this.#pending.get(routed.id);
        this.#pending.delete(routed.id);
        pending?.reject(new JsonRpcResponseError(normalizeJsonRpcError(message.error)));
        break;
      }
      case "serverRequest":
        this.#pushEvent({ type: "serverRequest", id: routed.id, message });
        break;
      case "notification":
        this.#pushEvent({ type: "notification", message });
        break;
      case "unknown":
        this.#pushEvent({ type: "unknown", message });
        break;
      case "orphanResponse":
        this.#pushEvent({ type: "unknown", message });
        break;
    }
  }

  #handleProcessError(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    const error = new AppServerClosedError(code, signal);
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#pushEvent({ type: "exit", code, signal });
    this.#resolveExit();
  }

  #pushEvent(event: AppServerEvent): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.#events.push(event);
  }
}

function normalizeJsonRpcError(error: unknown): JsonRpcErrorBody {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: typeof record.code === "number" ? record.code : -32000,
      message: typeof record.message === "string" ? record.message : "JSON-RPC error",
      data: record.data,
    };
  }

  return { code: -32000, message: "JSON-RPC error", data: error };
}
