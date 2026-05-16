import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import type {
  CodexOptions,
  Input,
  RunResult,
  RunStreamedResult,
  ThreadError,
  ThreadEvent,
  ThreadOptions as UpstreamThreadOptions,
  TurnOptions,
} from "@openai/codex-sdk";

export type {
  AgentMessageItem,
  ApprovalMode,
  CodexOptions,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  Input,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  McpToolCallItem,
  ModelReasoningEffort,
  ReasoningItem,
  RunResult,
  RunStreamedResult,
  SandboxMode,
  ThreadError,
  ThreadErrorEvent,
  ThreadEvent,
  ThreadItem,
  ThreadStartedEvent,
  TodoListItem,
  TurnCompletedEvent,
  TurnFailedEvent,
  TurnOptions,
  TurnStartedEvent,
  Usage,
  UserInput,
  WebSearchItem,
  WebSearchMode,
} from "@openai/codex-sdk";

export type ThreadOptions = UpstreamThreadOptions & {
  /**
   * Run the thread without persisting session files to disk.
   *
   * Ephemeral sessions are intended for one-shot workloads. Callers should not
   * depend on resuming them later.
   */
  ephemeral?: boolean;
};

type CodexConfig = CodexOptions["config"];

type CodexExecRunArgs = {
  input: string;
  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  model?: ThreadOptions["model"];
  sandboxMode?: ThreadOptions["sandboxMode"];
  workingDirectory?: ThreadOptions["workingDirectory"];
  skipGitRepoCheck?: ThreadOptions["skipGitRepoCheck"];
  outputSchemaFile?: string;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  signal?: AbortSignal;
  networkAccessEnabled?: ThreadOptions["networkAccessEnabled"];
  webSearchMode?: ThreadOptions["webSearchMode"];
  webSearchEnabled?: ThreadOptions["webSearchEnabled"];
  approvalPolicy?: ThreadOptions["approvalPolicy"];
  additionalDirectories?: ThreadOptions["additionalDirectories"];
  ephemeral?: ThreadOptions["ephemeral"];
};

type OutputSchemaFile = {
  schemaPath?: string;
  cleanup: () => Promise<void>;
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";
const CODEX_NPM_NAME = "@openai/codex";
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};
const moduleRequire = createRequire(import.meta.url);

async function createOutputSchemaFile(schema: unknown): Promise<OutputSchemaFile> {
  if (schema === undefined) {
    return {
      cleanup: async () => {},
    };
  }

  if (!isPlainObject(schema)) {
    throw new Error("outputSchema must be a plain JSON object");
  }

  const schemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-output-schema-"));
  const schemaPath = path.join(schemaDir, "schema.json");
  const cleanup = async () => {
    try {
      await fs.rm(schemaDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for temporary structured-output schema files.
    }
  };

  try {
    await fs.writeFile(schemaPath, JSON.stringify(schema), "utf8");
    return { schemaPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function normalizeInput(input: Input): { prompt: string; images: string[] } {
  if (typeof input === "string") {
    return { prompt: input, images: [] };
  }

  const promptParts: string[] = [];
  const images: string[] = [];
  for (const item of input) {
    if (item.type === "text") {
      promptParts.push(item.text);
    } else if (item.type === "local_image") {
      images.push(item.path);
    }
  }

  return { prompt: promptParts.join("\n\n"), images };
}

class CodexExec {
  readonly #executablePath: string;
  readonly #envOverride: Record<string, string> | undefined;
  readonly #configOverrides: CodexConfig;

  constructor(
    executablePath: string | null | undefined,
    env: Record<string, string> | undefined,
    configOverrides: CodexConfig,
  ) {
    this.#executablePath = executablePath ?? findCodexPath();
    this.#envOverride = env;
    this.#configOverrides = configOverrides;
  }

  async *run(args: CodexExecRunArgs): AsyncGenerator<string> {
    const commandArgs = ["exec", "--experimental-json"];

    if (this.#configOverrides) {
      for (const override of serializeConfigOverrides(this.#configOverrides)) {
        commandArgs.push("--config", override);
      }
    }

    if (args.baseUrl) {
      commandArgs.push(
        "--config",
        `openai_base_url=${toTomlValue(args.baseUrl, "openai_base_url")}`,
      );
    }
    if (args.model) {
      commandArgs.push("--model", args.model);
    }
    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }
    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }
    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push("--add-dir", dir);
      }
    }
    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }
    if (args.ephemeral) {
      commandArgs.push("--ephemeral");
    }
    if (args.outputSchemaFile) {
      commandArgs.push("--output-schema", args.outputSchemaFile);
    }
    if (args.modelReasoningEffort) {
      commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    }
    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`,
      );
    }
    if (args.webSearchMode) {
      commandArgs.push("--config", `web_search="${args.webSearchMode}"`);
    } else if (args.webSearchEnabled === true) {
      commandArgs.push("--config", `web_search="live"`);
    } else if (args.webSearchEnabled === false) {
      commandArgs.push("--config", `web_search="disabled"`);
    }
    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }
    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }
    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }

    const env: Record<string, string> = {};
    if (this.#envOverride) {
      Object.assign(env, this.#envOverride);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey;
    }

    const child = spawn(this.#executablePath, commandArgs, {
      env,
      signal: args.signal,
    });
    let spawnError: Error | null = null;
    child.once("error", (error) => {
      spawnError = error;
    });

    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();

    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }

    const stderrChunks: Buffer[] = [];
    if (child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        stderrChunks.push(data);
      });
    }

    const exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }> =
      new Promise((resolve) => {
        child.once("exit", (code, signal) => {
          resolve({ code, signal });
        });
      });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) {
        throw spawnError;
      }
      const { code, signal } = await exitPromise;
      if (code !== 0 || signal) {
        const stderrBuffer = Buffer.concat(stderrChunks);
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(`Codex Exec exited with ${detail}: ${stderrBuffer.toString("utf8")}`);
      }
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) {
          child.kill();
        }
      } catch {
        // Ignore cleanup races with process exit.
      }
    }
  }
}

function serializeConfigOverrides(configOverrides: CodexConfig): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, "", overrides);
  return overrides;
}

function flattenConfigOverrides(value: unknown, prefix: string, overrides: string[]): void {
  if (!isPlainObject(value)) {
    if (prefix) {
      overrides.push(`${prefix}=${toTomlValue(value, prefix)}`);
      return;
    }

    throw new Error("Codex config overrides must be a plain object");
  }

  const entries = Object.entries(value);
  if (!prefix && entries.length === 0) {
    return;
  }
  if (prefix && entries.length === 0) {
    overrides.push(`${prefix}={}`);
    return;
  }

  for (const [key, child] of entries) {
    if (!key) {
      throw new Error("Codex config override keys must be non-empty strings");
    }
    if (child === undefined) {
      continue;
    }

    const configPath = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(child)) {
      flattenConfigOverrides(child, configPath, overrides);
    } else {
      overrides.push(`${configPath}=${toTomlValue(child, configPath)}`);
    }
  }
}

function toTomlValue(value: unknown, configPath: string): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Codex config override at ${configPath} must be a finite number`);
    }
    return `${value}`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    const rendered = value.map((item, index) => toTomlValue(item, `${configPath}[${index}]`));
    return `[${rendered.join(", ")}]`;
  }
  if (isPlainObject(value)) {
    const parts: string[] = [];
    for (const [key, child] of Object.entries(value)) {
      if (!key) {
        throw new Error("Codex config override keys must be non-empty strings");
      }
      if (child === undefined) {
        continue;
      }
      parts.push(`${formatTomlKey(key)} = ${toTomlValue(child, `${configPath}.${key}`)}`);
    }
    return `{${parts.join(", ")}}`;
  }
  if (value === null) {
    throw new Error(`Codex config override at ${configPath} cannot be null`);
  }

  throw new Error(`Unsupported Codex config override value at ${configPath}: ${typeof value}`);
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY.test(key) ? key : JSON.stringify(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findCodexPath(): string {
  const { platform, arch } = process;
  let targetTriple: string | null = null;
  switch (platform) {
    case "linux":
    case "android":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-unknown-linux-musl";
          break;
        case "arm64":
          targetTriple = "aarch64-unknown-linux-musl";
          break;
        default:
          break;
      }
      break;
    case "darwin":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-apple-darwin";
          break;
        case "arm64":
          targetTriple = "aarch64-apple-darwin";
          break;
        default:
          break;
      }
      break;
    case "win32":
      switch (arch) {
        case "x64":
          targetTriple = "x86_64-pc-windows-msvc";
          break;
        case "arm64":
          targetTriple = "aarch64-pc-windows-msvc";
          break;
        default:
          break;
      }
      break;
    default:
      break;
  }

  if (!targetTriple) {
    throw new Error(`Unsupported platform: ${platform} (${arch})`);
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`Unsupported target triple: ${targetTriple}`);
  }

  let vendorRoot: string;
  try {
    const codexPackageJsonPath = moduleRequire.resolve(`${CODEX_NPM_NAME}/package.json`);
    const codexRequire = createRequire(codexPackageJsonPath);
    const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
    vendorRoot = path.join(path.dirname(platformPackageJsonPath), "vendor");
  } catch {
    throw new Error(
      `Unable to locate Codex CLI binaries. Ensure ${CODEX_NPM_NAME} is installed with optional dependencies.`,
    );
  }

  const archRoot = path.join(vendorRoot, targetTriple);
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";
  return path.join(archRoot, "codex", codexBinaryName);
}

/** Represent a thread of conversation with the agent. One thread can have multiple consecutive turns. */
export class Thread {
  readonly #exec: CodexExec;
  readonly #options: CodexOptions;
  #id: string | null;
  readonly #threadOptions: ThreadOptions;

  /** Returns the ID of the thread. Populated after the first turn starts. */
  get id(): string | null {
    return this.#id;
  }

  constructor(
    exec: CodexExec,
    options: CodexOptions,
    threadOptions: ThreadOptions,
    id: string | null = null,
  ) {
    this.#exec = exec;
    this.#options = options;
    this.#id = id;
    this.#threadOptions = threadOptions;
  }

  /** Provides the input to the agent and streams events as they are produced during the turn. */
  async runStreamed(input: Input, turnOptions: TurnOptions = {}): Promise<RunStreamedResult> {
    return { events: this.#runStreamedInternal(input, turnOptions) };
  }

  async *#runStreamedInternal(
    input: Input,
    turnOptions: TurnOptions = {},
  ): AsyncGenerator<ThreadEvent> {
    const { schemaPath, cleanup } = await createOutputSchemaFile(turnOptions.outputSchema);
    const { prompt, images } = normalizeInput(input);
    const options = this.#threadOptions;
    const generator = this.#exec.run({
      input: prompt,
      baseUrl: this.#options.baseUrl,
      apiKey: this.#options.apiKey,
      threadId: this.#id,
      images,
      model: options.model,
      sandboxMode: options.sandboxMode,
      workingDirectory: options.workingDirectory,
      skipGitRepoCheck: options.skipGitRepoCheck,
      outputSchemaFile: schemaPath,
      modelReasoningEffort: options.modelReasoningEffort,
      signal: turnOptions.signal,
      networkAccessEnabled: options.networkAccessEnabled,
      webSearchMode: options.webSearchMode,
      webSearchEnabled: options.webSearchEnabled,
      approvalPolicy: options.approvalPolicy,
      additionalDirectories: options.additionalDirectories,
      ephemeral: options.ephemeral,
    });

    try {
      for await (const item of generator) {
        let parsed: ThreadEvent;
        try {
          parsed = JSON.parse(item) as ThreadEvent;
        } catch (error) {
          throw new Error(`Failed to parse item: ${item}`, { cause: error });
        }

        if (parsed.type === "thread.started") {
          this.#id = parsed.thread_id;
        }

        yield parsed;
      }
    } finally {
      await cleanup();
    }
  }

  /** Provides the input to the agent and returns the completed turn. */
  async run(input: Input, turnOptions: TurnOptions = {}): Promise<RunResult> {
    const generator = this.#runStreamedInternal(input, turnOptions);
    const items: RunResult["items"] = [];
    let finalResponse = "";
    let usage: RunResult["usage"] = null;
    let turnFailure: ThreadError | null = null;

    for await (const event of generator) {
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
        items.push(event.item);
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailure = event.error;
        break;
      }
    }

    if (turnFailure) {
      throw new Error(turnFailure.message);
    }

    return { items, finalResponse, usage };
  }
}

/**
 * Codex is the main class for interacting with the Codex agent.
 *
 * Use the `startThread()` method to start a new thread or `resumeThread()` to resume a previously started thread.
 */
export class Codex {
  readonly #exec: CodexExec;
  readonly #options: CodexOptions;

  constructor(options: CodexOptions = {}) {
    const { codexPathOverride, env, config } = options;
    this.#exec = new CodexExec(codexPathOverride, env, config);
    this.#options = options;
  }

  /**
   * Starts a new conversation with an agent.
   * @returns A new thread instance.
   */
  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.#exec, this.#options, options);
  }

  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.codex/sessions unless `ephemeral` is enabled.
   *
   * @param id The id of the thread to resume.
   * @returns A new thread instance.
   */
  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.#exec, this.#options, options, id);
  }
}
