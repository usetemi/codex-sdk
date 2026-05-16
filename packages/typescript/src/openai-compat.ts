import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  AppServerClient,
  JsonRpcResponseError,
  type AppServerClientOptions,
  type AppServerEvent,
  type JsonRpcErrorBody,
} from "./transport.js";

type JsonRecord = Record<string, unknown>;

type AppServerProtocolClient = {
  request(method: string, params?: unknown): Promise<unknown>;
  respond?(id: string | number, result: unknown): Promise<void>;
  respondError?(id: string | number, error: JsonRpcErrorBody): Promise<void>;
  events?(): AsyncIterable<AppServerEvent>;
  close?(): Promise<void>;
};

type CodexUserInput =
  | {
      type: "text";
      text: string;
      text_elements: [];
    }
  | {
      type: "localImage";
      path: string;
    };

type CodexThreadStartResponse = {
  thread: {
    id: string;
  };
  model?: string;
};

type CodexTurn = {
  id: string;
  status?: string;
  error?: {
    message?: string;
  } | null;
  items?: unknown[];
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type CompletedTurn = {
  text: string;
  usage: TokenUsageBreakdown | null;
};

export type OpenAICompatOptions = {
  /**
   * App-server process configuration. Defaults to
   * `codex app-server --listen stdio://`.
   */
  appServer?: AppServerClientOptions;
  /**
   * Injected app-server client for tests or custom transports.
   */
  client?: AppServerProtocolClient;
  cwd?: string;
  modelProvider?: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?:
    | "untrusted"
    | "on-failure"
    | "on-request"
    | "never"
    | {
        granular: {
          sandbox_approval: boolean;
          rules: boolean;
          skill_approval: boolean;
          request_permissions: boolean;
          mcp_elicitations: boolean;
        };
      };
  config?: JsonRecord;
  bearerToken?: string;
  imageTempDir?: string;
};

export type OpenAICompatHandler = {
  (req: IncomingMessage, res: ServerResponse): void;
  ready(): Promise<void>;
  close(): Promise<void>;
};

class OpenAICompatHttpError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "OpenAICompatHttpError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}

class ImageTempFiles {
  readonly #parentDir: string;
  #dir: string | null = null;

  constructor(parentDir: string | undefined) {
    this.#parentDir = parentDir ?? os.tmpdir();
  }

  async write(buffer: Buffer, extension: string): Promise<string> {
    const dir = await this.#ensureDir();
    const safeExtension = extension.match(/^\.[a-z0-9]+$/i) ? extension : ".bin";
    const filePath = path.join(dir, `${randomUUID()}${safeExtension}`);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  async cleanup(): Promise<void> {
    if (!this.#dir) {
      return;
    }

    try {
      await fs.rm(this.#dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for request-scoped image files.
    }
  }

  async #ensureDir(): Promise<string> {
    if (this.#dir) {
      return this.#dir;
    }

    this.#dir = await fs.mkdtemp(path.join(this.#parentDir, "codex-openai-images-"));
    return this.#dir;
  }
}

class AppServerConnection {
  readonly #options: OpenAICompatOptions;
  #clientPromise: Promise<AppServerProtocolClient> | null = null;
  #initializePromise: Promise<void> | null = null;
  #pumpStarted = false;
  #subscribers = new Set<(event: AppServerEvent) => void>();

  constructor(options: OpenAICompatOptions) {
    this.#options = options;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureInitialized();
    return (await this.#client()).request(method, params);
  }

  subscribe(callback: (event: AppServerEvent) => void): () => void {
    this.#subscribers.add(callback);
    return () => {
      this.#subscribers.delete(callback);
    };
  }

  async ensureInitialized(): Promise<void> {
    if (!this.#initializePromise) {
      this.#initializePromise = (async () => {
        const client = await this.#client();
        this.#startEventPump(client);
        await client.request("initialize", {
          clientInfo: {
            name: "usetemi-codex-sdk",
            title: "Temi Codex SDK OpenAI Compatibility",
            version: "0.130.0-5",
          },
          capabilities: {
            experimentalApi: true,
          },
        });
      })();
    }

    await this.#initializePromise;
  }

  async close(): Promise<void> {
    if (!this.#clientPromise) {
      return;
    }

    const client = await this.#clientPromise;
    await client.close?.();
  }

  async #client(): Promise<AppServerProtocolClient> {
    if (!this.#clientPromise) {
      this.#clientPromise = Promise.resolve(
        this.#options.client ?? AppServerClient.start(this.#options.appServer),
      );
    }

    return this.#clientPromise;
  }

  #startEventPump(client: AppServerProtocolClient): void {
    const events = client.events?.bind(client);
    if (this.#pumpStarted || !events) {
      return;
    }

    this.#pumpStarted = true;
    void (async () => {
      try {
        for await (const event of events()) {
          if (event.type === "serverRequest") {
            await this.#respondToServerRequest(client, event);
          }

          for (const subscriber of this.#subscribers) {
            subscriber(event);
          }
        }
      } catch {
        // Request paths surface app-server failures through request promises.
      }
    })();
  }

  async #respondToServerRequest(
    client: AppServerProtocolClient,
    event: Extract<AppServerEvent, { type: "serverRequest" }>,
  ): Promise<void> {
    if (!client.respond && !client.respondError) {
      return;
    }

    const method = event.message.method;
    try {
      if (method === "item/commandExecution/requestApproval") {
        await client.respond?.(event.id, { decision: "decline" });
      } else if (method === "item/fileChange/requestApproval") {
        await client.respond?.(event.id, { decision: "decline" });
      } else if (method === "applyPatchApproval" || method === "execCommandApproval") {
        await client.respond?.(event.id, { decision: "denied" });
      } else {
        await client.respondError?.(event.id, {
          code: -32000,
          message: "OpenAI compatibility server does not support interactive app-server requests",
        });
      }
    } catch {
      // Ignore approval cleanup failures; the active turn will report the real failure.
    }
  }
}

export function createOpenAICompatHandler(options: OpenAICompatOptions = {}): OpenAICompatHandler {
  const connection = new AppServerConnection(options);

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, options, connection);
  }) as OpenAICompatHandler;

  handler.ready = async () => {
    await connection.ensureInitialized();
  };

  handler.close = async () => {
    await connection.close();
  };

  return handler;
}

export function createOpenAICompatServer(options: OpenAICompatOptions = {}): Server {
  const handler = createOpenAICompatHandler(options);
  const server = createServer(handler);
  server.on("close", () => {
    void handler.close();
  });
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
): Promise<void> {
  try {
    if (!isAuthorized(req, options.bearerToken)) {
      sendOpenAIError(res, 401, "Missing or invalid bearer token", "invalid_request_error", null);
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModelList(res, connection);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      await handleChatCompletions(req, res, options, connection);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res, options, connection);
      return;
    }

    if (url.pathname === "/v1/responses" || url.pathname.startsWith("/v1/responses/")) {
      sendOpenAIError(
        res,
        501,
        "Stored response retrieval, update, deletion, and background operations are not supported",
        "unsupported_feature",
        null,
        "unsupported",
      );
      return;
    }

    sendOpenAIError(
      res,
      404,
      `Unsupported OpenAI-compatible endpoint: ${req.method ?? "GET"} ${url.pathname}`,
      "invalid_request_error",
      null,
      "not_found",
    );
  } catch (error) {
    sendErrorFromUnknown(res, error);
  }
}

async function handleModelList(
  res: ServerResponse,
  connection: AppServerConnection,
): Promise<void> {
  const models: JsonRecord[] = [];
  await collectModels(connection, models);

  sendJson(res, 200, {
    object: "list",
    data: models.map((model) => ({
      id: typeof model.id === "string" ? model.id : String(model.model ?? "unknown"),
      object: "model",
      created: 0,
      owned_by: "codex",
    })),
  });
}

async function collectModels(
  connection: AppServerConnection,
  models: JsonRecord[],
  cursor?: string,
): Promise<void> {
  const response = await connection.request("model/list", cursor ? { cursor } : {});
  const record = expectRecord(response, "model/list response must be an object");
  const data = Array.isArray(record.data) ? record.data : [];
  for (const item of data) {
    if (isRecord(item)) {
      models.push(item);
    }
  }

  if (typeof record.nextCursor === "string") {
    await collectModels(connection, models, record.nextCursor);
  }
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
): Promise<void> {
  const body = expectRecord(await readJsonBody(req), "Request body must be a JSON object");
  rejectUnsupportedCreateFields(body, "chat");
  const stream = body.stream === true;
  const tempFiles = new ImageTempFiles(options.imageTempDir);

  try {
    const input = await mapChatInput(body, tempFiles);
    const model = resolveRequestModel(body, options);

    if (stream) {
      await streamChatCompletion(res, body, input, model, options, connection, tempFiles);
      return;
    }

    const turn = await runCodexTurn(connection, input, model, options);
    await tempFiles.cleanup();
    sendJson(res, 200, buildChatCompletionResponse(turn, model));
  } finally {
    await tempFiles.cleanup();
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
): Promise<void> {
  const body = expectRecord(await readJsonBody(req), "Request body must be a JSON object");
  rejectUnsupportedCreateFields(body, "responses");
  const stream = body.stream === true;
  const tempFiles = new ImageTempFiles(options.imageTempDir);

  try {
    const input = await mapResponsesInput(body, tempFiles);
    const model = resolveRequestModel(body, options);

    if (stream) {
      await streamResponse(res, input, model, options, connection, tempFiles);
      return;
    }

    const turn = await runCodexTurn(connection, input, model, options);
    await tempFiles.cleanup();
    sendJson(res, 200, buildResponseObject(turn, model));
  } finally {
    await tempFiles.cleanup();
  }
}

async function runCodexTurn(
  connection: AppServerConnection,
  input: CodexUserInput[],
  model: string | undefined,
  options: OpenAICompatOptions,
  callbacks: {
    onTextDelta?: (delta: string) => void;
    isAborted?: () => boolean;
    onTurnStarted?: (threadId: string, turnId: string) => void;
  } = {},
): Promise<CompletedTurn> {
  const thread = parseThreadStartResponse(
    await connection.request("thread/start", buildThreadStartParams(model, options)),
  );
  const threadId = thread.thread.id;

  let turnId: string | null = null;
  let finalText = "";
  let streamedText = "";
  let usage: TokenUsageBreakdown | null = null;
  let settled = false;
  let resolveCompleted!: () => void;
  let rejectCompleted!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompleted = resolve;
    rejectCompleted = reject;
  });

  const unsubscribe = connection.subscribe((event) => {
    if (event.type !== "notification") {
      return;
    }

    const message = event.message;
    const params = isRecord(message.params) ? message.params : {};
    if (!notificationBelongsToTurn(params, threadId, turnId)) {
      return;
    }

    switch (message.method) {
      case "turn/started": {
        const turn = parseTurn(params.turn);
        if (turn?.id) {
          turnId = turn.id;
          callbacks.onTurnStarted?.(threadId, turnId);
        }
        break;
      }
      case "item/agentMessage/delta": {
        const delta = typeof params.delta === "string" ? params.delta : "";
        streamedText += delta;
        callbacks.onTextDelta?.(delta);
        break;
      }
      case "item/completed": {
        const item = isRecord(params.item) ? params.item : null;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          finalText = item.text;
        }
        break;
      }
      case "rawResponseItem/completed": {
        const text = outputTextFromRawResponseItem(params.item);
        if (text) {
          finalText = text;
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        usage = parseTokenUsage(params.tokenUsage);
        break;
      }
      case "error": {
        if (settled || params.willRetry === true) {
          break;
        }

        settled = true;
        rejectCompleted(appServerTurnError(params.error));
        break;
      }
      case "turn/completed": {
        if (settled) {
          break;
        }

        const turn = parseTurn(params.turn);
        if (turn?.id) {
          turnId = turn.id;
        }
        collectTurnSnapshot(turn, (text) => {
          finalText = text;
        });

        if (turn?.status === "failed") {
          settled = true;
          rejectCompleted(appServerTurnError(turn.error));
          break;
        }

        settled = true;
        resolveCompleted();
        break;
      }
      default:
        break;
    }
  });

  try {
    const turnStart = expectRecord(
      await connection.request("turn/start", {
        threadId,
        input,
      }),
      "turn/start response must be an object",
    );
    const turn = parseTurn(turnStart.turn);
    if (turn?.id) {
      turnId = turn.id;
      callbacks.onTurnStarted?.(threadId, turnId);
    }

    collectTurnSnapshot(turn, (text) => {
      finalText = text;
    });
    if (turn?.status === "completed" && !settled) {
      settled = true;
      resolveCompleted();
    } else if (turn?.status === "failed" && !settled) {
      settled = true;
      rejectCompleted(appServerTurnError(turn.error));
    }

    if (callbacks.isAborted?.()) {
      await interruptTurn(connection, threadId, turnId);
      throw new OpenAICompatHttpError(499, "Client disconnected", "client_disconnected");
    }

    await completed;
    return {
      text: finalText || streamedText,
      usage,
    };
  } catch (error) {
    if (turnId) {
      await interruptTurn(connection, threadId, turnId);
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

async function streamChatCompletion(
  res: ServerResponse,
  body: JsonRecord,
  input: CodexUserInput[],
  model: string | undefined,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
  tempFiles: ImageTempFiles,
): Promise<void> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = nowSeconds();
  const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
  let closed = false;
  res.on("close", () => {
    if (!res.writableEnded) {
      closed = true;
    }
  });

  writeSseHeaders(res);
  let streamedText = "";
  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: model ?? "codex",
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      },
    ],
  });

  try {
    const turn = await runCodexTurn(connection, input, model, options, {
      isAborted: () => closed,
      onTextDelta: (delta) => {
        if (!closed && delta) {
          streamedText += delta;
          writeSseData(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model: model ?? "codex",
            choices: [
              {
                index: 0,
                delta: { content: delta },
                finish_reason: null,
              },
            ],
          });
        }
      },
    });

    if (!closed) {
      if (turn.text && !streamedText) {
        writeSseData(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: model ?? "codex",
          choices: [
            {
              index: 0,
              delta: { content: turn.text },
              finish_reason: null,
            },
          ],
        });
      }
      writeSseData(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: model ?? "codex",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
        ...(includeUsage ? { usage: mapChatUsage(turn.usage) } : {}),
      });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } catch (error) {
    if (!closed) {
      writeSseData(res, { error: openAIErrorBody(error) });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } finally {
    await tempFiles.cleanup();
  }
}

async function streamResponse(
  res: ServerResponse,
  input: CodexUserInput[],
  model: string | undefined,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
  tempFiles: ImageTempFiles,
): Promise<void> {
  const responseId = `resp_${randomUUID()}`;
  const messageId = `msg_${randomUUID()}`;
  const createdAt = nowSeconds();
  let closed = false;
  let text = "";
  res.on("close", () => {
    if (!res.writableEnded) {
      closed = true;
    }
  });

  writeSseHeaders(res);
  writeSseEvent(res, "response.created", {
    type: "response.created",
    response: baseResponseObject(responseId, createdAt, model, "in_progress", "", null, messageId),
  });

  try {
    const turn = await runCodexTurn(connection, input, model, options, {
      isAborted: () => closed,
      onTextDelta: (delta) => {
        if (!closed && delta) {
          text += delta;
          writeSseEvent(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            response_id: responseId,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta,
          });
        }
      },
    });
    if (turn.text && turn.text !== text) {
      if (!text && !closed) {
        writeSseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          response_id: responseId,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: turn.text,
        });
      }
      text = turn.text;
    }

    if (!closed) {
      writeSseEvent(res, "response.output_text.done", {
        type: "response.output_text.done",
        response_id: responseId,
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      });
      writeSseEvent(res, "response.completed", {
        type: "response.completed",
        response: baseResponseObject(
          responseId,
          createdAt,
          model,
          "completed",
          text,
          turn.usage,
          messageId,
        ),
      });
      res.end();
    }
  } catch (error) {
    if (!closed) {
      writeSseEvent(res, "error", {
        type: "error",
        error: openAIErrorBody(error).error,
      });
      res.end();
    }
  } finally {
    await tempFiles.cleanup();
  }
}

function buildThreadStartParams(
  model: string | undefined,
  options: OpenAICompatOptions,
): JsonRecord {
  return compactRecord({
    model,
    modelProvider: options.modelProvider,
    cwd: options.cwd,
    approvalPolicy: options.approvalPolicy,
    sandbox: options.sandbox,
    config: options.config,
    serviceName: "openai-compat",
    ephemeral: true,
    threadSource: "user",
  });
}

function buildChatCompletionResponse(turn: CompletedTurn, model: string | undefined): JsonRecord {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: nowSeconds(),
    model: model ?? "codex",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: turn.text,
          refusal: null,
          annotations: [],
        },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: mapChatUsage(turn.usage),
  };
}

function buildResponseObject(turn: CompletedTurn, model: string | undefined): JsonRecord {
  return baseResponseObject(
    `resp_${randomUUID()}`,
    nowSeconds(),
    model,
    "completed",
    turn.text,
    turn.usage,
    `msg_${randomUUID()}`,
  );
}

function baseResponseObject(
  id: string,
  createdAt: number,
  model: string | undefined,
  status: "in_progress" | "completed",
  text: string,
  usage: TokenUsageBreakdown | null,
  messageId: string,
): JsonRecord {
  return {
    id,
    object: "response",
    created_at: createdAt,
    completed_at: status === "completed" ? createdAt : null,
    status,
    model: model ?? "codex",
    output: text
      ? [
          {
            id: messageId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text,
                annotations: [],
                logprobs: [],
              },
            ],
          },
        ]
      : [],
    output_text: text,
    usage: usage ? mapResponsesUsage(usage) : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    tools: [],
    parallel_tool_calls: false,
    metadata: null,
    tool_choice: "auto",
    temperature: null,
    top_p: null,
  };
}

function mapChatUsage(usage: TokenUsageBreakdown | null): JsonRecord {
  return {
    prompt_tokens: usage?.inputTokens ?? 0,
    completion_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: usage?.cachedInputTokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage?.reasoningOutputTokens ?? 0,
    },
  };
}

function mapResponsesUsage(usage: TokenUsageBreakdown): JsonRecord {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    input_tokens_details: {
      cached_tokens: usage.cachedInputTokens,
    },
    output_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens,
    },
  };
}

async function mapChatInput(
  body: JsonRecord,
  tempFiles: ImageTempFiles,
): Promise<CodexUserInput[]> {
  if (!Array.isArray(body.messages)) {
    throw new OpenAICompatHttpError(
      400,
      "messages must be an array",
      "invalid_request_error",
      "messages",
    );
  }

  const input: CodexUserInput[] = [];
  await Array.from(body.messages.entries()).reduce<Promise<void>>(
    async (previous, [index, message]) => {
      await previous;
      if (!isRecord(message)) {
        throw new OpenAICompatHttpError(
          400,
          `messages[${index}] must be an object`,
          "invalid_request_error",
          `messages.${index}`,
        );
      }

      const role = typeof message.role === "string" ? message.role : "user";
      if (!["system", "developer", "user", "assistant"].includes(role)) {
        throw new OpenAICompatHttpError(
          400,
          `Unsupported chat message role: ${role}`,
          "invalid_request_error",
          `messages.${index}.role`,
        );
      }
      await appendRoleContent(input, role, message.content, tempFiles, `messages.${index}.content`);
    },
    Promise.resolve(),
  );

  if (input.length === 0) {
    throw new OpenAICompatHttpError(400, "messages must include text or image content");
  }

  return input;
}

async function mapResponsesInput(
  body: JsonRecord,
  tempFiles: ImageTempFiles,
): Promise<CodexUserInput[]> {
  const input: CodexUserInput[] = [];

  if (typeof body.instructions === "string" && body.instructions) {
    input.push(textInput(`[instructions]\n${body.instructions}`));
  }

  if (typeof body.input === "string") {
    input.push(textInput(`[user]\n${body.input}`));
  } else if (Array.isArray(body.input)) {
    await Array.from(body.input.entries()).reduce<Promise<void>>(
      async (previous, [index, item]) => {
        await previous;
        if (typeof item === "string") {
          input.push(textInput(`[user]\n${item}`));
          return;
        }

        if (!isRecord(item)) {
          throw new OpenAICompatHttpError(
            400,
            `input[${index}] must be a string or object`,
            "invalid_request_error",
            `input.${index}`,
          );
        }

        if (item.type === "input_text" || item.type === "output_text" || item.type === "text") {
          const text = typeof item.text === "string" ? item.text : "";
          input.push(textInput(`[user]\n${text}`));
        } else if (item.type === "input_image" || item.type === "image_url") {
          input.push(await imageInputFromPart(item, tempFiles, `input.${index}`));
        } else if (item.type === undefined || item.type === "message") {
          const role = typeof item.role === "string" ? item.role : "user";
          await appendRoleContent(input, role, item.content, tempFiles, `input.${index}.content`);
        } else {
          throw unsupportedContent(
            `Unsupported Responses input item type: ${String(item.type)}`,
            `input.${index}.type`,
          );
        }
      },
      Promise.resolve(),
    );
  } else {
    throw new OpenAICompatHttpError(
      400,
      "input must be a string or array",
      "invalid_request_error",
      "input",
    );
  }

  if (input.length === 0) {
    throw new OpenAICompatHttpError(400, "input must include text or image content");
  }

  return input;
}

async function appendRoleContent(
  input: CodexUserInput[],
  role: string,
  content: unknown,
  tempFiles: ImageTempFiles,
  param: string,
): Promise<void> {
  if (typeof content === "string") {
    input.push(textInput(`[${role}]\n${content}`));
    return;
  }

  if (!Array.isArray(content)) {
    if (content === null || content === undefined) {
      input.push(textInput(`[${role}]`));
      return;
    }
    throw new OpenAICompatHttpError(
      400,
      `${param} must be a string or content array`,
      "invalid_request_error",
      param,
    );
  }

  let textBuffer = `[${role}]\n`;
  let appended = false;
  const flushText = () => {
    if (textBuffer.trim()) {
      input.push(textInput(textBuffer.trimEnd()));
      textBuffer = "";
      appended = true;
    }
  };

  await Array.from(content.entries()).reduce<Promise<void>>(async (previous, [index, part]) => {
    await previous;
    if (!isRecord(part)) {
      throw new OpenAICompatHttpError(
        400,
        `${param}[${index}] must be an object`,
        "invalid_request_error",
        `${param}.${index}`,
      );
    }

    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      textBuffer += `${typeof part.text === "string" ? part.text : ""}\n`;
    } else if (part.type === "image_url" || part.type === "input_image") {
      flushText();
      input.push(await imageInputFromPart(part, tempFiles, `${param}.${index}`));
      appended = true;
    } else {
      throw unsupportedContent(
        `Unsupported content type: ${String(part.type)}`,
        `${param}.${index}.type`,
      );
    }
  }, Promise.resolve());

  flushText();
  if (!appended && !textBuffer) {
    input.push(textInput(`[${role}]`));
  }
}

async function imageInputFromPart(
  part: JsonRecord,
  tempFiles: ImageTempFiles,
  param: string,
): Promise<CodexUserInput> {
  if ("file_id" in part || "file_data" in part) {
    throw unsupportedContent("File inputs are not supported", param);
  }

  let imageUrl: unknown = part.image_url;
  if (isRecord(imageUrl)) {
    imageUrl = imageUrl.url;
  }
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    throw new OpenAICompatHttpError(
      400,
      "image_url must be a URL string",
      "invalid_request_error",
      param,
    );
  }

  const filePath = await materializeImageUrl(imageUrl, tempFiles, param);
  return {
    type: "localImage",
    path: filePath,
  };
}

async function materializeImageUrl(
  imageUrl: string,
  tempFiles: ImageTempFiles,
  param: string,
): Promise<string> {
  if (imageUrl.startsWith("data:")) {
    const parsed = parseDataUrl(imageUrl, param);
    return tempFiles.write(parsed.buffer, mimeToExtension(parsed.mimeType));
  }

  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new OpenAICompatHttpError(
        400,
        `Unable to download image_url: HTTP ${response.status}`,
        "invalid_request_error",
        param,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") ?? "";
    return tempFiles.write(buffer, extensionFromUrl(imageUrl) ?? mimeToExtension(contentType));
  }

  throw unsupportedContent("Only http(s) and data image URLs are supported", param);
}

function parseDataUrl(imageUrl: string, param: string): { mimeType: string; buffer: Buffer } {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (!match || match[2] !== ";base64") {
    throw unsupportedContent("Only base64 data image URLs are supported", param);
  }

  return {
    mimeType: match[1] ?? "application/octet-stream",
    buffer: Buffer.from(match[3], "base64"),
  };
}

function extensionFromUrl(imageUrl: string): string | null {
  try {
    const url = new URL(imageUrl);
    const ext = path.extname(url.pathname).toLowerCase();
    return ext.match(/^\.[a-z0-9]{1,8}$/) ? ext : null;
  } catch {
    return null;
  }
}

function mimeToExtension(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function rejectUnsupportedCreateFields(body: JsonRecord, endpoint: "chat" | "responses"): void {
  if (typeof body.n === "number" && body.n > 1) {
    throw unsupportedFeature("n > 1 is not supported", "n");
  }
  if ("tools" in body || "tool_choice" in body || "functions" in body || "function_call" in body) {
    throw unsupportedFeature("Tools and function calling are not supported", "tools");
  }
  if (body.logprobs === true || "top_logprobs" in body) {
    throw unsupportedFeature("Logprobs are not supported", "logprobs");
  }
  if ("audio" in body || (Array.isArray(body.modalities) && body.modalities.includes("audio"))) {
    throw unsupportedFeature("Audio inputs and outputs are not supported", "audio");
  }
  if (endpoint === "responses") {
    if ("previous_response_id" in body && body.previous_response_id !== null) {
      throw unsupportedFeature("previous_response_id is not supported", "previous_response_id");
    }
    if (body.background === true) {
      throw unsupportedFeature("Background mode is not supported", "background");
    }
    if (body.store === true) {
      throw unsupportedFeature("Stored responses are not supported", "store");
    }
  }
}

function resolveRequestModel(body: JsonRecord, options: OpenAICompatOptions): string | undefined {
  if (body.model !== undefined && typeof body.model !== "string") {
    throw new OpenAICompatHttpError(
      400,
      "model must be a string",
      "invalid_request_error",
      "model",
    );
  }

  return typeof body.model === "string" && body.model ? body.model : options.model;
}

function parseThreadStartResponse(response: unknown): CodexThreadStartResponse {
  const record = expectRecord(response, "thread/start response must be an object");
  const thread = expectRecord(record.thread, "thread/start response must include thread");
  if (typeof thread.id !== "string") {
    throw new Error("thread/start response must include thread.id");
  }

  return {
    thread: {
      id: thread.id,
    },
    model: typeof record.model === "string" ? record.model : undefined,
  };
}

function notificationBelongsToTurn(
  params: JsonRecord,
  threadId: string,
  turnId: string | null,
): boolean {
  if (params.threadId !== threadId) {
    return false;
  }
  if (turnId && typeof params.turnId === "string" && params.turnId !== turnId) {
    return false;
  }

  return true;
}

function parseTurn(value: unknown): CodexTurn | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  return {
    id: value.id,
    status: typeof value.status === "string" ? value.status : undefined,
    error: isRecord(value.error) ? value.error : null,
    items: Array.isArray(value.items) ? value.items : [],
  };
}

function collectTurnSnapshot(turn: CodexTurn | null, setText: (text: string) => void): void {
  if (!turn?.items) {
    return;
  }

  for (const item of turn.items) {
    if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
      setText(item.text);
    }
  }
}

function parseTokenUsage(value: unknown): TokenUsageBreakdown | null {
  const record = isRecord(value) ? value : null;
  const last = isRecord(record?.last) ? record.last : null;
  if (!last) {
    return null;
  }

  return {
    totalTokens: numberField(last.totalTokens),
    inputTokens: numberField(last.inputTokens),
    cachedInputTokens: numberField(last.cachedInputTokens),
    outputTokens: numberField(last.outputTokens),
    reasoningOutputTokens: numberField(last.reasoningOutputTokens),
  };
}

function outputTextFromRawResponseItem(value: unknown): string | null {
  if (!isRecord(value) || value.type !== "message" || !Array.isArray(value.content)) {
    return null;
  }

  return value.content
    .map((item) => {
      if (isRecord(item) && item.type === "output_text" && typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .join("");
}

async function interruptTurn(
  connection: AppServerConnection,
  threadId: string,
  turnId: string | null,
): Promise<void> {
  if (!turnId) {
    return;
  }

  try {
    await connection.request("turn/interrupt", { threadId, turnId });
  } catch {
    // Interrupt is best-effort when the HTTP client disconnects or a turn fails.
  }
}

function appServerTurnError(error: unknown): Error {
  if (isRecord(error) && typeof error.message === "string") {
    return new Error(error.message);
  }

  return new Error("Codex turn failed");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > 20 * 1024 * 1024) {
      throw new OpenAICompatHttpError(400, "Request body is too large");
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    throw new OpenAICompatHttpError(400, "Request body must be JSON");
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new OpenAICompatHttpError(400, "Request body must be valid JSON");
  }
}

function isAuthorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) {
    return true;
  }

  return req.headers.authorization === `Bearer ${token}`;
}

function sendErrorFromUnknown(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  if (error instanceof OpenAICompatHttpError) {
    sendOpenAIError(res, error.status, error.message, error.type, error.param, error.code);
    return;
  }

  if (error instanceof JsonRpcResponseError) {
    const status = error.message.toLowerCase().includes("rate") ? 429 : 500;
    sendOpenAIError(res, status, error.message, "server_error", null, String(error.code));
    return;
  }

  sendOpenAIError(
    res,
    500,
    error instanceof Error ? error.message : "Unexpected Codex app-server failure",
    "server_error",
    null,
    null,
  );
}

function sendOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  param: string | null,
  code: string | null = null,
): void {
  sendJson(res, status, {
    error: {
      message,
      type,
      param,
      code,
    },
  });
}

function openAIErrorBody(error: unknown): JsonRecord {
  if (error instanceof OpenAICompatHttpError) {
    return {
      error: {
        message: error.message,
        type: error.type,
        param: error.param,
        code: error.code,
      },
    };
  }

  return {
    error: {
      message: error instanceof Error ? error.message : "Unexpected Codex app-server failure",
      type: "server_error",
      param: null,
      code: null,
    },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function writeSseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders();
}

function writeSseData(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  writeSseData(res, data);
}

function unsupportedFeature(message: string, param: string | null): OpenAICompatHttpError {
  return new OpenAICompatHttpError(501, message, "unsupported_feature", param, "unsupported");
}

function unsupportedContent(message: string, param: string): OpenAICompatHttpError {
  return unsupportedFeature(message, param);
}

function expectRecord(value: unknown, message: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(message);
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textInput(text: string): CodexUserInput {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compactRecord(record: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
