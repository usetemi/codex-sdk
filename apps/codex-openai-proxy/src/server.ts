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
  type CodexAuthStatus,
  type CodexCredentialSource,
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

export type CodexOpenAIProxyRestartResult = {
  status: "restarted";
  restarted_at: string;
  restart_count: number;
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
    void handleProxyRequest(req, res, config, compatHandler, authManager);
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
  config: CliConfig,
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

    if (req.method === "GET" && url.pathname === "/auth") {
      sendHtml(res, 200, authOperatorHtml());
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth.md") {
      sendMarkdown(res, 200, authGuideMarkdown());
      return;
    }

    if (url.pathname.startsWith("/auth/")) {
      if (!isAuthorized(req, config.auth)) {
        sendOpenAIError(res, 401, "Missing or invalid bearer token", "invalid_request_error", null);
        return;
      }

      await handleAuthRequest(req, res, url, config, compatHandler, authManager);
      return;
    }

    if (url.pathname.startsWith("/v1/")) {
      if (!isAuthorized(req, config.auth)) {
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
  config: CliConfig,
  compatHandler: RestartableOpenAICompatHandler,
  authManager: CodexAuthManager,
): Promise<void> {
  if (req.method === "GET" && url.pathname === "/auth/status") {
    sendJson(res, 200, enrichAuthStatus(await authManager.status(), config, compatHandler));
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/restart") {
    sendJson(res, 200, await compatHandler.restart());
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

function enrichAuthStatus(
  status: CodexAuthStatus,
  config: CliConfig,
  compatHandler: RestartableOpenAICompatHandler,
): CodexAuthStatus {
  return {
    ...status,
    codex_home: config.codexHome ?? null,
    data_dir: config.dataDir,
    credential_source: credentialSource(config),
    last_restart_at: compatHandler.lastRestartAt,
    restart_count: compatHandler.restartCount,
  };
}

function credentialSource(config: CliConfig): CodexCredentialSource {
  if (config.codexApiKey) {
    return "api_key";
  }

  return config.codexHomeSource === "managed" ? "managed_codex_home" : "codex_home";
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
  #lastRestartAt: string | null = null;
  #restartCount = 0;

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

  get lastRestartAt(): string | null {
    return this.#lastRestartAt;
  }

  get restartCount(): number {
    return this.#restartCount;
  }

  async restart(): Promise<CodexOpenAIProxyRestartResult> {
    const previous = this.#handler;
    this.#handler = this.#createHandler();
    const restartedAt = new Date().toISOString();
    this.#lastRestartAt = restartedAt;
    this.#restartCount += 1;
    try {
      await previous.close();
    } catch {
      // Credential updates should not fail because the old app-server was already gone.
    }
    return {
      status: "restarted",
      restarted_at: restartedAt,
      restart_count: this.#restartCount,
    };
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

function sendHtml(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
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

function authOperatorHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="icon" href="data:,">
    <title>Codex Proxy Auth</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --text: #1d2430;
        --muted: #5e6a78;
        --line: #d9dee7;
        --accent: #2563eb;
        --accent-contrast: #ffffff;
        --danger: #b42318;
        --ok: #067647;
        --code: #0f172a;
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #101418;
          --panel: #171c22;
          --text: #e6eaf0;
          --muted: #9aa5b1;
          --line: #2b333d;
          --accent: #6ea8fe;
          --accent-contrast: #0f172a;
          --danger: #ff9c8f;
          --ok: #75d2a3;
          --code: #0b0f14;
        }
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family:
          ui-sans-serif,
          system-ui,
          -apple-system,
          BlinkMacSystemFont,
          "Segoe UI",
          sans-serif;
        line-height: 1.45;
      }

      main {
        width: min(920px, calc(100% - 32px));
        margin: 0 auto;
        padding: 32px 0 48px;
      }

      header {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: end;
        justify-content: space-between;
        margin-bottom: 24px;
      }

      h1,
      h2 {
        margin: 0;
        line-height: 1.15;
      }

      h1 {
        font-size: 32px;
      }

      h2 {
        font-size: 18px;
      }

      p {
        margin: 6px 0 0;
        color: var(--muted);
      }

      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: 1fr;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 16px;
      }

      .span-2 {
        grid-column: 1 / -1;
      }

      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
        font-weight: 600;
      }

      input,
      textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: transparent;
        color: var(--text);
        font: inherit;
        padding: 10px 12px;
      }

      textarea {
        min-height: 180px;
        resize: vertical;
        font-family:
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
        font-size: 13px;
      }

      button {
        min-height: 38px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--panel);
        color: var(--text);
        font: inherit;
        font-weight: 650;
        padding: 8px 12px;
        cursor: pointer;
      }

      button.primary {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--accent-contrast);
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.55;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .token-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: end;
      }

      .flow {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }

      .flow-output {
        display: grid;
        gap: 12px;
        grid-template-columns: 1fr;
      }

      .code-row {
        display: grid;
        gap: 8px;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: stretch;
      }

      .code {
        overflow-wrap: anywhere;
        border-radius: 6px;
        background: var(--code);
        color: #f8fafc;
        padding: 10px 12px;
        font-family:
          ui-monospace,
          SFMono-Regular,
          Menlo,
          Consolas,
          monospace;
        font-size: 13px;
      }

      .code-copy-target {
        border: 1px solid transparent;
        cursor: pointer;
        user-select: all;
      }

      .code-copy-target:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      .copy-message {
        min-height: 20px;
        margin-top: 6px;
        font-size: 13px;
        font-weight: 650;
      }

      details {
        display: grid;
        gap: 12px;
      }

      summary {
        cursor: pointer;
        font-size: 18px;
        font-weight: 700;
        line-height: 1.15;
      }

      details[open] pre {
        margin-top: 12px;
      }

      pre {
        min-height: 220px;
        max-height: 520px;
        overflow: auto;
        margin: 0;
        border-radius: 6px;
        background: var(--code);
        color: #f8fafc;
        padding: 12px;
        font-size: 13px;
        line-height: 1.5;
      }

      .status {
        margin-top: 10px;
        font-weight: 650;
      }

      .status.ok,
      .copy-message.ok {
        color: var(--ok);
      }

      .status.error,
      .copy-message.error {
        color: var(--danger);
      }

      a {
        color: var(--accent);
      }

      @media (max-width: 760px) {
        main {
          width: min(100% - 20px, 1120px);
          padding-top: 20px;
        }

        h1 {
          font-size: 26px;
        }

        .token-row,
        .code-row {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Codex Proxy Auth</h1>
          <p>Service-wide Codex credentials for this OpenAI-compatible proxy.</p>
        </div>
        <a href="/auth.md">API guide</a>
      </header>

      <section class="panel span-2" aria-labelledby="token-heading">
        <h2 id="token-heading">Proxy Token</h2>
        <div class="token-row">
          <label>
            Bearer token
            <input id="token" type="password" autocomplete="off" spellcheck="false">
          </label>
          <button id="forget-token" type="button">Forget</button>
        </div>
        <p>Stored in sessionStorage for this tab.</p>
      </section>

      <div class="grid">
        <section class="panel" aria-labelledby="status-heading">
          <h2 id="status-heading">Status</h2>
          <div class="actions">
            <button id="status-button" class="primary" type="button">Check Status</button>
            <button id="restart-button" type="button">Restart Codex</button>
          </div>
          <p id="status-message" class="status" role="status"></p>
        </section>

        <section class="panel" aria-labelledby="device-heading">
          <h2 id="device-heading">Device Auth</h2>
          <div class="actions">
            <button id="device-button" class="primary" type="button">Start Device Auth</button>
            <button id="cancel-button" type="button" disabled>Cancel Flow</button>
          </div>
          <div class="flow" aria-live="polite">
            <div class="flow-output">
              <div>
                <p>Verification URL</p>
                <div id="verification-uri" class="code">-</div>
              </div>
              <div>
                <p>User code</p>
                <div class="code-row">
                  <div
                    id="user-code"
                    class="code code-copy-target"
                    role="button"
                    tabindex="0"
                    aria-label="Copy user code"
                  >-</div>
                  <button id="copy-code" type="button" disabled>Copy</button>
                </div>
                <p id="copy-message" class="copy-message" role="status"></p>
              </div>
            </div>
            <p id="device-message" class="status" role="status"></p>
          </div>
        </section>

        <section class="panel" aria-labelledby="import-heading">
          <h2 id="import-heading">Import Auth JSON</h2>
          <label>
            auth.json
            <textarea id="auth-json" spellcheck="false"></textarea>
          </label>
          <div class="actions">
            <input id="auth-file" type="file" accept=".json,application/json">
            <button id="import-button" class="primary" type="button">Import</button>
          </div>
          <p id="import-message" class="status" role="status"></p>
        </section>

        <section class="panel" aria-labelledby="response-heading">
          <details id="response-details">
            <summary id="response-heading">Response JSON</summary>
            <pre id="response-output">{}</pre>
          </details>
        </section>
      </div>
    </main>
    <script>
      const storageKey = 'codex-openai-proxy-token';
      const tokenInput = document.querySelector('#token');
      const forgetTokenButton = document.querySelector('#forget-token');
      const statusButton = document.querySelector('#status-button');
      const restartButton = document.querySelector('#restart-button');
      const deviceButton = document.querySelector('#device-button');
      const cancelButton = document.querySelector('#cancel-button');
      const copyCodeButton = document.querySelector('#copy-code');
      const importButton = document.querySelector('#import-button');
      const authFileInput = document.querySelector('#auth-file');
      const authJsonInput = document.querySelector('#auth-json');
      const responseOutput = document.querySelector('#response-output');
      const statusMessage = document.querySelector('#status-message');
      const deviceMessage = document.querySelector('#device-message');
      const importMessage = document.querySelector('#import-message');
      const verificationUri = document.querySelector('#verification-uri');
      const userCode = document.querySelector('#user-code');
      const copyMessage = document.querySelector('#copy-message');
      let activeFlowId = null;
      let pollTimer = null;

      tokenInput.value = sessionStorage.getItem(storageKey) || '';
      tokenInput.addEventListener('input', () => {
        sessionStorage.setItem(storageKey, tokenInput.value);
      });
      forgetTokenButton.addEventListener('click', () => {
        sessionStorage.removeItem(storageKey);
        tokenInput.value = '';
      });

      statusButton.addEventListener('click', () => {
        void refreshStatus();
      });
      restartButton.addEventListener('click', () => {
        void restartCodex();
      });
      deviceButton.addEventListener('click', () => {
        void startDeviceAuth();
      });
      cancelButton.addEventListener('click', () => {
        void cancelDeviceAuth();
      });
      copyCodeButton.addEventListener('click', () => {
        void copyUserCode();
      });
      userCode.addEventListener('click', () => {
        void copyUserCode();
      });
      userCode.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void copyUserCode();
        }
      });
      importButton.addEventListener('click', () => {
        void importAuthJson();
      });
      authFileInput.addEventListener('change', async () => {
        const file = authFileInput.files && authFileInput.files[0];
        if (file) {
          authJsonInput.value = await file.text();
        }
      });

      function token() {
        const value = tokenInput.value.trim();
        if (value) {
          sessionStorage.setItem(storageKey, value);
        }
        return value;
      }

      async function request(path, options) {
        const headers = new Headers((options && options.headers) || {});
        const bearer = token();
        if (/^bearer\\s+/i.test(bearer)) {
          showResponse({
            error: {
              message: 'Paste the token value without the Bearer prefix',
            },
          });
          throw new Error(
            'Paste only the proxy token in Proxy Token. Do not include the Bearer prefix.',
          );
        }
        if (bearer) {
          headers.set('authorization', 'Bearer ' + bearer);
        }
        const response = await fetch(path, {
          ...options,
          headers,
        });
        const text = await response.text();
        let body;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        showResponse(body);
        if (!response.ok) {
          let message =
            body && body.error && body.error.message
              ? body.error.message
              : 'HTTP ' + response.status;
          if (response.status === 401) {
            message = bearer
              ? 'The proxy rejected this token. Check that you pasted the current proxy token without the Bearer prefix, then retry.'
              : 'Paste the proxy token in Proxy Token, token only, no Bearer prefix, then retry.';
          }
          throw new Error(message);
        }
        return body;
      }

      function showResponse(body) {
        responseOutput.textContent =
          typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      }

      function setMessage(element, message, kind) {
        element.textContent = message || '';
        element.classList.toggle('ok', kind === 'ok');
        element.classList.toggle('error', kind === 'error');
      }

      function setCopyMessage(message, kind) {
        copyMessage.textContent = message || '';
        copyMessage.classList.toggle('ok', kind === 'ok');
        copyMessage.classList.toggle('error', kind === 'error');
      }

      async function refreshStatus() {
        setMessage(statusMessage, 'Checking...', '');
        try {
          const body = await request('/auth/status');
          setMessage(
            statusMessage,
            body.authenticated ? 'Authenticated' : body.message || 'Not authenticated',
            body.authenticated ? 'ok' : 'error',
          );
        } catch (error) {
          setMessage(statusMessage, error.message, 'error');
        }
      }

      async function restartCodex() {
        setMessage(statusMessage, 'Restarting...', '');
        try {
          const body = await request('/auth/restart', { method: 'POST' });
          setMessage(statusMessage, 'Restarted at ' + body.restarted_at, 'ok');
          await refreshStatus();
        } catch (error) {
          setMessage(statusMessage, error.message, 'error');
        }
      }

      async function startDeviceAuth() {
        clearPoll();
        setFlow(null);
        setMessage(deviceMessage, 'Starting...', '');
        try {
          const body = await request('/auth/device', { method: 'POST' });
          setFlow(body);
          pollFlow(body);
        } catch (error) {
          setMessage(deviceMessage, error.message, 'error');
        }
      }

      async function cancelDeviceAuth() {
        if (!activeFlowId) {
          return;
        }
        clearPoll();
        setMessage(deviceMessage, 'Cancelling...', '');
        try {
          const body = await request('/auth/device/' + encodeURIComponent(activeFlowId) + '/cancel', {
            method: 'POST',
          });
          setFlow(body);
        } catch (error) {
          setMessage(deviceMessage, error.message, 'error');
        }
      }

      async function pollFlow(flow) {
        if (!flow || terminalFlow(flow)) {
          return;
        }
        activeFlowId = flow.flow_id;
        cancelButton.disabled = false;
        pollTimer = setTimeout(async () => {
          try {
            const body = await request('/auth/device/' + encodeURIComponent(activeFlowId));
            setFlow(body);
            await pollFlow(body);
          } catch (error) {
            setMessage(deviceMessage, error.message, 'error');
          }
        }, 2500);
      }

      function setFlow(flow) {
        activeFlowId = flow && flow.flow_id ? flow.flow_id : null;
        cancelButton.disabled = !activeFlowId || terminalFlow(flow);
        verificationUri.textContent = flow && flow.verification_uri ? flow.verification_uri : '-';
        userCode.textContent = flow && flow.user_code ? flow.user_code : '-';
        copyCodeButton.disabled = !(flow && flow.user_code);
        setCopyMessage('', '');
        if (flow && flow.verification_uri) {
          verificationUri.innerHTML = '';
          const link = document.createElement('a');
          link.href = flow.verification_uri;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.textContent = flow.verification_uri;
          verificationUri.append(link);
        }
        if (!flow) {
          setMessage(deviceMessage, '', '');
          return;
        }
        const kind = flow.status === 'completed' ? 'ok' : terminalFlow(flow) ? 'error' : '';
        setMessage(deviceMessage, flow.status + ': ' + (flow.message || ''), kind);
      }

      async function copyUserCode() {
        const code = userCode.textContent.trim();
        if (!code || code === '-') {
          return;
        }
        try {
          await navigator.clipboard.writeText(code);
          setCopyMessage('Copied user code.', 'ok');
        } catch {
          setCopyMessage('Copy failed. Select the code and copy it manually.', 'error');
        }
      }

      function terminalFlow(flow) {
        if (!flow) {
          return true;
        }
        if (flow.status === 'completed' || flow.status === 'failed' || flow.status === 'cancelled') {
          return true;
        }
        return Boolean(flow.expires_at && Date.parse(flow.expires_at) <= Date.now());
      }

      function clearPoll() {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      }

      async function importAuthJson() {
        setMessage(importMessage, 'Importing...', '');
        try {
          JSON.parse(authJsonInput.value);
          const body = await request('/auth/import', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
            },
            body: authJsonInput.value,
          });
          setMessage(importMessage, body.status || 'Imported', 'ok');
          await refreshStatus();
        } catch (error) {
          setMessage(importMessage, error.message, 'error');
        }
      }
    </script>
  </body>
</html>`;
}

function authGuideMarkdown(): string {
  return [
    "# Codex OpenAI Proxy Auth",
    "",
    "This proxy uses one service-wide Codex identity for all `/v1` requests. Client API keys authenticate callers to the proxy only; they are not forwarded to Codex.",
    "",
    "Open `/auth` in a browser for the bundled operator UI.",
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
    "## Restart Codex App Server",
    "",
    "```bash",
    'curl -X POST -H "Authorization: Bearer $CODEX_OPENAI_PROXY_API_KEY" \\',
    "  https://proxy.example.com/auth/restart",
    "```",
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
