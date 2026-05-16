import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createOpenAICompatHandler,
  type OpenAICompatHandler,
  type OpenAICompatOptions,
} from "@usetemi/codex-sdk/openai-compat";

import {
  CodexAuthBadRequestError,
  CodexAuthConflictError,
  createCodexAuthManager,
  type CodexAuthManager,
} from "./codex-auth.js";
import type { AuthConfig, CliConfig } from "./config.js";

export type ProxyServerOptions = {
  authManager?: CodexAuthManager;
  compat?: OpenAICompatOptions | (() => OpenAICompatOptions);
};

export type CodexOpenAIProxyHandler = {
  (req: IncomingMessage, res: ServerResponse): void;
  ready(): Promise<void>;
  close(): Promise<void>;
};

export function createCodexOpenAIProxyServer(
  config: CliConfig,
  options: ProxyServerOptions = {},
): Server {
  const handler = createCodexOpenAIProxyHandler(config, options);
  const server = createServer(handler);
  server.on("close", () => {
    void handler.close();
  });
  return server;
}

export function createCodexOpenAIProxyHandler(
  config: CliConfig,
  options: ProxyServerOptions = {},
): CodexOpenAIProxyHandler {
  const compatHandler = new RestartableOpenAICompatHandler(config, options.compat);
  const authManager =
    options.authManager ??
    createCodexAuthManager(config, {
      onCredentialsChanged: async () => {
        await compatHandler.restart();
      },
    });

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    void handleProxyRequest(req, res, config.auth, compatHandler, authManager);
  }) as CodexOpenAIProxyHandler;

  handler.ready = async () => {
    await compatHandler.ready();
  };
  handler.close = async () => {
    await compatHandler.close();
    await authManager.close();
  };

  return handler;
}

export function openAICompatOptionsFromConfig(config: CliConfig): OpenAICompatOptions {
  return {
    appServer: {
      command: config.codexCommand,
      args: ["app-server", "--listen", "stdio://"],
      env: codexSubprocessEnv(config),
    },
    cwd: config.cwd,
    model: config.model,
    modelProvider: config.modelProvider,
    sandbox: config.sandbox,
    approvalPolicy: config.approvalPolicy,
  };
}

async function handleProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthConfig,
  compatHandler: RestartableOpenAICompatHandler,
  authManager: CodexAuthManager,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, {
        status: "ok",
        service: "codex-openai-proxy",
        pid: process.pid,
        uptime_seconds: Math.floor(process.uptime()),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/readyz") {
      await handleReadyz(res, compatHandler);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth.md") {
      sendMarkdown(res, 200, authGuideMarkdown());
      return;
    }

    if (url.pathname.startsWith("/auth/")) {
      if (!isAuthorized(req, auth)) {
        sendOpenAIError(res, 401, "Missing or invalid bearer token", "invalid_request_error", null);
        return;
      }

      await handleAuthRequest(req, res, url, authManager);
      return;
    }

    if (url.pathname.startsWith("/v1/")) {
      if (!isAuthorized(req, auth)) {
        sendOpenAIError(res, 401, "Missing or invalid bearer token", "invalid_request_error", null);
        return;
      }

      compatHandler.handle(req, res);
      return;
    }

    sendOpenAIError(
      res,
      404,
      `Unsupported endpoint: ${req.method ?? "GET"} ${url.pathname}`,
      "invalid_request_error",
      null,
      "not_found",
    );
  } catch (error) {
    if (error instanceof CodexAuthBadRequestError) {
      sendOpenAIError(res, 400, error.message, "invalid_request_error", null, "bad_request");
      return;
    }
    if (error instanceof CodexAuthConflictError) {
      sendOpenAIError(res, 409, error.message, "invalid_request_error", null, "conflict");
      return;
    }
    sendOpenAIError(
      res,
      500,
      error instanceof Error ? error.message : "Internal server error",
      "server_error",
      null,
      "internal_error",
    );
  }
}

async function handleReadyz(
  res: ServerResponse,
  compatHandler: RestartableOpenAICompatHandler,
): Promise<void> {
  try {
    await compatHandler.ready();
    sendJson(res, 200, {
      status: "ready",
      service: "codex-openai-proxy",
    });
  } catch (error) {
    sendOpenAIError(
      res,
      503,
      error instanceof Error ? error.message : "Codex app-server initialization failed",
      "server_error",
      null,
      "not_ready",
    );
  }
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  authManager: CodexAuthManager,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/status") {
    sendJson(res, 200, await authManager.status());
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/device") {
    sendJson(res, 202, await authManager.startDeviceFlow());
    return;
  }

  const deviceMatch = url.pathname.match(/^\/auth\/device\/([^/]+)(?:\/cancel)?$/);
  if (deviceMatch) {
    const flowId = decodeURIComponent(deviceMatch[1] ?? "");
    if (req.method === "GET" && !url.pathname.endsWith("/cancel")) {
      const flow = await authManager.getDeviceFlow(flowId);
      if (!flow) {
        sendOpenAIError(
          res,
          404,
          "Codex device login flow not found",
          "invalid_request_error",
          null,
          "not_found",
        );
        return;
      }
      sendJson(res, 200, flow);
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
      const flow = await authManager.cancelDeviceFlow(flowId);
      if (!flow) {
        sendOpenAIError(
          res,
          404,
          "Codex device login flow not found",
          "invalid_request_error",
          null,
          "not_found",
        );
        return;
      }
      sendJson(res, 200, flow);
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/auth/import") {
    const body = await readRequestBody(req);
    sendJson(res, 200, await authManager.importAuthJson(body));
    return;
  }

  sendOpenAIError(
    res,
    404,
    `Unsupported auth endpoint: ${req.method ?? "GET"} ${url.pathname}`,
    "invalid_request_error",
    null,
    "not_found",
  );
}

function codexSubprocessEnv(config: CliConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_OPENAI_PROXY_")) {
      delete env[key];
    }
  }

  if (config.codexHome) {
    env.CODEX_HOME = config.codexHome;
  }
  if (config.codexApiKey) {
    env.CODEX_API_KEY = config.codexApiKey;
  }

  return env;
}

class RestartableOpenAICompatHandler {
  readonly #config: CliConfig;
  readonly #compat: OpenAICompatOptions | (() => OpenAICompatOptions) | undefined;
  #handler: OpenAICompatHandler;

  constructor(
    config: CliConfig,
    compat: OpenAICompatOptions | (() => OpenAICompatOptions) | undefined,
  ) {
    this.#config = config;
    this.#compat = compat;
    this.#handler = this.#createHandler();
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.#handler(req, res);
  }

  async ready(): Promise<void> {
    await this.#handler.ready();
  }

  async restart(): Promise<void> {
    const previous = this.#handler;
    this.#handler = this.#createHandler();
    try {
      await previous.close();
    } catch {
      // Credential updates should not fail because the old app-server was already gone.
    }
  }

  async close(): Promise<void> {
    await this.#handler.close();
  }

  #createHandler(): OpenAICompatHandler {
    const compat = typeof this.#compat === "function" ? this.#compat() : this.#compat;
    return createOpenAICompatHandler({
      ...openAICompatOptionsFromConfig(this.#config),
      ...compat,
      bearerToken: undefined,
    });
  }
}

function isAuthorized(req: IncomingMessage, auth: AuthConfig): boolean {
  if (auth.mode === "disabled") {
    return true;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return false;
  }

  const token = header.slice("Bearer ".length);
  return auth.apiKeys.some((apiKey) => constantTimeEqual(token, apiKey));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sendOpenAIError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string,
  param: string | null,
  code: string | null = null,
): void {
  if (status === 401) {
    res.setHeader("www-authenticate", "Bearer");
  }
  sendJson(res, status, {
    error: {
      message,
      type,
      param,
      code,
    },
  });
}

function sendMarkdown(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.statusCode = status;
  res.setHeader("content-type", "text/markdown; charset=utf-8");
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  const maxSize = 1024 * 1024;

  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      size += chunk.byteLength;
      if (size > maxSize) {
        tooLarge = true;
        reject(new CodexAuthBadRequestError("Request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function authGuideMarkdown(): string {
  return [
    "# Codex OpenAI Proxy Auth",
    "",
    "This proxy uses one service-wide Codex identity for all `/v1` requests. Client API keys authenticate callers to the proxy only; they are not forwarded to Codex.",
    "",
    "Changing Codex credentials restarts the underlying Codex app-server connection. Active `/v1` requests can fail during that restart.",
    "",
    "## Check Status",
    "",
    "```bash",
    'curl -H "Authorization: Bearer $CODEX_OPENAI_PROXY_API_KEY" \\',
    "  https://proxy.example.com/auth/status",
    "```",
    "",
    "## Start Device Login",
    "",
    "```bash",
    'curl -X POST -H "Authorization: Bearer $CODEX_OPENAI_PROXY_API_KEY" \\',
    "  https://proxy.example.com/auth/device",
    "```",
    "",
    "Open the returned `verification_uri`, enter the returned `user_code`, then poll `GET /auth/device/{flow_id}` until `status` is `completed`.",
    "",
    "## Import Local Codex Auth JSON",
    "",
    "```bash",
    'curl -X POST -H "Authorization: Bearer $CODEX_OPENAI_PROXY_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    "  --data-binary @${CODEX_HOME:-$HOME/.codex}/auth.json \\",
    "  https://proxy.example.com/auth/import",
    "```",
    "",
  ].join("\n");
}
