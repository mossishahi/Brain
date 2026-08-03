#!/usr/bin/env node
/**
 * Review the taxonomy suggestion queue BY PLACE.
 *
 * Reads every batch under <store>/taxonomy/suggestions/, resolves each
 * entry's anchor position against the LIVE tree, and prints the queue
 * grouped by where in the taxonomy each suggestion wants to land — so
 * curation is a walk down the tree, not a walk through submission files.
 *
 *   node scripts/review-suggestions.mjs               # inserts/places/unmatched, grouped
 *   node scripts/review-suggestions.mjs --all         # also matched/already-present echoes
 *   node scripts/review-suggestions.mjs --json        # machine-readable
 *   node scripts/review-suggestions.mjs --store DIR   # explicit .registry-store
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { TaxonomyGraph } from "../dist/src/taxonomy.js";

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const asJson = args.includes("--json");
const storeFlag = args.indexOf("--store");
const storeRoot =
  storeFlag >= 0 && args[storeFlag + 1]
    ? args[storeFlag + 1]
    : join(fileURLToPath(new URL("../", import.meta.url)), ".registry-store");

const taxonomyDir = join(storeRoot, "taxonomy");
const suggestionsDir = join(taxonomyDir, "suggestions");
if (!existsSync(suggestionsDir)) {
  console.log(`no suggestions at ${suggestionsDir}`);
  process.exit(0);
}
const graph = existsSync(join(taxonomyDir, "taxonomy.json"))
  ? TaxonomyGraph.load(join(taxonomyDir, "taxonomy.json"))
  : null;

/** The anchor path of one entry: where in the tree it wants to land. */
function anchorOf(entry) {
  const detail = entry.detail ?? {};
  const resolvePath = (name) => {
    if (typeof name !== "string" || name.trim() === "" || !graph) return undefined;
    try {
      const result = graph.resolve(name);
      return result.found ? result.position.path : undefined;
    } catch {
      return undefined;
    }
  };
  switch (entry.kind) {
    case "insert":
    case "place": {
      const parentPath = resolvePath(detail.parent);
      if (parentPath) return { path: parentPath, label: "under" };
      const nearest = Array.isArray(detail.nearest) ? detail.nearest[0] : undefined;
      if (nearest && Array.isArray(nearest.path) && nearest.path.length > 1) {
        return { path: nearest.path.slice(0, -1), label: "near" };
      }
      return { path: ["(unresolved parent)"], label: "under" };
    }
    case "already_present": {
      const nodePath = resolvePath(detail.node);
      return { path: nodePath ?? ["(unresolved node)"], label: "at" };
    }
    case "matched": {
      const path = Array.isArray(detail.position?.path) ? detail.position.path : undefined;
      return { path: path ?? ["(unknown)"], label: "at" };
    }
    default: {
      const nearest = Array.isArray(detail.nearest) ? detail.nearest[0] : undefined;
      if (nearest && Array.isArray(nearest.path) && nearest.path.length > 1) {
        return { path: nearest.path.slice(0, -1), label: "near" };
      }
      return { path: ["(unanchored)"], label: "near" };
    }
  }
}

const batches = readdirSync(suggestionsDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => {
    try {
      return { file: name, ...JSON.parse(readFileSync(join(suggestionsDir, name), "utf8")) };
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const rows = [];
for (const batch of batches) {
  for (const entry of batch.entries ?? []) {
    if (!showAll && (entry.kind === "matched" || entry.kind === "already_present")) continue;
    const anchor = anchorOf(entry);
    rows.push({
      term: entry.term,
      kind: entry.kind,
      anchor: anchor.path,
      anchorLabel: anchor.label,
      proposedName: entry.detail?.name,
      aliases: entry.detail?.aliases ?? [],
      reason: entry.detail?.reason,
      count: entry.detail?.count,
      relevance: entry.detail?.relevance,
      nearest: (entry.detail?.nearest ?? []).slice(0, 3),
      submittedBy: batch.submittedBy || "anonymous",
      receivedAt: batch.receivedAt,
      revision: batch.revision,
      file: batch.file,
    });
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(`nothing to review (${batches.length} batch file(s), all entries filtered)`);
  process.exit(0);
}

/** Group rows by their anchor path (joined), biggest groups first. */
const groups = new Map();
for (const row of rows) {
  const key = row.anchor.join(" > ");
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}
const ordered = [...groups.entries()].sort(
  (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
);

console.log(
  `${rows.length} suggestion(s) in ${batches.length} batch(es), grouped by place` +
    (graph ? ` (live revision ${graph.revision})` : " (no live tree found)"),
);
for (const [place, group] of ordered) {
  console.log(`\n■ ${place}   — ${group.length} suggestion(s)`);
  const byTerm = new Map();
  for (const row of group) {
    const bucket = byTerm.get(row.term.toLowerCase()) ?? [];
    bucket.push(row);
    byTerm.set(row.term.toLowerCase(), bucket);
  }
  for (const bucket of byTerm.values()) {
    const first = bucket[0];
    const seenIn = bucket.length;
    const evidence = [
      first.count !== undefined ? `people ${first.count}` : null,
      first.relevance !== undefined ? `relevance ${first.relevance}` : null,
      seenIn > 1 ? `seen in ${seenIn} run(s)` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    console.log(
      `  ${first.anchorLabel} ▸ ${first.kind.toUpperCase().padEnd(8)} "${first.term}"` +
        (first.proposedName && first.proposedName !== first.term
          ? ` as "${first.proposedName}"`
          : "") +
        (evidence ? `   [${evidence}]` : ""),
    );
    if (first.aliases.length > 0) console.log(`             aliases: ${first.aliases.join(", ")}`);
    if (first.reason) console.log(`             reason: ${first.reason}`);
    for (const near of first.nearest) {
      const score = typeof near.score === "number" ? near.score.toFixed(3) : "?";
      console.log(`             nearest ${score}  ${(near.path ?? [near.name]).join(" > ")}`);
    }
    const submitters = [...new Set(bucket.map((row) => row.submittedBy))];
    console.log(
      `             from ${submitters.join(", ")} · ${bucket
        .map((row) => row.receivedAt?.slice(0, 10))
        .filter(Boolean)
        .join(", ")}`,
    );
  }
}
console.log(
  "\napply with the registry's insert/alias flow; each batch file under " +
    `${suggestionsDir} can be archived once handled.`,
);
