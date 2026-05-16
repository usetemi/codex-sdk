import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, parseCliConfig } from "../src/config.js";

test("flags override env and app-specific port overrides PORT", () => {
  const config = parseCliConfig(
    [
      "--host",
      "127.0.0.2",
      "--port",
      "7777",
      "--api-key",
      "flag-token",
      "--codex-command",
      "codex-dev",
      "--codex-home",
      "/tmp/codex-home-flag",
      "--codex-api-key",
      "codex-api-flag",
      "--data-dir",
      "/tmp/proxy-data-flag",
      "--cwd",
      "/tmp/project",
      "--model",
      "codex-mini",
      "--model-provider",
      "openai",
      "--sandbox",
      "workspace-write",
      "--approval-policy",
      "on-request",
    ],
    {
      CODEX_OPENAI_PROXY_HOST: "0.0.0.0",
      CODEX_OPENAI_PROXY_PORT: "6666",
      PORT: "5555",
      CODEX_OPENAI_PROXY_API_KEYS: "env-token",
      CODEX_OPENAI_PROXY_CODEX_COMMAND: "codex-env",
      CODEX_HOME: "/tmp/codex-home-env",
      CODEX_API_KEY: "codex-api-env",
      CODEX_OPENAI_PROXY_DATA_DIR: "/tmp/proxy-data-env",
      CODEX_OPENAI_PROXY_CWD: "/tmp/env-project",
      CODEX_OPENAI_PROXY_MODEL: "env-model",
      CODEX_OPENAI_PROXY_MODEL_PROVIDER: "env-provider",
      CODEX_OPENAI_PROXY_SANDBOX: "danger-full-access",
      CODEX_OPENAI_PROXY_APPROVAL_POLICY: "never",
    },
  );

  assert.equal(config.host, "127.0.0.2");
  assert.equal(config.port, 7777);
  assert.deepEqual(config.auth, { mode: "static", apiKeys: ["flag-token"] });
  assert.equal(config.codexCommand, "codex-dev");
  assert.equal(config.codexHome, "/tmp/codex-home-flag");
  assert.equal(config.codexHomeSource, "explicit");
  assert.equal(config.codexApiKey, "codex-api-flag");
  assert.equal(config.dataDir, "/tmp/proxy-data-flag");
  assert.equal(config.cwd, "/tmp/project");
  assert.equal(config.model, "codex-mini");
  assert.equal(config.modelProvider, "openai");
  assert.equal(config.sandbox, "workspace-write");
  assert.equal(config.approvalPolicy, "on-request");
});

test("port falls back to CODEX_OPENAI_PROXY_PORT before PORT", () => {
  const config = parseCliConfig([], {
    CODEX_OPENAI_PROXY_PORT: "6666",
    PORT: "5555",
  });

  assert.equal(config.port, 6666);
});

test("invalid ports are rejected", () => {
  for (const port of ["0", "abc", "65536"]) {
    assert.throws(() => parseCliConfig(["--port", port], {}), ConfigError);
  }
});

test("invalid auth config is rejected", () => {
  assert.throws(
    () => parseCliConfig(["--auth", "disabled", "--api-key", "token"], {}),
    /Cannot combine disabled auth/,
  );
  assert.throws(
    () => parseCliConfig([], { CODEX_OPENAI_PROXY_AUTH: "required" }),
    /Unsupported auth mode/,
  );
});

test("non-loopback binds require proxy auth or explicit disabled auth", () => {
  assert.throws(
    () => parseCliConfig(["--host", "0.0.0.0"], {}),
    /Refusing to bind 0\.0\.0\.0 without proxy auth/,
  );

  assert.deepEqual(parseCliConfig(["--host", "0.0.0.0", "--auth", "disabled"], {}).auth, {
    mode: "disabled",
  });
  assert.deepEqual(
    parseCliConfig(["--host", "0.0.0.0"], { CODEX_OPENAI_PROXY_API_KEYS: "a,b" }).auth,
    {
      mode: "static",
      apiKeys: ["a", "b"],
    },
  );
});

test("loopback default permits local unauthenticated use", () => {
  const config = parseCliConfig([], {});

  assert.equal(config.host, "127.0.0.1");
  assert.deepEqual(config.auth, { mode: "disabled" });
  assert.match(config.dataDir, /codex-openai-proxy$/);
  assert.match(config.codexHome ?? "", /codex-openai-proxy\/codex-home$/);
  assert.equal(config.codexHomeSource, "managed");
});

test("managed codex home comes from data dir when CODEX_HOME is unset", () => {
  const config = parseCliConfig([], {
    CODEX_OPENAI_PROXY_DATA_DIR: "/tmp/proxy-data",
  });

  assert.equal(config.dataDir, "/tmp/proxy-data");
  assert.equal(config.codexHome, "/tmp/proxy-data/codex-home");
  assert.equal(config.codexHomeSource, "managed");
});
