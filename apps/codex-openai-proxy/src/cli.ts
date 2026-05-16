#!/usr/bin/env node
import type { Server } from "node:http";

import { ConfigError, formatUsage, isHelpRequest, parseCliConfig } from "./config.js";
import { createCodexOpenAIProxyServer } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (isHelpRequest(argv)) {
    console.log(formatUsage());
    return;
  }

  const config = parseCliConfig(argv);
  const server = createCodexOpenAIProxyServer(config);
  await listen(server, config.host, config.port);

  console.error(
    `codex-openai-proxy listening on http://${formatHost(config.host)}:${config.port}/v1`,
  );

  const shutdown = async () => {
    await closeServer(server);
  };
  process.once("SIGINT", () => {
    void shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().then(() => process.exit(0));
  });
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`codex-openai-proxy: ${error.message}`);
    console.error("");
    console.error(formatUsage());
    process.exitCode = 2;
    return;
  }

  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
