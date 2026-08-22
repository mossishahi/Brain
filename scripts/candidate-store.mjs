#!/usr/bin/env node
/**
 * Builds a serving store that publishes an UNPUBLISHED candidate as `latest`.
 *
 * The registry's real store is materialized from release tags, so a suite that
 * resolves `latest` can only ever see versions that already shipped. That makes
 * a pre-release check against it worthless twice over: it tests the previous
 * release rather than the candidate, and the moment the candidate is tagged the
 * same suite starts resolving it — on app versions that already shipped too.
 * This builds the store the candidate WOULD produce, so the suite can be run
 * against it while the release is still cancellable.
 *
 * The store contains every published version (materialize-store.mjs extracts
 * those from their tags and rewrites index.json) plus the candidate, written
 * from the editable tree at content-src/<bundle>/ because it has no tag yet —
 * and building it must never create one, or the check would ship the thing it
 * is meant to be able to reject.
 *
 * The candidate copy is produced through git's plumbing rather than a plain
 * directory copy so it is byte-identical to what publish-bundle.mjs would tag:
 * the same .gitignore exclusions, and the same workflow version stamp (applied
 * to the extracted copy, never to your working tree).
 *
 * Prints the store path on stdout — everything else goes to stderr, so a caller
 * can do `store=$(node scripts/candidate-store.mjs brainstorm 1.2.3)` and point
 * BRAIN_TEST_REGISTRY_DIR at it. The caller owns the directory and must remove
 * it; a store created here is a throwaway, never the registry's own.
 *
 * Usage: node scripts/candidate-store.mjs <bundle> <version>
 *          [--store <dir>] [--repo <dir>] [--notes "..."] [--quiet]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, writeManifest } from "./lib/manifest.mjs";

const argv = process.argv.slice(2);
const positional = [];
const options = new Map();
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index];
  if (argument === "--quiet") options.set("quiet", "");
  else if (argument.startsWith("--")) {
    options.set(argument.slice(2), argv[index + 1]);
    index += 1;
  } else positional.push(argument);
}
const flag = (name) => options.get(name);
const [bundle, version] = positional;
const quiet = options.has("quiet");
const repo = flag("repo") ?? fileURLToPath(new URL("../", import.meta.url));
const notes = flag("notes");
const note = (message) => {
  if (!quiet) console.error(message);
};

if (!bundle || !version) {
  throw new Error(
    "Usage: node scripts/candidate-store.mjs <bundle> <version> [--store <dir>] [--quiet]",
  );
}
if (!/^[A-Za-z0-9._-]+$/.test(bundle)) {
  throw new Error("bundle may contain only letters, digits, dot, dash, underscore");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`version must be plain semver (x.y.z), got "${version}"`);
}

const sourceDir = join(repo, "content-src", bundle);
if (!existsSync(sourceDir)) {
  throw new Error(`no source tree at content-src/${bundle}`);
}
const metaPath = join(sourceDir, "bundle.json");
if (!existsSync(metaPath)) {
  throw new Error("the source tree must carry a bundle.json (runtimeProtocol + entrypoints)");
}
const meta = JSON.parse(readFileSync(metaPath, "utf8"));

const git = (args, options = {}) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", ...options }).trim();

// A published version already has a tag, so materialize-store would put the
// TAGGED tree here and this would then overwrite it with the working tree —
// a store that lies about what shipped. Releases are immutable; refuse.
if (git(["tag", "-l", `${bundle}/v${version}`]).length > 0) {
  throw new Error(`${bundle}/v${version} is already published — nothing to pre-flight`);
}

const store = flag("store") ?? mkdtempSync(join(tmpdir(), "brain-candidate-store-"));
mkdirSync(store, { recursive: true });
// A caller only learns the path from our stdout, so a half-built store we
// abandon by throwing is a temp directory nobody can ever name to delete.
// An explicit --store belongs to the caller either way.
if (flag("store") === undefined) {
  process.on("exit", (code) => {
    if (code !== 0) rmSync(store, { recursive: true, force: true });
  });
}

// Every published version, extracted from its tag, plus an index.json written
// from the full tag list. Idempotent, so an explicit --store may be reused.
execFileSync(
  process.execPath,
  [join(repo, "scripts", "materialize-store.mjs"), "--repo", repo, "--store", store, "--quiet"],
  { stdio: ["ignore", "ignore", "inherit"] },
);

// The candidate itself. `git add -A` against a temporary index applies the
// repo's ignore rules without touching your branch or staging area, exactly as
// publish-bundle.mjs does; archiving the resulting tree gives the same bytes a
// tag would carry, minus the tag.
const target = join(store, "bundles", bundle, version);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "brain-candidate-index-"));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  execFileSync("git", ["-C", repo, `--work-tree=${sourceDir}`, "add", "-A"], { env });
  const tree = execFileSync("git", ["-C", repo, "write-tree"], { encoding: "utf8", env }).trim();
  const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", tree], {
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", target], { input: archive });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Publishing stamps the workflow's bundle version before hashing, and the
// stamp is inside the hashed bytes — so the candidate must carry it or its
// manifest describes content that will never be served. Stamped in the
// extracted copy: this script must leave the editable tree exactly as it
// found it, because the release it is checking may still be abandoned.
const workflowsDir = join(target, "workflows");
for (const file of readdirSync(workflowsDir)) {
  const path = join(workflowsDir, file);
  const text = readFileSync(path, "utf8");
  const declared = JSON.parse(text).version;
  if (typeof declared !== "string") throw new Error(`${file} declares no version field`);
  writeFileSync(path, text.replace(`"version": "${declared}"`, `"version": "${version}"`));
}

writeManifest(
  target,
  buildManifest(target, {
    bundle,
    version,
    runtimeProtocol: meta.runtimeProtocol,
    entrypoints: meta.entrypoints,
    minAppVersion: meta.minAppVersion,
  }),
);

// Publish the candidate as `latest` — the whole point, since that is what a new
// run resolves and what the app suite asserts against.
const indexPath = join(store, "index.json");
const index = JSON.parse(readFileSync(indexPath, "utf8"));
let entry = index.bundles.find((candidate) => candidate.id === bundle);
if (!entry) {
  entry = { id: bundle, latest: version, versions: [], releases: {} };
  index.bundles.push(entry);
}
entry.versions = [...entry.versions, version].sort((a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
});
if (entry.versions[entry.versions.length - 1] !== version) {
  // publish-bundle refuses a version that is not greater than the latest
  // release, so a store where the candidate is not the highest is a store no
  // real publish could ever produce. Fail rather than hand back a fiction.
  throw new Error(
    `version ${version} is not greater than the latest published release ` +
      `${entry.versions[entry.versions.length - 1]}`,
  );
}
entry.latest = version;
entry.releases = { ...entry.releases, [version]: { notes: notes ?? `${bundle}@${version}` } };
writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

note(
  `candidate store: ${bundle}@${version} is latest over ` +
    `${entry.versions.length - 1} published version(s)`,
);
console.log(store);
