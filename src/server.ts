import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { TaxonomyError, TaxonomyService, type TaxonomySuggestion } from "./taxonomy.js";

/**
 * This process is deliberately a generic static-file transport. It does not
 * parse skill front matter, validate workflows, resolve dependencies, render
 * templates, choose tools, or execute anything. Those responsibilities belong
 * to the host runtime.
 */

/** Version of this registry server process (also announced over MCP). */
const REGISTRY_SERVER_NAME = "brain-content-registry";
const REGISTRY_SERVER_VERSION = "0.1.0";

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
  /**
   * Trust the last X-Forwarded-For hop for rate-limit keying. Defaults to
   * trusting it only when the immediate peer is loopback (the documented
   * reverse-proxy deployment); set false to always key on the socket address.
   */
  readonly trustProxy?: boolean;
  /** Close MCP sessions idle for longer than this. Defaults to 30 minutes. */
  readonly sessionIdleTimeoutSeconds?: number;
  /** Emits structured access records; disabled by default. */
  readonly accessLog?: (record: ContentRegistryAccessRecord) => void;
  /**
   * Versioned taxonomy seed (a bundle catalog asset). Default:
   * `<repoRoot>/content-src/brainstorm/catalog/taxonomy.json`. The taxonomy
   * tools are served only when this file (or an existing store) is present.
   */
  readonly taxonomySeedPath?: string;
  /**
   * Writable directory holding the LIVE taxonomy store (materialized from the
   * seed on first start) and the append-only suggestion queue. Default:
   * `<store>/taxonomy` — inside `.registry-store`, the one deploy-writable
   * path; excluded from the served static file tree.
   */
  readonly taxonomyStoreDir?: string;
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
  /** Whether the taxonomy_* MCP tools are being served (seed or store present). */
  readonly taxonomyEnabled: boolean;
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

/**
 * The rate-limit key for a request.
 *
 * A reverse proxy APPENDS the peer it saw to any client-supplied
 * X-Forwarded-For, so only the LAST hop is trustworthy — the leading elements
 * are whatever the client sent. Reading the first element (as this once did) let
 * any client rotate a fabricated address per request, which both bypassed the
 * limit entirely and grew the window map with arbitrary attacker-chosen keys.
 *
 * The header is consulted ONLY when the immediate peer is a trusted proxy;
 * otherwise the socket address is the only thing worth keying on.
 */
function remoteAddress(req: IncomingMessage, trustProxy: boolean): string {
  const socketAddress = req.socket.remoteAddress ?? "unknown";
  if (!trustProxy) return socketAddress;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    const hops = forwarded.split(",");
    const nearest = hops[hops.length - 1]!.trim();
    if (nearest.length > 0) return nearest;
  }
  return socketAddress;
}

/** Whether the immediate peer is a loopback address, i.e. a local reverse proxy. */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
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
function materializerArgs(repoRoot: string, storeRoot: string, fetchTags: boolean): string[] {
  return [
    fileURLToPath(new URL("../../scripts/materialize-store.mjs", import.meta.url)),
    "--repo",
    repoRoot,
    "--store",
    storeRoot,
    "--quiet",
    ...(fetchTags ? ["--fetch"] : []),
  ];
}

/** Synchronous materialization, used once at startup before the port opens. */
function materializeStore(repoRoot: string, storeRoot: string, fetchTags: boolean): boolean {
  const before = readIndexText(storeRoot);
  execFileSync(process.execPath, materializerArgs(repoRoot, storeRoot, fetchTags), {
    stdio: ["ignore", "ignore", "inherit"],
  });
  return readIndexText(storeRoot) !== before;
}

const execFileAsync = promisify(execFile);

/**
 * Off-request materialization. The rescan spawns a child process and — with
 * fetchTags — performs a NETWORK git fetch, so running it inside a request
 * handler stalled the whole single-threaded server for its full duration and
 * queued every concurrent request behind it. Refreshes now run on a timer and
 * requests are always answered from the store as it currently stands
 * (stale-while-revalidate).
 */
async function materializeStoreAsync(
  repoRoot: string,
  storeRoot: string,
  fetchTags: boolean,
  timeoutMs: number,
): Promise<boolean> {
  const before = readIndexText(storeRoot);
  await execFileAsync(process.execPath, materializerArgs(repoRoot, storeRoot, fetchTags), {
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
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
      // The live taxonomy store shares .registry-store (the one writable
      // deploy path) but is mutable state served through the taxonomy tools,
      // never as immutable static content.
      if (current === root && entry.name === "taxonomy") return [];
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

interface ServedBundle {
  readonly id: string;
  readonly latest: string;
  readonly versions: readonly string[];
  readonly releases?: Readonly<Record<string, { readonly notes?: string }>>;
}

/** The bundles the serving store's index currently lists. */
function readServedBundles(contentRoot: string): readonly ServedBundle[] {
  try {
    const index = JSON.parse(
      readFileSync(join(contentRoot, "index.json"), "utf8"),
    ) as { bundles?: ServedBundle[] };
    return Array.isArray(index.bundles) ? index.bundles : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The human landing page at `/`: what this server is, its version, the
 * bundle versions it serves (latest first, with release notes), and where
 * the machine interfaces live. This is where the app's brain icon links to.
 */
function landingPage(
  bundles: readonly ServedBundle[],
  fileCount: number,
  taxonomy: TaxonomyService | null,
): string {
  const bundleRows = bundles
    .map((bundle) => {
      const versions = [...bundle.versions].reverse();
      const rows = versions
        .map((version) => {
          const notes = bundle.releases?.[version]?.notes ?? "";
          const latest = version === bundle.latest;
          return (
            `<tr${latest ? ' class="latest"' : ""}>` +
            `<td><code>${escapeHtml(bundle.id)}@${escapeHtml(version)}</code>` +
            `${latest ? ' <span class="tag">latest</span>' : ""}</td>` +
            `<td>${escapeHtml(notes)}</td></tr>`
          );
        })
        .join("");
      return rows;
    })
    .join("");
  let taxonomyLine = "";
  if (taxonomy) {
    try {
      const stats = taxonomy.stats();
      taxonomyLine =
        `<p class="dim">Live shared taxonomy: revision ${stats.revision} · ` +
        `${stats.total} nodes · ${stats.curated} curated · ${stats.aliases} aliases</p>`;
    } catch {
      taxonomyLine = "";
    }
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brain Registry</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .dim { color: color-mix(in srgb, currentColor 55%, transparent); }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  td { border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 8px 10px 8px 0; vertical-align: top; }
  tr.latest td { font-weight: 600; }
  .tag { font-size: 11px; font-weight: 600; border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px; margin-left: 6px; }
  code { font-size: 13px; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Brain Registry</h1>
<p class="dim">${REGISTRY_SERVER_NAME} v${REGISTRY_SERVER_VERSION} · immutable skill/workflow bundles + the live shared taxonomy · ${fileCount} files served</p>
<table><tbody>${bundleRows || '<tr><td class="dim">no published bundles</td><td></td></tr>'}</tbody></table>
${taxonomyLine}
<p class="dim">Machine interfaces: <a href="/v1/index.json">/v1/index.json</a> · <a href="/health">/health</a> · MCP at <code>/mcp</code>. Published versions are immutable; the Brain app resolves the latest one automatically for every new run.</p>
</body>
</html>
`;
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

/** The taxonomy tools served next to the content resources. */
const TAXONOMY_TOOLS = [
  {
    name: "taxonomy_resolve",
    description:
      "Server-side processor for one expertise query against the LIVE shared taxonomy " +
      "(domain > field > subfield > topic). Checks for an exact match on a node name or " +
      "curated alias; when none exists, runs the deterministic revise_query candidate " +
      "search and returns candidate NAMES only (alphabetized, no scores). Every answer " +
      "carries the taxonomy revision it was computed against.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The research area to locate." },
        optionLimit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum candidate names on a miss (default 25).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "taxonomy_tree",
    description:
      "The whole latest taxonomy as a names-only indented outline (indent depth encodes " +
      "the level), stamped with the revision it was read at. Optional `root` (node id or " +
      "exact name) exports one branch. This is the reference a placement reasoning step " +
      "reads — it always reflects every user's committed edits.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Node id or exact name to export the subtree of." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "taxonomy_embeddings",
    description:
      "The node-embedding index of the LIVE taxonomy's current revision: node metadata " +
      "(id, name, level, parent) parallel to L2-normalized vectors, plus the embedder " +
      "manifest (id, dimension, thresholds, verification vectors). Computed and cached " +
      "server-side so every client matches queries in the exact same space; clients cache " +
      "the payload per revision and MUST verify their local embedder against the " +
      "manifest's verification table before trusting their own query vectors.",
    inputSchema: {
      type: "object",
      properties: {
        knownRevision: {
          type: "integer",
          minimum: 1,
          description:
            "The revision the client already has cached; when it matches the live " +
            "revision the payload is elided (unchanged: true).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "taxonomy_suggest",
    description:
      "Save one run's placement decisions for the shared taxonomy as their own " +
      "<time>-<user>.json suggestion file. Entries are recorded with a receipt id and the " +
      "revision they were decided against, and are NOT applied to the tree — suggestion " +
      "processing is a separate, later concern.",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          maxItems: 400,
          items: {
            type: "object",
            properties: {
              term: { type: "string", description: "The pool member the decision is about." },
              kind: { type: "string", description: "matched | place | already_present." },
              detail: { description: "Structured decision payload as the client recorded it." },
            },
            required: ["term", "kind"],
            additionalProperties: false,
          },
        },
        submittedBy: { type: "string", description: "Opaque client/run identifier." },
      },
      required: ["entries"],
      additionalProperties: false,
    },
  },
] as const;

function toolResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function createProtocolServer(
  contentRoot: string,
  getFiles: () => ReadonlyMap<string, StaticFile>,
  refresh: () => void,
  taxonomy: TaxonomyService | null,
): Server {
  const server = new Server(
    { name: REGISTRY_SERVER_NAME, version: REGISTRY_SERVER_VERSION },
    {
      capabilities: {
        resources: { listChanged: true },
        ...(taxonomy ? { tools: {} } : {}),
      },
    },
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

  if (taxonomy) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TAXONOMY_TOOLS.map((tool) => ({ ...tool })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        switch (request.params.name) {
          case "taxonomy_resolve": {
            if (typeof args.query !== "string" || args.query.trim() === "") {
              throw new Error("taxonomy_resolve requires a non-empty query string");
            }
            const limit = typeof args.optionLimit === "number" ? args.optionLimit : undefined;
            return toolResult(taxonomy.resolve(args.query, limit));
          }
          case "taxonomy_tree": {
            const root = typeof args.root === "string" && args.root.trim() !== "" ? args.root : undefined;
            return toolResult(taxonomy.tree(root));
          }
          case "taxonomy_embeddings": {
            const embeddings = taxonomy.embeddings();
            const known =
              typeof args.knownRevision === "number" ? args.knownRevision : undefined;
            if (known !== undefined && known === embeddings.revision) {
              return toolResult({ revision: embeddings.revision, unchanged: true });
            }
            return toolResult(embeddings);
          }
          case "taxonomy_suggest": {
            if (!Array.isArray(args.entries)) {
              throw new Error("taxonomy_suggest requires an entries array");
            }
            const entries = args.entries as TaxonomySuggestion[];
            for (const entry of entries) {
              if (typeof entry?.term !== "string" || typeof entry?.kind !== "string") {
                throw new Error("every suggestion entry requires term and kind strings");
              }
            }
            const submittedBy = typeof args.submittedBy === "string" ? args.submittedBy : undefined;
            return toolResult(taxonomy.suggest(entries, submittedBy));
          }
          default:
            throw new Error(`unknown tool "${request.params.name}"`);
        }
      } catch (error) {
        const payload =
          error instanceof TaxonomyError
            ? { ok: false, code: error.code, message: error.message }
            : { ok: false, code: "error", message: error instanceof Error ? error.message : String(error) };
        return { ...toolResult(payload), isError: true };
      }
    });
  }

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
  const trustProxy = options.trustProxy;
  const sessionIdleMs = (options.sessionIdleTimeoutSeconds ?? 1800) * 1000;
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

  // The LIVE shared taxonomy: materialized from the versioned seed into the
  // writable store on first start, then served through the taxonomy_* tools.
  // One service instance for the whole process — every session answers from
  // the same single, revision-counted document.
  const taxonomySeedPath = resolve(
    options.taxonomySeedPath ??
      join(repoRoot, "content-src", "brainstorm", "catalog", "taxonomy.json"),
  );
  const taxonomyStoreDir = resolve(options.taxonomyStoreDir ?? join(contentRoot, "taxonomy"));
  const taxonomy =
    existsSync(join(taxonomyStoreDir, "taxonomy.json")) || existsSync(taxonomySeedPath)
      ? new TaxonomyService({ seedPath: taxonomySeedPath, storeDir: taxonomyStoreDir })
      : null;

  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server; lastSeenAt: number }
  >();
  const rateWindows = new Map<string, RateWindow>();

  // A new release tag becomes visible on the next index or resource-list
  // request after the TTL: the store gains the version, the file map is
  // rebuilt, and connected MCP clients get a resources list_changed push.
  let lastScanAt = Date.now();
  let refreshing = false;
  const refreshNow = async (): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    lastScanAt = Date.now();
    try {
      if (!(await materializeStoreAsync(repoRoot, contentRoot, fetchTags, refreshTtlMs))) return;
      files = new Map(listFiles(contentRoot).map((file) => [file.relativePath, file]));
      for (const { server } of sessions.values()) {
        void server.sendResourceListChanged();
      }
    } catch {
      // A failed rescan leaves the previous store serving; retried on the next tick.
    } finally {
      refreshing = false;
    }
  };
  /**
   * Requests never wait for a rescan: this only SCHEDULES one when the store is
   * stale and returns immediately, so the current store is served while the
   * refresh happens in the background.
   */
  const refreshIfStale = (): void => {
    if (!releaseMode || refreshing || Date.now() - lastScanAt < refreshTtlMs) return;
    void refreshNow();
  };

  const httpServer = createServer(async (req, res) => {
    const startedAt = Date.now();
    // Deployment shape: Caddy terminates TLS and proxies to loopback, so a
    // loopback peer is the trusted proxy and its appended hop is the real client.
    const address = remoteAddress(req, trustProxy ?? isLoopbackPeer(req));
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
        // ok/files stay first for existing probes; server + bundle versions
        // let consumers show exactly what is deployed and served.
        sendText(
          res,
          200,
          JSON.stringify({
            ok: true,
            files: files.size,
            server: { name: REGISTRY_SERVER_NAME, version: REGISTRY_SERVER_VERSION },
            bundles: readServedBundles(contentRoot).map((bundle) => ({
              id: bundle.id,
              latest: bundle.latest,
              versions: bundle.versions,
            })),
          }),
          "application/json; charset=utf-8",
        );
        return;
      }
      if (!allowRequest(rateWindows, address, requestsPerMinute)) {
        res.setHeader("retry-after", "60");
        sendText(res, 429, "rate limit exceeded");
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        refreshIfStale();
        const body = landingPage(readServedBundles(contentRoot), files.size, taxonomy);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-cache",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        res.end(body);
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
        known.lastSeenAt = Date.now();
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

      const protocolServer = createProtocolServer(contentRoot, () => files, refreshIfStale, taxonomy);
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server: protocolServer, lastSeenAt: Date.now() });
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
    // One background timer owns both periodic duties. Sessions are otherwise
    // only removed on a clean transport close, so abandoned ones (a sleeping
    // laptop, a dropped network, a SIGKILLed worker) accumulated until
    // maxSessions was exhausted and every new client got a 503 until restart.
    const maintenance = setInterval(() => {
      refreshIfStale();
      const cutoff = Date.now() - sessionIdleMs;
      for (const [id, session] of sessions) {
        if (session.lastSeenAt > cutoff) continue;
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    }, Math.min(refreshTtlMs, 60_000));
    maintenance.unref();
    httpServer.once("close", () => clearInterval(maintenance));

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
    taxonomyEnabled: taxonomy !== null,
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
