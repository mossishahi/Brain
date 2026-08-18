#!/usr/bin/env node
/**
 * Publish the editable source tree (content-src/<bundle>/) as a new release.
 *
 * A release is an annotated git tag `<bundle>/v<version>` whose tree IS the
 * bundle content — no files are copied into the repo. Publishing:
 *   1. stamps the workflow's `version` field in the source with the new
 *      bundle version;
 *   2. hashes the source tree into a git tree object (via a temporary index,
 *      leaving your branch and staging area untouched);
 *   3. commits that tree with the previous release as parent, and tags it —
 *      the tag annotation's subject line becomes the release notes served in
 *      the registry index;
 *   4. leaves distribution to the registry: its store materializes the new
 *      tag on the next rescan, and consumers see it in index.json.
 *
 * Usage: node scripts/publish-bundle.mjs <bundle> <version> [--notes "..."]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const [bundle, version] = process.argv.slice(2);
const notesFlagIndex = process.argv.indexOf("--notes");
const notes = notesFlagIndex >= 0 ? process.argv[notesFlagIndex + 1] : undefined;
if (!bundle || !version) {
  throw new Error('Usage: node scripts/publish-bundle.mjs <bundle> <version> [--notes "..."]');
}
if (!/^[A-Za-z0-9._-]+$/.test(bundle)) {
  throw new Error("bundle may contain only letters, digits, dot, dash, underscore");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`version must be plain semver (x.y.z), got "${version}"`);
}
if (notesFlagIndex >= 0 && (!notes || notes.length === 0)) {
  throw new Error("--notes requires a non-empty message");
}

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceDir = join(root, "content-src", bundle);
const tag = `${bundle}/v${version}`;

if (!existsSync(sourceDir)) {
  throw new Error(`no source tree at ${relative(root, sourceDir)}`);
}
const metaPath = join(sourceDir, "bundle.json");
if (!existsSync(metaPath)) {
  throw new Error("the source tree must carry a bundle.json (runtimeProtocol + entrypoints)");
}
const meta = JSON.parse(readFileSync(metaPath, "utf8"));
for (const path of [meta.entrypoints.workflow, ...meta.entrypoints.controls]) {
  if (!existsSync(join(sourceDir, path))) {
    throw new Error(`entrypoint "${path}" is missing from the source tree`);
  }
}
// The app floor rides into the manifest and turns away a host too old to run
// this content, so a malformed one has to fail here rather than silently
// become no floor at all.
if (
  meta.minAppVersion !== undefined &&
  !/^\d+\.\d+\.\d+$/.test(String(meta.minAppVersion))
) {
  throw new Error(
    `bundle.json minAppVersion must be a plain semver, got "${meta.minAppVersion}"`,
  );
}
if (meta.minAppVersion === undefined) {
  console.warn(
    "warning: bundle.json declares no minAppVersion — any app version will accept this " +
      "release, including one too old to bind everything the workflow names.",
  );
}

const git = (args, options = {}) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", ...options }).trim();

const published = git(["tag", "-l", `${bundle}/v*`])
  .split("\n")
  .filter((line) => line.length > 0)
  .map((ref) => ref.slice(`${bundle}/v`.length));
if (published.includes(version)) {
  throw new Error(`${tag} is already published — releases are immutable`);
}
const numeric = (value) => value.split(".").map(Number);
const latest = published.sort((a, b) => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
})[published.length - 1];
if (latest) {
  const [next, previous] = [numeric(version), numeric(latest)];
  const greater = next[0] !== previous[0]
    ? next[0] > previous[0]
    : next[1] !== previous[1]
      ? next[1] > previous[1]
      : next[2] > previous[2];
  if (!greater) {
    throw new Error(`version ${version} must be greater than the latest release ${latest}`);
  }
}

// 1. Stamp the workflow's bundle version in the source.
const workflowsDir = join(sourceDir, "workflows");
for (const file of readdirSync(workflowsDir)) {
  const path = join(workflowsDir, file);
  const text = readFileSync(path, "utf8");
  const declared = JSON.parse(text).version;
  if (typeof declared !== "string") throw new Error(`${file} declares no version field`);
  writeFileSync(path, text.replace(`"version": "${declared}"`, `"version": "${version}"`));
}

// 2-3. Hash the source tree, commit with the previous release as parent, tag.
const scratch = mkdtempSync(join(tmpdir(), "brain-publish-"));
let tree;
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  execFileSync("git", ["-C", root, `--work-tree=${sourceDir}`, "add", "-A"], { env });
  tree = execFileSync("git", ["-C", root, "write-tree"], { encoding: "utf8", env }).trim();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const subject = notes ?? `${bundle}@${version}`;
const parent = latest ? git(["rev-parse", `${bundle}/v${latest}^{commit}`]) : undefined;
const commit = git([
  "commit-tree",
  tree,
  ...(parent ? ["-p", parent] : []),
  "-m",
  `${bundle}@${version}\n\n${subject}`,
]);
git(["tag", "-a", tag, "-m", subject, commit]);

const dirty = git(["status", "--porcelain", relative(root, sourceDir)]);
console.log(`Published ${tag} (commit ${commit.slice(0, 12)})`);
console.log("The registry serves it after its next rescan; consumers see it in index.json.");
if (dirty.length > 0) {
  console.log(
    "note: the source tree has uncommitted changes — commit them so the branch history matches the release.",
  );
}
