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

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === "GET" || req.method === "DELETE") {
    return Promise.resolve(undefined);
  }
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
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
  });
  res.end(body);
}

export async function startContentRegistryServer(
  options: ContentRegistryServerOptions = {},
): Promise<RunningContentRegistryServer> {
  const host = options.host ?? "127.0.0.1";
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

  const httpServer = createServer(async (req, res) => {
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
        await known.transport.handleRequest(req, res, await readJsonBody(req));
        return;
      }
      if (sessionId !== undefined) {
        sendText(res, 404, "session not found");
        return;
      }

      const body = await readJsonBody(req);
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
