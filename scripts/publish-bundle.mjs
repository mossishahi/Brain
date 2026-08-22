#!/usr/bin/env node
/**
 * Publish the editable source tree (content-src/<bundle>/) as a new release.
 *
 * A release is an annotated git tag `<bundle>/v<version>` whose tree IS the
 * bundle content — no files are copied into the repo. Publishing:
 *   0. gates on the app's full test suite run against a store in which THIS
 *      candidate is `latest`, and then CONFIRMS from the receipt the suite
 *      leaves behind that it really executed the candidate (see the
 *      --no-app-check note below);
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
 * The gate exists because a release changes the test inputs of app versions
 * that ALREADY shipped: their suites resolve whatever the registry index calls
 * `latest`, so a bundle can turn a released app red after the fact. The only
 * moment that is still cheap to fix is before the tag exists — hence step 0,
 * and hence its refusal to be skipped by accident.
 *
 * Usage: node scripts/publish-bundle.mjs <bundle> <version> [--notes "..."]
 *          [--app <dir>] [--no-app-check]
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
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { confirmSuiteRanCandidate, RECEIPT_FILE } from "./lib/receipt.mjs";

const [bundle, version] = process.argv.slice(2);
const notesFlagIndex = process.argv.indexOf("--notes");
const notes = notesFlagIndex >= 0 ? process.argv[notesFlagIndex + 1] : undefined;
const appFlagIndex = process.argv.indexOf("--app");
const appOverride = appFlagIndex >= 0 ? process.argv[appFlagIndex + 1] : undefined;
const skipAppCheck = process.argv.includes("--no-app-check");
if (!bundle || !version) {
  throw new Error(
    'Usage: node scripts/publish-bundle.mjs <bundle> <version> [--notes "..."] ' +
      "[--app <dir>] [--no-app-check]",
  );
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
if (appFlagIndex >= 0 && (!appOverride || appOverride.startsWith("--"))) {
  throw new Error("--app requires the path to an app checkout");
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

// 0. Gate on the app suite, run against a store where this candidate is
// `latest`. Everything below this point mutates the tree or the tag namespace,
// so the gate goes first: a refusal here leaves no trace to undo.
function locateApp() {
  if (appOverride) {
    const explicit = resolve(appOverride);
    if (!existsSync(join(explicit, "package.json"))) {
      throw new Error(`--app ${appOverride} is not a checkout (no package.json)`);
    }
    return explicit;
  }
  // The two repos are normally checked out side by side; that is the only
  // layout we can guess at, and guessing wrong must not read as "all clear".
  const sibling = join(root, "..", "app");
  return existsSync(join(sibling, "package.json")) ? sibling : undefined;
}

// The flag stays because a split checkout may genuinely have no app to run —
// but it is not a routine flag, and the pin made it worse rather than safer.
// Say what it gives up at the moment it is used, in full: an operator who is
// about to create an immutable tag should not have to remember any of this.
if (skipAppCheck) {
  console.warn(
    `warning: --no-app-check — nothing will execute ${bundle}@${version} before it is tagged.\n` +
      "  Skipped: the app suite against a store where this candidate is `latest`, and the\n" +
      "  receipt that proves the suite actually ran the candidate rather than the pin.\n" +
      "  The risk the pin introduced: app suites now execute the version pinned in the app's\n" +
      "  test-bundle.json, so no ordinary app build will pick this release up either. Nothing\n" +
      "  verifies that the candidate is executable by ANY app at all. The only lane that runs\n" +
      "  `latest` is CI's content-canary, which is continue-on-error and cannot fail a build,\n" +
      "  so a broken release stays quiet until someone bumps the pin and inherits the mess.\n" +
      "  The tag is immutable: a mistake ships as the next version.",
  );
}
const appDir = skipAppCheck ? undefined : locateApp();
if (!skipAppCheck && !appDir) {
  throw new Error(
    "no app checkout found at ../app — pass --app <dir>, or --no-app-check to publish " +
      "without the suite. Refusing to skip silently: a release that is not checked against " +
      "an app is exactly how a published bundle turns an already-shipped app version red.",
  );
}
if (appDir) {
  const store = mkdtempSync(join(tmpdir(), "brain-publish-store-"));
  // The suite's own account of what it ran. The three variables set below are a
  // REQUEST, not a result — see scripts/lib/receipt.mjs for why re-reading them
  // could never be a check — and this file is the result. Only a receipt naming
  // this bundle, this candidate version and this store proves the run under way
  // tested the release under way.
  const receiptPath = join(appDir, RECEIPT_FILE);
  // Delete BEFORE the run, never after. A receipt left by an earlier publish
  // attempt — or by a developer's own `npm test` — would name a plausible
  // bundle and satisfy the confirmation below while this run's suite proved
  // nothing. Evidence has to be created by the run it is evidence for.
  rmSync(receiptPath, { force: true });
  try {
    console.log(`Building candidate store for ${bundle}@${version}...`);
    execFileSync(
      process.execPath,
      [
        join(root, "scripts", "candidate-store.mjs"),
        bundle,
        version,
        "--store",
        store,
        ...(notes ? ["--notes", notes] : []),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    const shown = relative(root, appDir);
    console.log(
      `Running the app suite in ${shown.length < appDir.length ? shown : appDir} against it ` +
        "(this is slow)...",
    );
    // The catch sits on the suite run ALONE. It reports a red suite, and a
    // refusal from the receipt check below is not that: folding the two
    // together would print "the app suite failed" over a suite that passed
    // while testing the wrong bundle, which is the most misleading thing this
    // script could say.
    try {
      execFileSync("npm", ["test"], {
        cwd: appDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env,
          // The server suite drives a real registry, so only a whole store can
          // carry the candidate to it — this is the variable
          // BRAIN_TEST_CONTENT_DIR could never reach, and the reason a green
          // content-dir run proved nothing.
          BRAIN_TEST_REGISTRY_DIR: store,
          // Naming the store is NOT enough on its own. The app suite no longer
          // takes the store index's `latest`; it runs the version pinned in the
          // app's test-bundle.json, so that publishing content cannot rewrite
          // what an already-shipped app tag executes. That pin is the previous
          // release, and left alone here it would make the gate test the very
          // version the release is replacing — the original bug, rebuilt inside
          // the check meant to catch it. Name the candidate explicitly rather
          // than passing "latest": the store already advertises it as latest,
          // so the two must agree, and a mismatch should be a loud failure from
          // the registry double instead of a run that quietly picks something
          // else. Setting this is still only a request — the receipt below is
          // what turns it into a fact.
          BRAIN_TEST_BUNDLE_VERSION: version,
          // The content, runtime and worker suites take a bare content
          // directory instead. Point them at the candidate INSIDE the store
          // rather than at content-src: that copy is version-stamped and
          // ignore-filtered, so every suite reads the exact bytes the tag will
          // carry. (registry-client opts out on purpose — it verifies against a
          // manifest, so it must keep resolving a published release.)
          BRAIN_TEST_CONTENT_DIR: `${join(store, "bundles", bundle, version)}/`,
        },
      });
    } catch (error) {
      const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
      if (output.length > 0) console.error(output);
      throw new Error(
        `the app suite failed against ${bundle}@${version} — not tagging. Fix the content (or ` +
          "the app) and publish again; the tag would have been immutable.",
      );
    }
    // Green is only half the answer; the other half is WHICH bundle was green.
    // Inside the try on purpose, so the store still exists and its path can be
    // compared through symlinks before the finally removes it.
    confirmSuiteRanCandidate({ receiptPath, store, bundle, version, root });
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
  console.log(
    `App suite green, and its receipt names ${bundle}@${version} from the candidate store.`,
  );
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
