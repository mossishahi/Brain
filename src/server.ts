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
  /** Root containing index.json and bundles/. */
  readonly contentRoot?: string;
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

export function defaultContentRoot(): string {
  return fileURLToPath(new URL("../../content/", import.meta.url));
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
  files: ReadonlyMap<string, StaticFile>,
): Server {
  const server = new Server(
    { name: "brain-content-registry", version: "0.1.0" },
    { capabilities: { resources: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...files.values()].map((file) => ({
      uri: resourceUri(file.relativePath),
      name: file.relativePath,
      mimeType: file.mediaType,
      size: file.bytes,
    })),
  }));

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
    const file = resolveStaticFile(contentRoot, files, relativePath);
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
  contentSecurityPolicy = "default-src 'none'",
): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(text),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": contentSecurityPolicy,
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

function registryLandingPage(fileCount: number): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Brain Registry</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #0c0e11;
      color: #edf4f8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      overflow: hidden;
      background:
        radial-gradient(circle at 50% 42%, rgba(64, 161, 218, .07), transparent 35%),
        #0c0e11;
    }
    main {
      width: min(680px, calc(100% - 40px));
      padding: 52px 32px 34px;
      text-align: center;
    }
    .registry-label {
      margin: 0 0 38px;
      color: #71808a;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .22em;
      text-transform: uppercase;
    }
    .brain-stage {
      position: relative;
      display: grid;
      place-items: center;
      width: 180px;
      height: 150px;
      margin: 0 auto;
    }
    .brain-stage::before {
      position: absolute;
      width: 116px;
      height: 116px;
      border-radius: 50%;
      background: rgba(91, 192, 249, .11);
      content: "";
      filter: blur(26px);
      animation: breathe 5s ease-in-out infinite;
    }
    .brain-icon {
      position: relative;
      z-index: 2;
      width: 92px;
      height: 92px;
      color: #82d2ff;
      filter: drop-shadow(0 0 12px rgba(95, 196, 250, .2));
      animation: float 6s ease-in-out infinite;
    }
    .flow {
      position: absolute;
      left: 50%;
      bottom: 15px;
      width: 150px;
      height: 1px;
      overflow: hidden;
      transform: translateX(-50%);
      background: rgba(130, 210, 255, .08);
    }
    .flow::after {
      display: block;
      width: 55%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(130, 210, 255, .65), transparent);
      content: "";
      animation: flow 4.8s ease-in-out infinite;
    }
    .type-line {
      min-height: 34px;
      margin: 24px auto 0;
      color: #a8dcf8;
      font-family: "SFMono-Regular", "Cascadia Code", "Roboto Mono", "JetBrains Mono", ui-monospace, monospace;
      font-size: clamp(14px, 2.5vw, 18px);
      font-weight: 500;
      letter-spacing: .025em;
    }
    .typewriter {
      display: inline-block;
      width: 0;
      overflow: hidden;
      border-right: 1px solid rgba(168, 220, 248, .8);
      animation:
        typing 2.9s steps(29, end) .55s forwards,
        cursor 900ms step-end infinite;
      white-space: nowrap;
    }
    .registry-meta {
      margin: 34px 0 0;
      color: #63717a;
      font-size: 12px;
      line-height: 1.7;
    }
    .registry-meta strong { color: #91a4af; font-weight: 500; }
    nav { display: flex; justify-content: center; gap: 18px; margin-top: 18px; }
    a { color: #78bddf; font-size: 12px; text-decoration: none; }
    a:hover { color: #a8dcf8; }
    @keyframes typing { to { width: 29ch; } }
    @keyframes cursor { 50% { border-color: transparent; } }
    @keyframes breathe {
      0%, 100% { opacity: .65; transform: scale(.94); }
      50% { opacity: 1; transform: scale(1.06); }
    }
    @keyframes float {
      0%, 100% { transform: translateY(1px); }
      50% { transform: translateY(-3px); }
    }
    @keyframes flow {
      0% { opacity: 0; transform: translateX(-100%); }
      22%, 78% { opacity: .8; }
      100% { opacity: 0; transform: translateX(280%); }
    }
    @media (prefers-reduced-motion: reduce) {
      .brain-stage::before, .brain-icon, .flow::after { animation: none; }
      .typewriter { width: 29ch; border-right: 0; animation: none; }
    }
  </style>
</head>
<body>
  <main>
    <p class="registry-label">Brain Registry</p>
    <div class="brain-stage">
      <svg class="brain-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"
        role="img" aria-label="Brain Registry">
        <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"></path>
        <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"></path>
        <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"></path>
        <path d="M17.599 6.5a3 3 0 0 0 .399-1.375"></path>
        <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"></path>
        <path d="M3.477 10.896a4 4 0 0 1 .585-.396"></path>
        <path d="M19.938 10.5a4 4 0 0 1 .585.396"></path>
        <path d="M6 18a4 4 0 0 1-1.967-.516"></path>
        <path d="M19.967 17.484A4 4 0 0 1 18 18"></path>
      </svg>
      <span class="flow" aria-hidden="true"></span>
    </div>
    <div class="type-line"><span class="typewriter">You owe your intellect to me!</span></div>
    <p class="registry-meta"><strong>${fileCount}</strong> immutable resources · MCP <strong>/mcp</strong></p>
    <nav><a href="/health">Health</a><a href="/v1/index.json">Content index</a></nav>
  </main>
</body>
</html>`;
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
  const contentRoot = resolve(options.contentRoot ?? defaultContentRoot());
  const listed = listFiles(contentRoot);
  const files = new Map(listed.map((file) => [file.relativePath, file]));
  if (!files.has("index.json")) {
    throw new Error(`content registry has no index.json below "${contentRoot}"`);
  }

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();
  const rateWindows = new Map<string, RateWindow>();

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

      if (req.method === "GET" && url.pathname === "/") {
        sendText(
          res,
          200,
          registryLandingPage(files.size),
          "text/html; charset=utf-8",
          "default-src 'none'; style-src 'unsafe-inline'",
        );
        return;
      }

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

      const protocolServer = createProtocolServer(contentRoot, files);
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
