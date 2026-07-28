import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * This process is deliberately a generic static-file transport. It does not
 * parse skill front matter, validate workflows, resolve dependencies, render
 * templates, choose tools, or execute anything. Those responsibilities belong
 * to the host runtime.
 */

export interface ContentRegistryServerOptions {
  readonly port?: number;
  readonly host?: string;
  /**
   * Serve this directory statically (must contain index.json and bundles/),
   * with no git involvement. When omitted, the server runs in release mode:
   * it materializes the store from the repo's release tags at startup and
   * rescans for new tags on a TTL.
   */
  readonly contentRoot?: string;
  /** Git repository whose `<bundle>/v<semver>` tags are the releases. */
  readonly repoRoot?: string;
  /** Seconds between release-tag rescans in release mode. Default 60. */
  readonly refreshTtlSeconds?: number;
  /**
   * Fetch tags from the repo's remote before each rescan (best effort).
   * Enable on deployments that serve a clone of the publishing repo.
   */
  readonly fetchTags?: boolean;
  /** Per-client request ceiling in a rolling minute. Default 300. */
  readonly requestsPerMinute?: number;
  /** Maximum JSON request body accepted by MCP. Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Maximum simultaneous MCP sessions. Default 500. */
  readonly maxSessions?: number;
  /** Emits structured access records; disabled by default. */
  readonly accessLog?: (record: ContentRegistryAccessRecord) => void;
}

export interface ContentRegistryAccessRecord {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly remoteAddress: string;
  readonly status: number;
  readonly durationMs: number;
}

export interface RunningContentRegistryServer {
  readonly port: number;
  readonly host: string;
  /** HTTP API base URL (MCP is available at `${url}/mcp`). */
  readonly url: string;
  readonly mcpUrl: string;
  readonly contentRoot: string;
  readonly fileCount: number;
  readonly httpServer: HttpServer;
  close(): Promise<void>;
}

interface StaticFile {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly mediaType: string;
}

interface RateWindow {
  count: number;
  resetAt: number;
}

function remoteAddress(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]!.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function allowRequest(
  windows: Map<string, RateWindow>,
  address: string,
  limit: number,
  now = Date.now(),
): boolean {
  const current = windows.get(address);
  if (!current || current.resetAt <= now) {
    windows.set(address, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

/** The repo this server was built from — release tags live here. */
export function defaultRepoRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

/**
 * The serving store: version trees materialized from release tags. Content
 * of published versions is immutable, so the store is append-only cache.
 */
export function defaultContentRoot(): string {
  return join(defaultRepoRoot(), ".registry-store");
}

/**
 * Materializes any release tags missing from the store and rewrites its
 * index. Returns true when the store changed. Delegates to the same script
 * used by CI and the app test suites, so there is exactly one materializer.
 */
function materializeStore(repoRoot: string, storeRoot: string, fetchTags: boolean): boolean {
  const before = readIndexText(storeRoot);
  execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("../../scripts/materialize-store.mjs", import.meta.url)),
      "--repo",
      repoRoot,
      "--store",
      storeRoot,
      "--quiet",
      ...(fetchTags ? ["--fetch"] : []),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return readIndexText(storeRoot) !== before;
}

function readIndexText(storeRoot: string): string {
  try {
    return readFileSync(join(storeRoot, "index.json"), "utf8");
  } catch {
    return "";
  }
}

function mediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function listFiles(root: string, current = root): StaticFile[] {
  return readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): StaticFile[] => {
      const absolutePath = join(current, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolutePath);
      if (!entry.isFile()) return [];
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      return [{
        relativePath,
        absolutePath,
        bytes: statSync(absolutePath).size,
        mediaType: mediaType(absolutePath),
      }];
    });
}

function safeRelativePath(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error("invalid encoded file path");
  }
  if (
    decoded.length === 0 ||
    isAbsolute(decoded) ||
    decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe file path "${decoded}"`);
  }
  return decoded;
}

function resolveStaticFile(
  contentRoot: string,
  files: ReadonlyMap<string, StaticFile>,
  relativePath: string,
): StaticFile {
  const safe = safeRelativePath(relativePath);
  const file = files.get(safe);
  if (!file) throw new Error(`unknown static file "${safe}"`);
  const root = resolve(contentRoot);
  const candidate = resolve(file.absolutePath);
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`static file escapes registry root: "${safe}"`);
  }
  return file;
}

function resourceUri(relativePath: string): string {
  return `brain://file/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function pathFromResourceUri(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "brain:" || parsed.hostname !== "file") {
    throw new Error(`unsupported content-registry resource URI "${uri}"`);
  }
  return parsed.pathname.replace(/^\/+/, "");
}

function createProtocolServer(
  contentRoot: string,
  getFiles: () => ReadonlyMap<string, StaticFile>,
  refresh: () => void,
): Server {
  const server = new Server(
    { name: "brain-content-registry", version: "0.1.0" },
    { capabilities: { resources: { listChanged: true } } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    refresh();
    return {
      resources: [...getFiles().values()].map((file) => ({
        uri: resourceUri(file.relativePath),
        name: file.relativePath,
        mimeType: file.mediaType,
        size: file.bytes,
      })),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [{
      uriTemplate: "brain://file/{path}",
      name: "versioned-content-file",
      description:
        "Read one exact path from the immutable Brain Registry content tree.",
      mimeType: "application/octet-stream",
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const relativePath = pathFromResourceUri(request.params.uri);
    const file = resolveStaticFile(contentRoot, getFiles(), relativePath);
    return {
      contents: [{
        uri: request.params.uri,
        mimeType: file.mediaType,
        text: readFileSync(file.absolutePath, "utf8"),
      }],
    };
  });

  return server;
}

function readJsonBody(
  req: IncomingMessage,
  maxBodyBytes: number,
): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBodyBytes) {
        reject(new Error(`request body exceeds ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendText(
  res: ServerResponse,
  status: number,
  text: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  });
  res.end(text);
}

function sendStatic(res: ServerResponse, file: StaticFile): void {
  const body = readFileSync(file.absolutePath);
  res.writeHead(200, {
    "content-type": `${file.mediaType}; charset=utf-8`,
    "content-length": body.length,
    "cache-control": file.relativePath === "index.json"
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'",
  });
  res.end(body);
}

export async function startContentRegistryServer(
  options: ContentRegistryServerOptions = {},
): Promise<RunningContentRegistryServer> {
  const host = options.host ?? "127.0.0.1";
  const requestsPerMinute = options.requestsPerMinute ?? 300;
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const maxSessions = options.maxSessions ?? 500;
  for (const [name, value] of [
    ["requestsPerMinute", requestsPerMinute],
    ["maxBodyBytes", maxBodyBytes],
    ["maxSessions", maxSessions],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  // Static mode serves an explicit directory as-is; release mode materializes
  // the store from the repo's release tags and keeps rescanning on a TTL.
  const releaseMode = options.contentRoot === undefined;
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot());
  const refreshTtlMs = (options.refreshTtlSeconds ?? 60) * 1000;
  const fetchTags = options.fetchTags ?? false;
  const contentRoot = resolve(options.contentRoot ?? defaultContentRoot());
  if (releaseMode) {
    materializeStore(repoRoot, contentRoot, fetchTags);
  }
  let files = new Map(listFiles(contentRoot).map((file) => [file.relativePath, file]));
  if (!files.has("index.json")) {
    throw new Error(`content registry has no index.json below "${contentRoot}"`);
  }

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();
  const rateWindows = new Map<string, RateWindow>();

  // A new release tag becomes visible on the next index or resource-list
  // request after the TTL: the store gains the version, the file map is
  // rebuilt, and connected MCP clients get a resources list_changed push.
  let lastScanAt = Date.now();
  const refreshIfStale = (): void => {
    if (!releaseMode || Date.now() - lastScanAt < refreshTtlMs) return;
    lastScanAt = Date.now();
    try {
      if (!materializeStore(repoRoot, contentRoot, fetchTags)) return;
      files = new Map(listFiles(contentRoot).map((file) => [file.relativePath, file]));
      for (const { server } of sessions.values()) {
        void server.sendResourceListChanged();
      }
    } catch {
      // A failed rescan leaves the previous store serving; retried after TTL.
    }
  };

  const httpServer = createServer(async (req, res) => {
    const startedAt = Date.now();
    const address = remoteAddress(req);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.once("finish", () => {
      options.accessLog?.({
        at: new Date(startedAt).toISOString(),
        method: req.method ?? "UNKNOWN",
        path: req.url ?? "/",
        remoteAddress: address,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });
    try {
      const url = new URL(req.url ?? "/", `http://${host.includes(":") ? `[${host}]` : host}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendText(
          res,
          200,
          JSON.stringify({ ok: true, files: files.size }),
          "application/json; charset=utf-8",
        );
        return;
      }
      if (!allowRequest(rateWindows, address, requestsPerMinute)) {
        res.setHeader("retry-after", "60");
        sendText(res, 429, "rate limit exceeded");
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/")) {
        const relativePath = url.pathname === "/v1/index.json"
          ? "index.json"
          : url.pathname.slice("/v1/".length);
        if (relativePath === "index.json") refreshIfStale();
        sendStatic(res, resolveStaticFile(contentRoot, files, relativePath));
        return;
      }

      if (url.pathname !== "/mcp") {
        sendText(res, 404, "not found");
        return;
      }

      const sessionId = req.headers["mcp-session-id"];
      const known =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (known) {
        await known.transport.handleRequest(
          req,
          res,
          await readJsonBody(req, maxBodyBytes),
        );
        return;
      }
      if (sessionId !== undefined) {
        sendText(res, 404, "session not found");
        return;
      }

      if (sessions.size >= maxSessions) {
        sendText(res, 503, "too many MCP sessions");
        return;
      }
      const body = await readJsonBody(req, maxBodyBytes);
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        sendText(res, 400, "a new session must start with initialize");
        return;
      }

      const protocolServer = createProtocolServer(contentRoot, () => files, refreshIfStale);
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server: protocolServer });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await protocolServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.startsWith("unknown static file") ? 404 : 500;
        sendText(res, status, message);
      } else {
        res.end();
      }
    }
  });

  httpServer.requestTimeout = 0;
  httpServer.headersTimeout = 60_000;
  httpServer.keepAliveTimeout = 120_000;
  const rateCleanup = setInterval(() => {
    const now = Date.now();
    for (const [address, window] of rateWindows) {
      if (window.resetAt <= now) rateWindows.delete(address);
    }
  }, 300_000);
  rateCleanup.unref();

  const port = await new Promise<number>((resolvePort, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      resolvePort(typeof address === "object" && address ? address.port : 0);
    });
  });
  const printableHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${printableHost}:${port}`;

  return {
    port,
    host,
    url,
    mcpUrl: `${url}/mcp`,
    contentRoot,
    fileCount: files.size,
    httpServer,
    close: async () => {
      clearInterval(rateCleanup);
      const records = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(records.map(({ server }) => server.close()));
      await new Promise<void>((resolveClose, reject) => {
        httpServer.close((error) => error ? reject(error) : resolveClose());
        httpServer.closeAllConnections();
      });
    },
  };
}
