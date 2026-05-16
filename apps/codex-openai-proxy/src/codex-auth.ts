import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { CliConfig } from "./config.js";

export type CodexAuthStatus = {
  authenticated: boolean;
  auth_type?: string;
  message: string;
  codex_home?: string | null;
  data_dir?: string;
  credential_source?: CodexCredentialSource;
  last_restart_at?: string | null;
  restart_count?: number;
};

export type CodexAuthImportResult = {
  status: "imported";
  restarted_codex: boolean;
};

export type CodexCredentialSource = "api_key" | "codex_home" | "managed_codex_home";

export type CodexDeviceFlowStatus = "starting" | "pending" | "completed" | "failed" | "cancelled";

export type CodexDeviceFlowSnapshot = {
  flow_id: string;
  status: CodexDeviceFlowStatus;
  started_at: string;
  updated_at: string;
  verification_uri?: string;
  user_code?: string;
  expires_at?: string;
  message?: string;
  output_lines: string[];
};

export type CodexAuthManager = {
  status(): Promise<CodexAuthStatus>;
  startDeviceFlow(): Promise<CodexDeviceFlowSnapshot>;
  getDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined>;
  cancelDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined>;
  importAuthJson(rawJson: string): Promise<CodexAuthImportResult>;
  close(): Promise<void>;
};

export class CodexAuthBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthBadRequestError";
  }
}

export class CodexAuthConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAuthConflictError";
  }
}

type CodexAuthManagerOptions = {
  onCredentialsChanged?: () => Promise<void>;
};

type DeviceFlow = CodexDeviceFlowSnapshot & {
  child: ChildProcessWithoutNullStreams | null;
  rawOutput: string;
  partialLine: string;
  restartApplied: boolean;
  resolveInstructions?: () => void;
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

const authFileName = "auth.json";
const instructionWaitMs = 5000;
const statusTimeoutMs = 10000;
const ansiPattern =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function createCodexAuthManager(
  config: CliConfig,
  options: CodexAuthManagerOptions = {},
): CodexAuthManager {
  return new CodexCliAuthManager(config, options);
}

class CodexCliAuthManager implements CodexAuthManager {
  readonly #config: CliConfig;
  readonly #onCredentialsChanged: (() => Promise<void>) | undefined;
  readonly #flows = new Map<string, DeviceFlow>();
  #activeFlowId: string | null = null;

  constructor(config: CliConfig, options: CodexAuthManagerOptions) {
    this.#config = config;
    this.#onCredentialsChanged = options.onCredentialsChanged;
  }

  async status(): Promise<CodexAuthStatus> {
    await this.#ensureCodexHome();
    const result = await runCommand(
      this.#config.codexCommand,
      ["login", "status"],
      this.#codexEnv(),
      statusTimeoutMs,
    );

    return parseLoginStatus(result);
  }

  async startDeviceFlow(): Promise<CodexDeviceFlowSnapshot> {
    await this.#ensureCodexHome();
    this.#clearInactiveActiveFlow();
    if (this.#activeFlowId) {
      throw new CodexAuthConflictError("A Codex device login flow is already active");
    }

    const now = new Date();
    const flow: DeviceFlow = {
      flow_id: randomUUID(),
      status: "starting",
      started_at: now.toISOString(),
      updated_at: now.toISOString(),
      output_lines: [],
      child: null,
      rawOutput: "",
      partialLine: "",
      restartApplied: false,
    };
    this.#flows.set(flow.flow_id, flow);
    this.#activeFlowId = flow.flow_id;

    const child = spawn(this.#config.codexCommand, ["login", "--device-auth"], {
      env: this.#codexEnv(),
      stdio: "pipe",
    });
    flow.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.#appendFlowOutput(flow, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.#appendFlowOutput(flow, chunk));
    child.once("error", (error) => {
      this.#markFlowFailed(flow, error.message);
    });
    child.once("exit", (code, signal) => {
      this.#flushFlowPartialLine(flow);
      flow.child = null;
      if (flow.status === "failed" || flow.status === "cancelled") {
        return;
      }
      if (code === 0 && flow.verification_uri && flow.user_code) {
        this.#markFlowPending(flow);
      } else {
        this.#markFlowFailed(flow, `codex login exited with ${signal ?? `code ${code ?? 1}`}`);
      }
    });

    await waitForInstructions(flow);
    if (flow.status === "starting" && flow.verification_uri && flow.user_code) {
      this.#markFlowPending(flow);
    }

    return snapshot(flow);
  }

  async getDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined> {
    const flow = this.#flows.get(flowId);
    if (!flow) {
      return undefined;
    }

    if (flow.status === "pending" || flow.status === "starting") {
      await this.#refreshPendingFlow(flow);
    }

    return snapshot(flow);
  }

  async cancelDeviceFlow(flowId: string): Promise<CodexDeviceFlowSnapshot | undefined> {
    const flow = this.#flows.get(flowId);
    if (!flow) {
      return undefined;
    }

    if (flow.status === "starting" || flow.status === "pending") {
      if (flow.child) {
        flow.child.kill("SIGTERM");
      }
      flow.status = "cancelled";
      flow.message = "Device login flow cancelled";
      flow.updated_at = new Date().toISOString();
      if (this.#activeFlowId === flow.flow_id) {
        this.#activeFlowId = null;
      }
    }

    return snapshot(flow);
  }

  async importAuthJson(rawJson: string): Promise<CodexAuthImportResult> {
    let authJson: unknown;
    try {
      authJson = JSON.parse(rawJson);
    } catch {
      throw new CodexAuthBadRequestError("Request body must be valid Codex auth JSON");
    }

    if (!isPlainObject(authJson)) {
      throw new CodexAuthBadRequestError("Codex auth JSON must be a JSON object");
    }

    await this.#ensureCodexHome();
    const authPath = path.join(this.#config.codexHome ?? "", authFileName);
    const tempPath = path.join(
      this.#config.codexHome ?? "",
      `.${authFileName}.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.writeFile(tempPath, `${JSON.stringify(authJson, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, authPath);
    await fs.chmod(authPath, 0o600);
    await this.#onCredentialsChanged?.();

    return {
      status: "imported",
      restarted_codex: true,
    };
  }

  async close(): Promise<void> {
    const activeFlow = this.#activeFlowId ? this.#flows.get(this.#activeFlowId) : undefined;
    if (activeFlow?.child) {
      activeFlow.child.kill("SIGTERM");
      activeFlow.status = "cancelled";
      activeFlow.message = "Device login flow cancelled";
      activeFlow.updated_at = new Date().toISOString();
    }
    this.#activeFlowId = null;
  }

  async #refreshPendingFlow(flow: DeviceFlow): Promise<void> {
    if (flow.expires_at && Date.parse(flow.expires_at) <= Date.now()) {
      this.#markFlowFailed(flow, "Device code expired");
      return;
    }

    const status = await this.status();
    if (!status.authenticated) {
      this.#markFlowPending(flow);
      return;
    }

    flow.status = "completed";
    flow.message = status.message;
    flow.updated_at = new Date().toISOString();
    if (this.#activeFlowId === flow.flow_id) {
      this.#activeFlowId = null;
    }
    if (!flow.restartApplied) {
      flow.restartApplied = true;
      await this.#onCredentialsChanged?.();
    }
  }

  #appendFlowOutput(flow: DeviceFlow, chunk: Buffer): void {
    const text = stripAnsi(chunk.toString("utf8"));
    flow.rawOutput += text;
    const lines = `${flow.partialLine}${text}`.split(/\r?\n/);
    flow.partialLine = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        flow.output_lines.push(trimmed);
      }
    }
    this.#parseFlowInstructions(flow);
  }

  #flushFlowPartialLine(flow: DeviceFlow): void {
    const trimmed = flow.partialLine.trim();
    if (trimmed) {
      flow.output_lines.push(trimmed);
    }
    flow.partialLine = "";
  }

  #parseFlowInstructions(flow: DeviceFlow): void {
    const urlMatch = flow.rawOutput.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      flow.verification_uri = urlMatch[0];
    }

    const codeMatch = flow.rawOutput.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/);
    if (codeMatch) {
      flow.user_code = codeMatch[0];
    }

    const expiryMatch = flow.rawOutput.match(/expires in\s+(\d+)\s+minutes?/i);
    if (expiryMatch) {
      const minutes = Number.parseInt(expiryMatch[1] ?? "0", 10);
      if (minutes > 0) {
        flow.expires_at = new Date(Date.parse(flow.started_at) + minutes * 60_000).toISOString();
      }
    }

    if (flow.verification_uri && flow.user_code) {
      flow.resolveInstructions?.();
    }
  }

  #markFlowPending(flow: DeviceFlow): void {
    flow.status = "pending";
    flow.message = "Open the verification URL and enter the device code";
    flow.updated_at = new Date().toISOString();
  }

  #markFlowFailed(flow: DeviceFlow, message: string): void {
    flow.status = "failed";
    flow.message = message;
    flow.updated_at = new Date().toISOString();
    if (this.#activeFlowId === flow.flow_id) {
      this.#activeFlowId = null;
    }
    flow.resolveInstructions?.();
  }

  #clearInactiveActiveFlow(): void {
    if (!this.#activeFlowId) {
      return;
    }

    const activeFlow = this.#flows.get(this.#activeFlowId);
    if (
      !activeFlow ||
      activeFlow.status === "completed" ||
      activeFlow.status === "failed" ||
      activeFlow.status === "cancelled"
    ) {
      this.#activeFlowId = null;
    }
  }

  async #ensureCodexHome(): Promise<void> {
    await fs.mkdir(this.#config.codexHome ?? "", { recursive: true, mode: 0o700 });
  }

  #codexEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CODEX_OPENAI_PROXY_")) {
        delete env[key];
      }
    }

    if (this.#config.codexHome) {
      env.CODEX_HOME = this.#config.codexHome;
    }
    if (this.#config.codexApiKey) {
      env.CODEX_API_KEY = this.#config.codexApiKey;
    }

    return env;
  }
}

function snapshot(flow: DeviceFlow): CodexDeviceFlowSnapshot {
  return {
    flow_id: flow.flow_id,
    status: flow.status,
    started_at: flow.started_at,
    updated_at: flow.updated_at,
    verification_uri: flow.verification_uri,
    user_code: flow.user_code,
    expires_at: flow.expires_at,
    message: flow.message,
    output_lines: [...flow.output_lines],
  };
}

function waitForInstructions(flow: DeviceFlow): Promise<void> {
  if (flow.verification_uri && flow.user_code) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, instructionWaitMs);
    flow.resolveInstructions = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function parseLoginStatus(result: CommandResult): CodexAuthStatus {
  const stdout = stripAnsi(result.stdout).trim();
  const stderr = stripAnsi(result.stderr).trim();
  const message = stdout || stderr;

  if (result.code === 0) {
    const authType = stdout.match(/^Logged in using\s+(.+)$/i)?.[1];
    return {
      authenticated: true,
      auth_type: authType,
      message: message || "Logged in",
    };
  }

  if (/not logged in/i.test(message)) {
    return {
      authenticated: false,
      message: "Not logged in",
    };
  }

  return {
    authenticated: false,
    message: message || `codex login status exited with code ${result.code ?? 1}`,
  };
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "pipe",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function stripAnsi(value: string): string {
  return value.replace(ansiPattern, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
