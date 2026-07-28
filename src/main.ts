#!/usr/bin/env node
import process from "node:process";

import { startContentRegistryServer } from "./server.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`--port must be an integer from 0 to 65535, got "${raw}"`);
  }
  return port;
}

function parsePositive(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: brain-content-registry [--host 127.0.0.1] [--port 0] [--content-root ./content]",
    );
    return;
  }
  const running = await startContentRegistryServer({
    host: flag("host") ?? "127.0.0.1",
    port: parsePort(flag("port")),
    ...(flag("content-root") ? { contentRoot: flag("content-root") } : {}),
    fetchTags:
      process.argv.includes("--fetch-tags") ||
      process.env.BRAIN_REGISTRY_FETCH_TAGS === "1",
    requestsPerMinute: parsePositive(
      flag("requests-per-minute") ?? process.env.BRAIN_REGISTRY_REQUESTS_PER_MINUTE,
      300,
      "requests-per-minute",
    ),
    maxSessions: parsePositive(
      flag("max-sessions") ?? process.env.BRAIN_REGISTRY_MAX_SESSIONS,
      500,
      "max-sessions",
    ),
    ...(process.env.BRAIN_REGISTRY_ACCESS_LOG === "1"
      ? {
          accessLog: (record: unknown) => {
            console.log(JSON.stringify(record));
          },
        }
      : {}),
  });
  console.log(`CONTENT_REGISTRY_URL=${running.url}`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void running.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
