import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createOpenAICompatHandler,
  type OpenAICompatHandler,
  type OpenAICompatOptions,
} from "@usetemi/codex-sdk/openai-compat";

import type { AuthConfig, CliConfig } from "./config.js";

type JsonRecord = Record<string, unknown>;

export type ProxyServerOptions = {
  compat?: OpenAICompatOptions;
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
  const compatHandler = createOpenAICompatHandler({
    ...openAICompatOptionsFromConfig(config),
    ...options.compat,
    bearerToken: undefined,
  });

  const handler = ((req: IncomingMessage, res: ServerResponse) => {
    void handleProxyRequest(req, res, config.auth, compatHandler);
  }) as CodexOpenAIProxyHandler;

  handler.ready = async () => {
    await compatHandler.ready();
  };
  handler.close = async () => {
    await compatHandler.close();
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
  compatHandler: OpenAICompatHandler,
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

    if (url.pathname.startsWith("/v1/")) {
      if (!isAuthorized(req, auth)) {
        sendOpenAIError(res, 401, "Missing or invalid bearer token", "invalid_request_error", null);
        return;
      }

      compatHandler(req, res);
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
  compatHandler: OpenAICompatHandler,
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

function sendJson(res: ServerResponse, status: number, body: JsonRecord): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(body)}\n`);
}
