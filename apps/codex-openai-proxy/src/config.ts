import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { OpenAICompatOptions } from "@usetemi/codex-sdk/openai-compat";

export type StaticAuthConfig = {
  mode: "static";
  apiKeys: string[];
};

export type DisabledAuthConfig = {
  mode: "disabled";
};

export type AuthConfig = StaticAuthConfig | DisabledAuthConfig;

export type CliConfig = {
  host: string;
  port: number;
  auth: AuthConfig;
  codexCommand: string;
  dataDir: string;
  codexHome?: string;
  codexHomeSource: "explicit" | "managed";
  codexApiKey?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  sandbox: NonNullable<OpenAICompatOptions["sandbox"]>;
  approvalPolicy: Extract<NonNullable<OpenAICompatOptions["approvalPolicy"]>, string>;
};

type FlagName =
  | "api-key"
  | "approval-policy"
  | "auth"
  | "codex-api-key"
  | "codex-command"
  | "codex-home"
  | "cwd"
  | "data-dir"
  | "host"
  | "model"
  | "model-provider"
  | "port"
  | "sandbox";

type ParsedFlags = Partial<Record<FlagName, string[]>>;

const flagNames = new Set<FlagName>([
  "api-key",
  "approval-policy",
  "auth",
  "codex-api-key",
  "codex-command",
  "codex-home",
  "cwd",
  "data-dir",
  "host",
  "model",
  "model-provider",
  "port",
  "sandbox",
]);

const sandboxValues = new Set(["read-only", "workspace-write", "danger-full-access"]);
const approvalPolicyValues = new Set(["untrusted", "on-failure", "on-request", "never"]);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseCliConfig(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): CliConfig {
  const flags = parseFlags(argv);
  const host = flagValue(flags, "host") ?? envValue(env.CODEX_OPENAI_PROXY_HOST) ?? "127.0.0.1";
  const port = parsePort(
    flagValue(flags, "port") ??
      envValue(env.CODEX_OPENAI_PROXY_PORT) ??
      envValue(env.PORT) ??
      "8080",
  );
  const sandbox = parseSandbox(
    flagValue(flags, "sandbox") ?? envValue(env.CODEX_OPENAI_PROXY_SANDBOX) ?? "read-only",
  );
  const approvalPolicy = parseApprovalPolicy(
    flagValue(flags, "approval-policy") ??
      envValue(env.CODEX_OPENAI_PROXY_APPROVAL_POLICY) ??
      "never",
  );
  const dataDir =
    flagValue(flags, "data-dir") ?? envValue(env.CODEX_OPENAI_PROXY_DATA_DIR) ?? defaultDataDir();
  const explicitCodexHome = flagValue(flags, "codex-home") ?? envValue(env.CODEX_HOME);
  const codexHome = explicitCodexHome ?? path.join(dataDir, "codex-home");

  return {
    host,
    port,
    auth: parseAuthConfig(flags, env, host),
    codexCommand:
      flagValue(flags, "codex-command") ??
      envValue(env.CODEX_OPENAI_PROXY_CODEX_COMMAND) ??
      "codex",
    dataDir,
    codexHome,
    codexHomeSource: explicitCodexHome ? "explicit" : "managed",
    codexApiKey: flagValue(flags, "codex-api-key") ?? envValue(env.CODEX_API_KEY),
    cwd: flagValue(flags, "cwd") ?? envValue(env.CODEX_OPENAI_PROXY_CWD),
    model: flagValue(flags, "model") ?? envValue(env.CODEX_OPENAI_PROXY_MODEL),
    modelProvider:
      flagValue(flags, "model-provider") ?? envValue(env.CODEX_OPENAI_PROXY_MODEL_PROVIDER),
    sandbox,
    approvalPolicy,
  };
}

export function isHelpRequest(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function formatUsage(): string {
  return [
    "Usage: codex-openai-proxy [options]",
    "",
    "Options:",
    "  --host <host>                 Listen host (default: 127.0.0.1)",
    "  --port <port>                 Listen port (default: 8080)",
    "  --api-key <token>             Accepted client bearer token; repeat or comma-separate",
    "  --auth disabled              Disable proxy bearer-token checks",
    "  --codex-command <command>     Codex executable (default: codex)",
    "  --codex-home <path>           CODEX_HOME for the Codex subprocess",
    "  --codex-api-key <token>       CODEX_API_KEY for the Codex subprocess",
    "  --data-dir <path>             Managed proxy data directory",
    "  --cwd <path>                  Working directory for Codex turns",
    "  --model <model>               Default Codex model",
    "  --model-provider <provider>   Default Codex model provider",
    "  --sandbox <mode>              read-only, workspace-write, or danger-full-access",
    "  --approval-policy <policy>    untrusted, on-failure, on-request, or never",
    "  -h, --help                    Show this help",
  ].join("\n");
}

function defaultDataDir(): string {
  return path.join(os.homedir(), ".local", "share", "codex-openai-proxy");
}

function parseFlags(argv: readonly string[]): ParsedFlags {
  const flags: ParsedFlags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new ConfigError(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const rawName = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!flagNames.has(rawName as FlagName)) {
      throw new ConfigError(`Unknown option: --${rawName}`);
    }

    const name = rawName as FlagName;
    const value =
      equalsIndex === -1 ? readNextFlagValue(argv, (index += 1), name) : arg.slice(equalsIndex + 1);
    flags[name] = [...(flags[name] ?? []), value];
  }

  return flags;
}

function readNextFlagValue(argv: readonly string[], index: number, name: FlagName): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new ConfigError(`Expected a value after --${name}`);
  }

  return value;
}

function flagValue(flags: ParsedFlags, name: FlagName): string | undefined {
  const values = flags[name];
  if (!values?.length) {
    return undefined;
  }

  if (values.length > 1 && name !== "api-key") {
    throw new ConfigError(`Option --${name} can only be provided once`);
  }

  return envValue(values.at(-1));
}

function envValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`Port must be an integer from 1 to 65535: ${value}`);
  }

  const port = Number.parseInt(value, 10);
  if (port < 1 || port > 65535) {
    throw new ConfigError(`Port must be an integer from 1 to 65535: ${value}`);
  }

  return port;
}

function parseSandbox(value: string): CliConfig["sandbox"] {
  if (!sandboxValues.has(value)) {
    throw new ConfigError(`Unsupported sandbox mode: ${value}`);
  }

  return value as CliConfig["sandbox"];
}

function parseApprovalPolicy(value: string): CliConfig["approvalPolicy"] {
  if (!approvalPolicyValues.has(value)) {
    throw new ConfigError(`Unsupported approval policy: ${value}`);
  }

  return value as CliConfig["approvalPolicy"];
}

function parseAuthConfig(flags: ParsedFlags, env: NodeJS.ProcessEnv, host: string): AuthConfig {
  const authMode = flagValue(flags, "auth") ?? envValue(env.CODEX_OPENAI_PROXY_AUTH);
  if (authMode !== undefined && authMode !== "disabled") {
    throw new ConfigError(`Unsupported auth mode: ${authMode}`);
  }

  const apiKeys = parseApiKeys(flags, env);
  if (authMode === "disabled") {
    if (apiKeys.length > 0) {
      throw new ConfigError("Cannot combine disabled auth with configured proxy API keys");
    }

    return { mode: "disabled" };
  }

  if (apiKeys.length > 0) {
    return { mode: "static", apiKeys };
  }

  if (isLoopbackHost(host)) {
    return { mode: "disabled" };
  }

  throw new ConfigError(
    `Refusing to bind ${host} without proxy auth; set CODEX_OPENAI_PROXY_API_KEYS or --auth disabled`,
  );
}

function parseApiKeys(flags: ParsedFlags, env: NodeJS.ProcessEnv): string[] {
  const flagKeys = flags["api-key"];
  if (flagKeys?.length) {
    return splitList(flagKeys);
  }

  return splitList([env.CODEX_OPENAI_PROXY_API_KEYS ?? ""]);
}

function splitList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of values) {
    for (const item of value.split(",")) {
      const trimmed = item.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        keys.push(trimmed);
      }
    }
  }

  return keys;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost") {
    return true;
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const [firstOctet] = normalized.split(".");
    return firstOctet === "127";
  }

  if (ipVersion === 6) {
    return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  }

  return false;
}
