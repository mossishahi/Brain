/**
 * The shared scientific taxonomy behind the registry's taxonomy_* MCP tools.
 *
 * One flat node list with parent pointers over exactly four levels
 * (domain > field > subfield > topic), held in memory and backed by ONE
 * writable document. The SEED ships as versioned bundle content
 * (content-src/brainstorm/catalog/taxonomy.json — an asset of the decomposer
 * split); on first start the server materializes it into the writable store
 * (.registry-store/taxonomy/), and from then on the store is the single live
 * version every client reads. The document carries a monotonic `revision`;
 * every read syncs against the file (cheap mtime stat) and every write
 * commits optimistically, so of two sequential requests — same user or
 * different users — the second always sees the first's updates.
 *
 * Lookup is EXACT: normalized name or curated alias, nothing else. A miss is
 * answered with word-level CANDIDATE NAMES (revise_query) for a reasoning
 * step outside this process — the server itself never infers anything.
 *
 * Ported from @brainstorm/taxonomy (brainstorm repo) so the registry stays
 * dependency-free; keep the two in sync when the algorithm changes.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** The four levels, ordered. A node's children are always the next level down. */
export const LEVELS = ["domain", "field", "subfield", "topic"] as const;
export type Level = (typeof LEVELS)[number];

export interface TaxonomyNode {
  /** Upstream OpenAlex key (`D3`, `F17`, `S1702`, `T11273`) or `C:<slug>` when curated. */
  id: string;
  level: Level;
  name: string;
  /** Absent only for domains. */
  parent?: string;
  /** Curated spellings/acronyms that should resolve to this node. */
  aliases?: string[];
  source?: "openalex" | "curated";
  note?: string;
  addedAt?: string;
}

export interface TaxonomyDocument {
  schemaVersion: string;
  version: string;
  upstream: string;
  seededFrom?: string;
  /** Monotonic write counter — bumped by every committed mutation. */
  revision?: number;
  levels?: readonly string[];
  counts?: Record<string, number>;
  nodes: TaxonomyNode[];
}

/** Where a node sits: its ancestor chain, named per level. */
export interface Position {
  id: string;
  name: string;
  level: Level;
  path: string[];
  domain?: string;
  field?: string;
  subfield?: string;
  topic?: string;
  source: "openalex" | "curated";
  matchedOn?: "name" | "alias";
  matchedAlias?: string;
}

/**
 * The server-side processor's answer for one query: an exact position when
 * the node exists, otherwise the word-level candidate NAMES a reasoning step
 * may match against (never scores — retrieval metadata biases matching).
 */
export type ResolveResult =
  | { query: string; found: true; revision: number; position: Position }
  | {
      query: string;
      found: false;
      status: "NA";
      revision: number;
      /** Meaning-carrying words the candidate search used. */
      beta: string[];
      /** Candidate node names, alphabetized. */
      options: string[];
      /** Total candidates before the option limit was applied. */
      total: number;
    };

/** Step-2 noise list of the revise_query specification. */
const NOISE_WORDS: readonly string[] = ["advanced", "advancements", "advancement"];

/** Step-3 preposition list of the revise_query specification. */
const PREPOSITIONS: readonly string[] = [
  "in", "on", "at", "of", "for", "with", "to", "from", "by", "into",
  "onto", "over", "under", "between", "among", "across", "through", "via", "about", "against",
];

/** Articles/conjunctions; without this "and" matches thousands of catalogue names. */
const STRUCTURAL_WORDS: readonly string[] = ["a", "an", "the", "and", "or", "as", "its", "their"];

export class TaxonomyError extends Error {
  constructor(
    readonly code:
      | "empty_name"
      | "already_exists"
      | "unknown_parent"
      | "would_add_level"
      | "alias_conflict"
      | "conflict"
      | "not_found",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "TaxonomyError";
  }
}

/** Case, punctuation and spacing are noise; no stemming — variants belong in aliases. */
export function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slug(value: string): string {
  return normalize(value).replace(/ /g, "-");
}

/** Folds plural/singular search words ("Networks"/"Network"); never applied to lookups. */
function stem(word: string): string {
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

/** How many times a write retries after losing a commit race to another writer. */
const WRITE_RETRIES = 4;

export class TaxonomyGraph {
  private doc: TaxonomyDocument;
  private readonly file: string | null;
  private rev = 0;
  private mtimeMs = 0;

  private byIdIndex = new Map<string, TaxonomyNode>();
  private byNameIndex = new Map<string, TaxonomyNode>();
  private byAliasIndex = new Map<string, TaxonomyNode>();
  private childrenIndex = new Map<string, TaxonomyNode[]>();
  private wordIndex = new Map<string, TaxonomyNode[]>();

  private constructor(doc: TaxonomyDocument, file: string | null, mtimeMs: number) {
    this.doc = doc;
    this.file = file;
    this.mtimeMs = mtimeMs;
    this.rev = doc.revision ?? 1;
    this.rebuild();
  }

  static load(file: string): TaxonomyGraph {
    if (!existsSync(file)) {
      throw new TaxonomyError("not_found", `taxonomy document not found at ${file}`);
    }
    const doc = JSON.parse(readFileSync(file, "utf8")) as TaxonomyDocument;
    if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
      throw new TaxonomyError("not_found", `taxonomy document at ${file} carries no nodes`);
    }
    return new TaxonomyGraph(doc, file, statSync(file).mtimeMs);
  }

  get revision(): number {
    this.sync();
    return this.rev;
  }

  private rebuild(): void {
    this.byIdIndex = new Map();
    this.byNameIndex = new Map();
    this.byAliasIndex = new Map();
    this.childrenIndex = new Map();
    this.wordIndex = new Map();
    for (const node of this.doc.nodes) this.index(node);
  }

  /** Converge on the latest committed revision before answering (mtime stat per call). */
  private sync(): void {
    if (!this.file) return;
    let mtime: number;
    try {
      mtime = statSync(this.file).mtimeMs;
    } catch {
      return; // a concurrent committer is mid-rename; current state stays serviceable
    }
    if (mtime === this.mtimeMs) return;
    this.reloadFromDisk(mtime);
  }

  private reloadFromDisk(knownMtime?: number): void {
    if (!this.file) return;
    const doc = JSON.parse(readFileSync(this.file, "utf8")) as TaxonomyDocument;
    this.doc = doc;
    this.rev = doc.revision ?? 1;
    this.mtimeMs = knownMtime ?? statSync(this.file).mtimeMs;
    this.rebuild();
  }

  private index(node: TaxonomyNode): void {
    this.byIdIndex.set(node.id, node);
    this.byNameIndex.set(normalize(node.name), node);
    for (const alias of node.aliases ?? []) this.byAliasIndex.set(normalize(alias), node);
    if (node.parent) {
      const siblings = this.childrenIndex.get(node.parent);
      if (siblings) siblings.push(node);
      else this.childrenIndex.set(node.parent, [node]);
    }
    for (const word of new Set(tokens(node.name).map(stem))) {
      const bucket = this.wordIndex.get(word);
      if (bucket) bucket.push(node);
      else this.wordIndex.set(word, [node]);
    }
  }

  private resolveLocal(
    query: string,
  ): { node: TaxonomyNode; matchedOn: "name" | "alias"; alias?: string } | undefined {
    const needle = normalize(query);
    if (!needle) return undefined;
    const byName = this.byNameIndex.get(needle);
    if (byName) return { node: byName, matchedOn: "name" };
    const byAlias = this.byAliasIndex.get(needle);
    if (byAlias) return { node: byAlias, matchedOn: "alias", alias: query };
    return undefined;
  }

  private ancestorsLocal(id: string): TaxonomyNode[] {
    const chain: TaxonomyNode[] = [];
    let cursor = this.byIdIndex.get(id);
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.unshift(cursor);
      cursor = cursor.parent ? this.byIdIndex.get(cursor.parent) : undefined;
    }
    return chain;
  }

  private positionLocal(id: string): Position {
    const chain = this.ancestorsLocal(id);
    const self = chain[chain.length - 1];
    if (!self) throw new TaxonomyError("not_found", `no node with id ${id}`);
    const named = (level: Level): string | undefined => chain.find((n) => n.level === level)?.name;
    return {
      id: self.id,
      name: self.name,
      level: self.level,
      path: chain.map((n) => n.name),
      ...(named("domain") ? { domain: named("domain") } : {}),
      ...(named("field") ? { field: named("field") } : {}),
      ...(named("subfield") ? { subfield: named("subfield") } : {}),
      ...(named("topic") ? { topic: named("topic") } : {}),
      source: self.source ?? "openalex",
    };
  }

  /**
   * The server-side processor of a pool member: exact match when one exists,
   * otherwise word-level candidate names (revise_query), one round-trip.
   */
  resolve(query: string, optionLimit = 25): ResolveResult {
    this.sync();
    const hit = this.resolveLocal(query);
    if (hit) {
      const position = this.positionLocal(hit.node.id);
      return {
        query,
        found: true,
        revision: this.rev,
        position: {
          ...position,
          matchedOn: hit.matchedOn,
          ...(hit.alias ? { matchedAlias: hit.alias } : {}),
        },
      };
    }

    const words = query.split(" ").flatMap((word) => tokens(word));
    const beta: string[] = [];
    for (const word of words) {
      if (NOISE_WORDS.includes(word) || PREPOSITIONS.includes(word) || STRUCTURAL_WORDS.includes(word)) continue;
      if (!beta.includes(word)) beta.push(word);
    }
    const tally = new Map<string, { node: TaxonomyNode; hits: number }>();
    for (const word of beta) {
      for (const node of this.wordIndex.get(stem(word)) ?? []) {
        const entry = tally.get(node.id);
        if (entry) entry.hits += 1;
        else tally.set(node.id, { node, hits: 1 });
      }
    }
    const ranked = [...tally.values()].sort(
      (a, b) =>
        b.hits - a.hits ||
        a.node.name.length - b.node.name.length ||
        a.node.name.localeCompare(b.node.name),
    );
    const options = ranked
      .slice(0, optionLimit)
      .map((c) => c.node.name)
      .sort((a, b) => a.localeCompare(b));
    return { query, found: false, status: "NA", revision: this.rev, beta, options, total: ranked.length };
  }

  /** Names-only outline of the whole latest taxonomy (optionally one branch). */
  tree(rootId?: string): { revision: number; nodeCount: number; outline: string } {
    this.sync();
    const lines: string[] = [];
    let count = 0;
    const walk = (node: TaxonomyNode, depth: number): void => {
      lines.push(`${"  ".repeat(depth)}${node.name}`);
      count += 1;
      for (const child of [...(this.childrenIndex.get(node.id) ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        walk(child, depth + 1);
      }
    };
    if (rootId) {
      const root = this.byIdIndex.get(rootId) ?? this.resolveLocal(rootId)?.node;
      if (!root) throw new TaxonomyError("not_found", `no node matches "${rootId}"`);
      walk(root, 0);
    } else {
      for (const domain of this.doc.nodes
        .filter((n) => n.level === "domain")
        .sort((a, b) => a.name.localeCompare(b.name))) {
        walk(domain, 0);
      }
    }
    return { revision: this.rev, nodeCount: count, outline: lines.join("\n") };
  }

  stats(): {
    revision: number;
    total: number;
    byLevel: Record<Level, number>;
    curated: number;
    aliases: number;
  } {
    this.sync();
    const byLevel = { domain: 0, field: 0, subfield: 0, topic: 0 } as Record<Level, number>;
    let curated = 0;
    let aliases = 0;
    for (const node of this.doc.nodes) {
      byLevel[node.level] += 1;
      if (node.source === "curated") curated += 1;
      aliases += node.aliases?.length ?? 0;
    }
    return { revision: this.rev, total: this.doc.nodes.length, byLevel, curated, aliases };
  }

  /**
   * Inject a node under an existing parent (level = one below the parent's;
   * inserting under a topic is refused — the tree stays exactly four levels).
   * Kept for the deferred suggestion-processing step; optimistic commit.
   */
  insert(request: { name: string; parent: string; aliases?: string[]; note?: string }): {
    node: TaxonomyNode;
    position: Position;
  } {
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      this.sync();
      const name = request.name?.trim();
      if (!name) throw new TaxonomyError("empty_name", "a node name is required");
      const existing = this.resolveLocal(name);
      if (existing) {
        throw new TaxonomyError(
          "already_exists",
          `"${name}" already resolves to ${existing.node.name} (${existing.node.id})`,
          this.positionLocal(existing.node.id),
        );
      }
      const parent =
        this.byIdIndex.get(request.parent?.trim() ?? "") ??
        this.resolveLocal(request.parent ?? "")?.node;
      if (!parent) {
        throw new TaxonomyError("unknown_parent", `no node matches parent "${request.parent}"`);
      }
      const parentDepth = LEVELS.indexOf(parent.level);
      if (parentDepth === LEVELS.length - 1) {
        throw new TaxonomyError(
          "would_add_level",
          `cannot insert under the topic "${parent.name}": the taxonomy is exactly four levels`,
          this.positionLocal(parent.id),
        );
      }
      const aliases = (request.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
      for (const alias of aliases) {
        const clash = this.resolveLocal(alias);
        if (clash) {
          throw new TaxonomyError(
            "alias_conflict",
            `alias "${alias}" already resolves to ${clash.node.name} (${clash.node.id})`,
            this.positionLocal(clash.node.id),
          );
        }
      }
      const node: TaxonomyNode = {
        id: this.mintId(name),
        level: LEVELS[parentDepth + 1] as Level,
        name,
        parent: parent.id,
        ...(aliases.length ? { aliases } : {}),
        source: "curated",
        ...(request.note ? { note: request.note } : {}),
        addedAt: new Date().toISOString(),
      };
      this.doc.nodes.push(node);
      this.index(node);
      if (this.commit()) return { node, position: this.positionLocal(node.id) };
      this.reloadFromDisk();
    }
    throw new TaxonomyError("conflict", `insert of "${request.name}" kept losing commit races; try again`);
  }

  /** Attach alternative spellings to an existing node; optimistic commit. */
  addAliases(id: string, aliases: readonly string[]): Position {
    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      this.sync();
      const node = this.byIdIndex.get(id);
      if (!node) throw new TaxonomyError("not_found", `no node with id ${id}`);
      const additions: string[] = [];
      for (const raw of aliases) {
        const alias = raw.trim();
        if (!alias) continue;
        const clash = this.resolveLocal(alias);
        if (clash && clash.node.id !== id) {
          throw new TaxonomyError(
            "alias_conflict",
            `alias "${alias}" already resolves to ${clash.node.name} (${clash.node.id})`,
            this.positionLocal(clash.node.id),
          );
        }
        if (!clash) additions.push(alias);
      }
      if (!additions.length) return this.positionLocal(id);
      node.aliases = [...(node.aliases ?? []), ...additions];
      for (const alias of additions) this.byAliasIndex.set(normalize(alias), node);
      if (this.commit()) return this.positionLocal(id);
      this.reloadFromDisk();
    }
    throw new TaxonomyError("conflict", `alias update on ${id} kept losing commit races; try again`);
  }

  private mintId(name: string): string {
    const base = `C:${slug(name)}`;
    if (!this.byIdIndex.has(base)) return base;
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${n}`;
      if (!this.byIdIndex.has(candidate)) return candidate;
    }
  }

  /** Optimistic commit: refuse when the file moved past the revision this write saw. */
  private commit(): boolean {
    if (!this.file) {
      this.rev += 1;
      this.doc.revision = this.rev;
      return true;
    }
    try {
      if (statSync(this.file).mtimeMs !== this.mtimeMs) return false;
    } catch {
      return false;
    }
    this.doc.revision = this.rev + 1;
    const staging = `${this.file}.staging-${process.pid}`;
    writeFileSync(staging, `${JSON.stringify(this.doc, null, 2)}\n`, "utf8");
    renameSync(staging, this.file);
    this.rev = this.doc.revision;
    this.mtimeMs = statSync(this.file).mtimeMs;
    return true;
  }
}

export interface TaxonomySuggestion {
  /** The pool member the decision is about. */
  readonly term: string;
  /** matched | place | already_present — the decision kind the client reached. */
  readonly kind: string;
  /** Structured decision payload as the client recorded it. */
  readonly detail?: unknown;
}

export interface TaxonomyServiceOptions {
  /** The versioned seed shipped with the content (bundle catalog asset). */
  readonly seedPath: string;
  /** Writable live store directory (materialized from the seed on first start). */
  readonly storeDir: string;
}

/**
 * The registry's taxonomy service: one live graph materialized from the
 * bundle seed, plus an append-only suggestion queue. Suggestion PROCESSING is
 * deliberately absent — queued decisions do not change the tree yet.
 */
export class TaxonomyService {
  readonly graph: TaxonomyGraph;
  private readonly suggestionsFile: string;

  constructor(options: TaxonomyServiceOptions) {
    const storeFile = join(options.storeDir, "taxonomy.json");
    if (!existsSync(storeFile)) {
      if (!existsSync(options.seedPath)) {
        throw new TaxonomyError("not_found", `taxonomy seed not found at ${options.seedPath}`);
      }
      mkdirSync(dirname(storeFile), { recursive: true });
      copyFileSync(options.seedPath, storeFile);
    }
    this.graph = TaxonomyGraph.load(storeFile);
    this.suggestionsFile = join(options.storeDir, "suggestions.jsonl");
  }

  resolve(query: string, optionLimit?: number): ResolveResult {
    return this.graph.resolve(query, optionLimit);
  }

  tree(root?: string): { revision: number; nodeCount: number; outline: string } {
    return this.graph.tree(root);
  }

  stats(): ReturnType<TaxonomyGraph["stats"]> {
    return this.graph.stats();
  }

  /**
   * Queue one batch of placement decisions. Append-only: an id and receipt
   * are returned so the submitting run can be traced; nothing is applied.
   */
  suggest(entries: readonly TaxonomySuggestion[], submittedBy?: string): {
    id: string;
    receivedAt: string;
    revision: number;
    queued: number;
  } {
    const id = randomUUID();
    const receivedAt = new Date().toISOString();
    const revision = this.graph.revision;
    mkdirSync(dirname(this.suggestionsFile), { recursive: true });
    appendFileSync(
      this.suggestionsFile,
      `${JSON.stringify({ id, receivedAt, revision, submittedBy: submittedBy ?? "", entries })}\n`,
      "utf8",
    );
    return { id, receivedAt, revision, queued: entries.length };
  }
}
