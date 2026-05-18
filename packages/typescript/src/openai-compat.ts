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

type ResponseStatus = "in_progress" | "completed";

type ResponsesOutputItem = JsonRecord & {
  id: string;
  type: string;
};

type FunctionToolDefinition = {
  name: string;
  description: string;
  parameters: unknown;
  strict?: boolean;
};

type FunctionCallRecord = {
  id: string;
  callId: string;
  name: string;
  arguments: string;
};

type ResponseContinuationState = {
  id: string;
  threadId: string;
  outputItems: ResponsesOutputItem[];
  toolCalls: Map<string, FunctionCallRecord>;
  tools: FunctionToolDefinition[];
  status: ResponseStatus;
  createdAtMs: number;
};

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
  threadId: string;
  text: string;
  usage: TokenUsageBreakdown | null;
  rawOutputItems: JsonRecord[];
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

class ResponseStateStore {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #states = new Map<string, ResponseContinuationState>();

  constructor(ttlMs = 60 * 60 * 1000, maxEntries = 256) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get(id: string): ResponseContinuationState | null {
    this.#sweepExpired();
    const state = this.#states.get(id);
    if (!state) {
      return null;
    }

    this.#states.delete(id);
    this.#states.set(id, state);
    return state;
  }

  set(state: ResponseContinuationState): void {
    this.#sweepExpired();
    this.#states.set(state.id, state);
    while (this.#states.size > this.#maxEntries) {
      const oldest = this.#states.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      this.#states.delete(oldest);
    }
  }

  #sweepExpired(): void {
    const now = Date.now();
    for (const [id, state] of this.#states.entries()) {
      if (now - state.createdAtMs > this.#ttlMs) {
        this.#states.delete(id);
      }
    }
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
            version: "0.130.0-6",
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
  const responseStates = new ResponseStateStore();

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, options, connection, responseStates);
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
  responseStates: ResponseStateStore,
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
      await handleResponses(req, res, options, connection, responseStates);
      return;
    }

    if (isUnsupportedAgentsEndpoint(url.pathname)) {
      sendOpenAIError(
        res,
        501,
        `Unsupported OpenAI-compatible endpoint: ${req.method ?? "GET"} ${url.pathname}`,
        "unsupported_feature",
        null,
        "unsupported",
      );
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
    const tools = parseChatFunctionTools(body);
    validateToolChoice(body.tool_choice ?? body.function_call, tools, "tool_choice");
    const codexInput = withToolContract(input, tools, {
      toolChoice: body.tool_choice ?? body.function_call,
      parallelToolCalls: body.parallel_tool_calls,
    });
    const model = resolveRequestModel(body, options);

    if (stream) {
      await streamChatCompletion(
        res,
        body,
        codexInput,
        model,
        options,
        connection,
        tempFiles,
        tools,
      );
      return;
    }

    const turn = await runCodexTurn(connection, codexInput, model, options);
    await tempFiles.cleanup();
    sendJson(res, 200, buildChatCompletionResponse(turn, model, outputItemsFromTurn(turn, tools)));
  } finally {
    await tempFiles.cleanup();
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  options: OpenAICompatOptions,
  connection: AppServerConnection,
  responseStates: ResponseStateStore,
): Promise<void> {
  const body = expectRecord(await readJsonBody(req), "Request body must be a JSON object");
  rejectUnsupportedCreateFields(body, "responses");
  const stream = body.stream === true;
  const tempFiles = new ImageTempFiles(options.imageTempDir);

  try {
    const previousState = resolvePreviousResponseState(body, responseStates);
    const tools = parseResponsesFunctionTools(body, previousState?.tools ?? []);
    validateToolChoice(body.tool_choice, tools, "tool_choice");
    const input = await mapResponsesInput(body, tempFiles, previousState);
    const codexInput = withToolContract(input, tools, {
      toolChoice: body.tool_choice,
      parallelToolCalls: body.parallel_tool_calls,
    });
    const model = resolveRequestModel(body, options);

    if (stream) {
      await streamResponse(
        res,
        codexInput,
        model,
        options,
        connection,
        tempFiles,
        tools,
        responseStates,
        previousState,
      );
      return;
    }

    const turn = await runCodexTurn(
      connection,
      codexInput,
      model,
      options,
      {},
      previousState?.threadId,
    );
    await tempFiles.cleanup();
    const responseId = `resp_${randomUUID()}`;
    const outputItems = outputItemsFromTurn(turn, tools);
    responseStates.set(responseStateFromTurn(responseId, turn, outputItems, tools));
    sendJson(res, 200, buildResponseObject(turn, model, responseId, outputItems));
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
  existingThreadId?: string,
): Promise<CompletedTurn> {
  const threadId =
    existingThreadId ??
    parseThreadStartResponse(
      await connection.request("thread/start", buildThreadStartParams(model, options)),
    ).thread.id;

  let turnId: string | null = null;
  let finalText = "";
  let streamedText = "";
  const rawOutputItems: JsonRecord[] = [];
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
        if (isRecord(params.item)) {
          rawOutputItems.push(params.item);
        }
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
      threadId,
      text: finalText || streamedText,
      usage,
      rawOutputItems,
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
  tools: FunctionToolDefinition[],
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
        if (!closed && delta && tools.length === 0) {
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
    const outputItems = outputItemsFromTurn(turn, tools);
    const functionCall = firstFunctionCall(outputItems);

    if (!closed) {
      if (functionCall) {
        writeSseData(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model: model ?? "codex",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: functionCall.callId,
                    type: "function",
                    function: {
                      name: functionCall.name,
                      arguments: functionCall.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
      } else if (turn.text && !streamedText) {
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
            finish_reason: functionCall ? "tool_calls" : "stop",
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
  tools: FunctionToolDefinition[],
  responseStates: ResponseStateStore,
  previousState: ResponseContinuationState | null,
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
    response: baseResponseObject(responseId, createdAt, model, "in_progress", [], null),
  });

  try {
    const turn = await runCodexTurn(
      connection,
      input,
      model,
      options,
      {
        isAborted: () => closed,
        onTextDelta: (delta) => {
          if (!closed && delta && tools.length === 0) {
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
      },
      previousState?.threadId,
    );
    const outputItems = outputItemsFromTurn(turn, tools, messageId);
    const functionCall = firstFunctionCall(outputItems);
    if (functionCall) {
      if (!closed) {
        writeFunctionCallSseEvents(res, responseId, functionCall);
      }
    } else if (turn.text && turn.text !== text) {
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
      if (!functionCall) {
        writeSseEvent(res, "response.output_text.done", {
          type: "response.output_text.done",
          response_id: responseId,
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
        });
      }
      responseStates.set(responseStateFromTurn(responseId, turn, outputItems, tools));
      writeSseEvent(res, "response.completed", {
        type: "response.completed",
        response: baseResponseObject(
          responseId,
          createdAt,
          model,
          "completed",
          outputItems,
          turn.usage,
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

function buildChatCompletionResponse(
  turn: CompletedTurn,
  model: string | undefined,
  outputItems: ResponsesOutputItem[],
): JsonRecord {
  const functionCall = firstFunctionCall(outputItems);
  const message = functionCall
    ? {
        role: "assistant",
        content: null,
        refusal: null,
        annotations: [],
        tool_calls: [
          {
            id: functionCall.callId,
            type: "function",
            function: {
              name: functionCall.name,
              arguments: functionCall.arguments,
            },
          },
        ],
      }
    : {
        role: "assistant",
        content: outputTextFromOutputItems(outputItems) || turn.text,
        refusal: null,
        annotations: [],
      };

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: nowSeconds(),
    model: model ?? "codex",
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: functionCall ? "tool_calls" : "stop",
      },
    ],
    usage: mapChatUsage(turn.usage),
  };
}

function buildResponseObject(
  turn: CompletedTurn,
  model: string | undefined,
  responseId: string,
  outputItems: ResponsesOutputItem[],
): JsonRecord {
  return baseResponseObject(responseId, nowSeconds(), model, "completed", outputItems, turn.usage);
}

function baseResponseObject(
  id: string,
  createdAt: number,
  model: string | undefined,
  status: ResponseStatus,
  outputItems: ResponsesOutputItem[],
  usage: TokenUsageBreakdown | null,
): JsonRecord {
  const output = status === "completed" ? outputItems : [];
  const outputText = outputTextFromOutputItems(output);
  return {
    id,
    object: "response",
    created_at: createdAt,
    completed_at: status === "completed" ? createdAt : null,
    status,
    model: model ?? "codex",
    output,
    output_text: outputText,
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

function responseStateFromTurn(
  responseId: string,
  turn: CompletedTurn,
  outputItems: ResponsesOutputItem[],
  tools: FunctionToolDefinition[],
): ResponseContinuationState {
  return {
    id: responseId,
    threadId: turn.threadId,
    outputItems,
    toolCalls: collectFunctionCalls(outputItems),
    tools,
    status: "completed",
    createdAtMs: Date.now(),
  };
}

function outputItemsFromTurn(
  turn: CompletedTurn,
  tools: FunctionToolDefinition[],
  messageId = `msg_${randomUUID()}`,
): ResponsesOutputItem[] {
  const rawFunctionCalls = normalizeRawFunctionCalls(turn.rawOutputItems, tools);
  if (rawFunctionCalls.length > 0) {
    return rawFunctionCalls;
  }

  const envelopeCalls = parseFunctionCallEnvelope(turn.text, tools);
  if (envelopeCalls.length > 0) {
    return envelopeCalls;
  }

  if (!turn.text) {
    return [];
  }

  return [messageOutputItem(messageId, turn.text)];
}

function messageOutputItem(id: string, text: string): ResponsesOutputItem {
  return {
    id,
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
  };
}

function outputTextFromOutputItems(items: ResponsesOutputItem[]): string {
  return items
    .map((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return "";
      }
      return item.content
        .map((content) =>
          isRecord(content) && content.type === "output_text" && typeof content.text === "string"
            ? content.text
            : "",
        )
        .join("");
    })
    .join("");
}

function firstFunctionCall(items: ResponsesOutputItem[]): FunctionCallRecord | null {
  for (const item of items) {
    const call = functionCallRecord(item);
    if (call) {
      return call;
    }
  }

  return null;
}

function collectFunctionCalls(items: ResponsesOutputItem[]): Map<string, FunctionCallRecord> {
  const calls = new Map<string, FunctionCallRecord>();
  for (const item of items) {
    const call = functionCallRecord(item);
    if (call) {
      calls.set(call.callId, call);
    }
  }

  return calls;
}

function functionCallRecord(item: ResponsesOutputItem): FunctionCallRecord | null {
  if (
    item.type !== "function_call" ||
    typeof item.id !== "string" ||
    typeof item.call_id !== "string" ||
    typeof item.name !== "string" ||
    typeof item.arguments !== "string"
  ) {
    return null;
  }

  return {
    id: item.id,
    callId: item.call_id,
    name: item.name,
    arguments: item.arguments,
  };
}

function normalizeRawFunctionCalls(
  items: JsonRecord[],
  tools: FunctionToolDefinition[],
): ResponsesOutputItem[] {
  if (tools.length === 0) {
    return [];
  }

  return items
    .map((item) => normalizeFunctionCallRecord(item, tools))
    .filter((item): item is ResponsesOutputItem => item !== null);
}

function parseFunctionCallEnvelope(
  text: string,
  tools: FunctionToolDefinition[],
): ResponsesOutputItem[] {
  if (!text.trim() || tools.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim()) as unknown;
  } catch {
    return [];
  }

  const records = functionCallEnvelopeRecords(parsed);
  return records
    .map((record) => normalizeFunctionCallRecord(record, tools))
    .filter((item): item is ResponsesOutputItem => item !== null);
}

function functionCallEnvelopeRecords(value: unknown): JsonRecord[] {
  if (!isRecord(value)) {
    return [];
  }

  if (value.type === "function_call") {
    return [value];
  }

  if (
    (value.type === "function_calls" || value.type === "tool_calls") &&
    Array.isArray(value.calls)
  ) {
    return value.calls.filter(isRecord);
  }

  if (Array.isArray(value.tool_calls)) {
    return value.tool_calls.filter(isRecord);
  }

  return [];
}

function normalizeFunctionCallRecord(
  record: JsonRecord,
  tools: FunctionToolDefinition[],
): ResponsesOutputItem | null {
  const name = typeof record.name === "string" ? record.name : null;
  if (!name || !tools.some((tool) => tool.name === name)) {
    return null;
  }

  const args = normalizeFunctionArguments(record.arguments);
  if (args === null) {
    return null;
  }

  return {
    id: typeof record.id === "string" ? record.id : `fc_${randomUUID()}`,
    type: "function_call",
    call_id: typeof record.call_id === "string" ? record.call_id : `call_${randomUUID()}`,
    name,
    arguments: args,
    status: "completed",
  };
}

function normalizeFunctionArguments(value: unknown): string | null {
  if (value === undefined || value === null) {
    return "{}";
  }

  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return value;
    } catch {
      return null;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function withToolContract(
  input: CodexUserInput[],
  tools: FunctionToolDefinition[],
  options: { toolChoice: unknown; parallelToolCalls: unknown },
): CodexUserInput[] {
  if (tools.length === 0) {
    return input;
  }

  return [textInput(toolContractText(tools, options)), ...input];
}

function toolContractText(
  tools: FunctionToolDefinition[],
  options: { toolChoice: unknown; parallelToolCalls: unknown },
): string {
  return [
    "[openai_compat_tools]",
    "Local function tools are available through the client. Do not invent tool results.",
    "If a tool is needed, respond with only this JSON object and no Markdown:",
    '{"type":"function_call","name":"tool_name","arguments":{}}',
    "After a tool result is provided, answer normally or request another tool with the same JSON envelope.",
    `tool_choice: ${JSON.stringify(options.toolChoice ?? "auto")}`,
    `parallel_tool_calls: ${JSON.stringify(options.parallelToolCalls ?? false)}`,
    `tools: ${JSON.stringify(
      tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      })),
    )}`,
  ].join("\n");
}

function writeFunctionCallSseEvents(
  res: ServerResponse,
  responseId: string,
  functionCall: FunctionCallRecord,
): void {
  let sequenceNumber = 1;
  const inProgressItem = {
    id: functionCall.id,
    type: "function_call",
    call_id: functionCall.callId,
    name: functionCall.name,
    arguments: "",
    status: "in_progress",
  };
  const completedItem = {
    ...inProgressItem,
    arguments: functionCall.arguments,
    status: "completed",
  };

  writeSseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    response_id: responseId,
    output_index: 0,
    item: inProgressItem,
    sequence_number: sequenceNumber++,
  });
  writeSseEvent(res, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    response_id: responseId,
    item_id: functionCall.id,
    output_index: 0,
    call_id: functionCall.callId,
    delta: functionCall.arguments,
    sequence_number: sequenceNumber++,
  });
  writeSseEvent(res, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    response_id: responseId,
    item_id: functionCall.id,
    output_index: 0,
    call_id: functionCall.callId,
    name: functionCall.name,
    arguments: functionCall.arguments,
    sequence_number: sequenceNumber++,
  });
  writeSseEvent(res, "response.output_item.done", {
    type: "response.output_item.done",
    response_id: responseId,
    output_index: 0,
    item: completedItem,
    sequence_number: sequenceNumber,
  });
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
      if (!["system", "developer", "user", "assistant", "tool"].includes(role)) {
        throw new OpenAICompatHttpError(
          400,
          `Unsupported chat message role: ${role}`,
          "invalid_request_error",
          `messages.${index}.role`,
        );
      }
      if (role === "tool") {
        input.push(
          textInput(
            `[tool_result]\ncall_id: ${String(message.tool_call_id ?? "")}\noutput:\n${chatContentText(
              message.content,
            )}`,
          ),
        );
        return;
      }

      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        input.push(textInput(`[assistant_tool_calls]\n${JSON.stringify(message.tool_calls)}`));
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
  previousState: ResponseContinuationState | null,
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

        if (item.type === "function_call_output") {
          input.push(functionCallOutputInput(item, previousState));
        } else if (item.type === "function_call") {
          input.push(functionCallInput(item));
        } else if (
          item.type === "input_text" ||
          item.type === "output_text" ||
          item.type === "text"
        ) {
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

function functionCallInput(item: JsonRecord): CodexUserInput {
  return textInput(
    [
      "[assistant_tool_call]",
      `call_id: ${String(item.call_id ?? "")}`,
      `name: ${String(item.name ?? "")}`,
      `arguments: ${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})}`,
    ].join("\n"),
  );
}

function functionCallOutputInput(
  item: JsonRecord,
  previousState: ResponseContinuationState | null,
): CodexUserInput {
  const callId = typeof item.call_id === "string" ? item.call_id : "";
  const previousCall = callId ? previousState?.toolCalls.get(callId) : undefined;
  const output = functionCallOutputText(item.output);
  return textInput(
    [
      "[tool_result]",
      `call_id: ${callId}`,
      `name: ${previousCall?.name ?? String(item.name ?? item.function_name ?? "")}`,
      "output:",
      output,
    ].join("\n"),
  );
}

function functionCallOutputText(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }

  if (Array.isArray(output)) {
    return output
      .map((item) => {
        if (!isRecord(item)) {
          return "";
        }
        if (
          (item.type === "input_text" || item.type === "output_text" || item.type === "text") &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        if (typeof item.image_url === "string") {
          return `[image] ${item.image_url}`;
        }
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }

  return output === undefined ? "" : JSON.stringify(output);
}

function chatContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part.text === "string"
          ? part.text
          : typeof part === "string"
            ? part
            : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return content === undefined || content === null ? "" : String(content);
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

function parseResponsesFunctionTools(
  body: JsonRecord,
  previousTools: FunctionToolDefinition[],
): FunctionToolDefinition[] {
  if (!("tools" in body) || body.tools === undefined || body.tools === null) {
    return previousTools;
  }

  if (!Array.isArray(body.tools)) {
    throw new OpenAICompatHttpError(
      400,
      "tools must be an array",
      "invalid_request_error",
      "tools",
    );
  }

  return body.tools.map((tool, index) => parseResponsesFunctionTool(tool, `tools.${index}`));
}

function parseResponsesFunctionTool(value: unknown, param: string): FunctionToolDefinition {
  if (!isRecord(value)) {
    throw new OpenAICompatHttpError(
      400,
      `${param} must be an object`,
      "invalid_request_error",
      param,
    );
  }

  if (value.type !== "function") {
    throw unsupportedFeature(
      `Only local function tools are supported; received ${String(value.type ?? "unknown")}`,
      `${param}.type`,
    );
  }

  if (value.defer_loading === true || value.deferLoading === true) {
    throw unsupportedFeature(
      "Deferred function tools require tool search, which is not supported",
      param,
    );
  }

  return parseFunctionToolDefinition(value, param);
}

function parseChatFunctionTools(body: JsonRecord): FunctionToolDefinition[] {
  const tools: FunctionToolDefinition[] = [];
  if ("tools" in body && body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) {
      throw new OpenAICompatHttpError(
        400,
        "tools must be an array",
        "invalid_request_error",
        "tools",
      );
    }

    for (const [index, tool] of body.tools.entries()) {
      if (!isRecord(tool)) {
        throw new OpenAICompatHttpError(
          400,
          `tools.${index} must be an object`,
          "invalid_request_error",
          `tools.${index}`,
        );
      }
      if (tool.type !== "function") {
        throw unsupportedFeature(
          `Only local function tools are supported; received ${String(tool.type ?? "unknown")}`,
          `tools.${index}.type`,
        );
      }
      tools.push(parseFunctionToolDefinition(tool.function ?? tool, `tools.${index}`));
    }
  }

  if ("functions" in body && body.functions !== undefined && body.functions !== null) {
    if (!Array.isArray(body.functions)) {
      throw new OpenAICompatHttpError(
        400,
        "functions must be an array",
        "invalid_request_error",
        "functions",
      );
    }
    for (const [index, fn] of body.functions.entries()) {
      tools.push(parseFunctionToolDefinition(fn, `functions.${index}`));
    }
  }

  return tools;
}

function parseFunctionToolDefinition(value: unknown, param: string): FunctionToolDefinition {
  if (!isRecord(value)) {
    throw new OpenAICompatHttpError(
      400,
      `${param} must be an object`,
      "invalid_request_error",
      param,
    );
  }

  if (typeof value.name !== "string" || !value.name) {
    throw new OpenAICompatHttpError(
      400,
      `${param}.name must be a non-empty string`,
      "invalid_request_error",
      `${param}.name`,
    );
  }

  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
    parameters: value.parameters ?? { type: "object", properties: {} },
    ...(typeof value.strict === "boolean" ? { strict: value.strict } : {}),
  };
}

function validateToolChoice(
  toolChoice: unknown,
  tools: FunctionToolDefinition[],
  param: string,
): void {
  if (toolChoice === undefined || toolChoice === null) {
    return;
  }

  if (typeof toolChoice === "string") {
    if (["auto", "none", "required"].includes(toolChoice)) {
      return;
    }
    if (tools.some((tool) => tool.name === toolChoice)) {
      return;
    }
    throw unsupportedFeature(`Unsupported tool_choice: ${toolChoice}`, param);
  }

  if (isRecord(toolChoice)) {
    if (toolChoice.type !== undefined && toolChoice.type !== "function") {
      throw unsupportedFeature(`Unsupported tool_choice type: ${String(toolChoice.type)}`, param);
    }
    const name =
      typeof toolChoice.name === "string"
        ? toolChoice.name
        : isRecord(toolChoice.function) && typeof toolChoice.function.name === "string"
          ? toolChoice.function.name
          : null;
    if (name && tools.some((tool) => tool.name === name)) {
      return;
    }
    throw unsupportedFeature("tool_choice function name is not available", param);
  }

  throw new OpenAICompatHttpError(
    400,
    "tool_choice must be a string or object",
    "invalid_request_error",
    param,
  );
}

function resolvePreviousResponseState(
  body: JsonRecord,
  responseStates: ResponseStateStore,
): ResponseContinuationState | null {
  if (!("previous_response_id" in body) || body.previous_response_id === null) {
    return null;
  }

  if (typeof body.previous_response_id !== "string" || !body.previous_response_id) {
    throw new OpenAICompatHttpError(
      400,
      "previous_response_id must be a non-empty string",
      "invalid_request_error",
      "previous_response_id",
    );
  }

  const state = responseStates.get(body.previous_response_id);
  if (!state) {
    throw new OpenAICompatHttpError(
      404,
      `No response found with id '${body.previous_response_id}'.`,
      "invalid_request_error",
      "previous_response_id",
      "not_found",
    );
  }

  return state;
}

function rejectUnsupportedCreateFields(body: JsonRecord, endpoint: "chat" | "responses"): void {
  if (typeof body.n === "number" && body.n > 1) {
    throw unsupportedFeature("n > 1 is not supported", "n");
  }
  if (body.logprobs === true || "top_logprobs" in body) {
    throw unsupportedFeature("Logprobs are not supported", "logprobs");
  }
  if ("audio" in body || (Array.isArray(body.modalities) && body.modalities.includes("audio"))) {
    throw unsupportedFeature("Audio inputs and outputs are not supported", "audio");
  }
  if (endpoint === "responses") {
    if (body.background === true) {
      throw unsupportedFeature("Background mode is not supported", "background");
    }
    if ("conversation" in body && body.conversation !== null && body.conversation !== undefined) {
      throw unsupportedFeature("Responses conversation sessions are not supported", "conversation");
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

function isUnsupportedAgentsEndpoint(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/traces") ||
    pathname.startsWith("/v1/conversations") ||
    pathname.startsWith("/v1/sessions") ||
    pathname.startsWith("/v1/realtime")
  );
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
