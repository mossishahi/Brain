#!/usr/bin/env node
/**
 * Materializes the registry's serving store from release tags.
 *
 * Releases are annotated git tags named `<bundle>/v<semver>`. For every tag
 * missing from the store, this extracts the tagged tree into
 * `<store>/bundles/<bundle>/<version>/`, ensures a manifest exists (legacy
 * imported artifacts carry one; source-built releases carry a bundle.json
 * that a manifest is generated from), and rewrites `<store>/index.json`
 * from the full tag list — versions ascending, `latest` highest, and each
 * version's release notes taken from the tag annotation's subject line.
 *
 * Idempotent and append-only: existing store versions are never touched.
 * Usage: node scripts/materialize-store.mjs [--repo <dir>] [--store <dir>] [--quiet]
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest, writeManifest } from "./lib/manifest.mjs";

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const quiet = process.argv.includes("--quiet");
const repo = flag("repo") ?? fileURLToPath(new URL("../", import.meta.url));
const store = flag("store") ?? join(repo, ".registry-store");

const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Deployments serve a clone: new releases arrive as tags on the remote, so a
// scan may first fetch them. Best effort — offline keeps serving what exists.
if (process.argv.includes("--fetch")) {
  try {
    git("fetch", "--tags", "--quiet");
  } catch (error) {
    if (!quiet) {
      console.error(`tag fetch failed (serving known releases): ${error.message ?? error}`);
    }
  }
}

function releases() {
  const raw = git("tag", "-l", "*/v*", "--format", "%(refname:strip=2)\u001f%(contents:subject)");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [ref, subject] = line.split("\u001f");
      const match = /^([A-Za-z0-9._-]+)\/v(\d+\.\d+\.\d+)$/.exec(ref);
      if (!match) return [];
      return [{ ref, bundle: match[1], version: match[2], notes: subject ?? "" }];
    });
}

function compareSemver(a, b) {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

function materialize(release) {
  const target = join(store, "bundles", release.bundle, release.version);
  if (existsSync(target)) return false;
  const staging = `${target}.staging-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const archive = execFileSync(
      "git",
      ["-C", repo, "archive", "--format=tar", release.ref],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    execFileSync("tar", ["-x", "-C", staging], { input: archive });
    if (!existsSync(join(staging, "manifest.json"))) {
      const bundleMetaPath = join(staging, "bundle.json");
      if (!existsSync(bundleMetaPath)) {
        throw new Error(`release ${release.ref} carries neither manifest.json nor bundle.json`);
      }
      const meta = JSON.parse(readFileSync(bundleMetaPath, "utf8"));
      writeManifest(
        staging,
        buildManifest(staging, {
          bundle: release.bundle,
          version: release.version,
          runtimeProtocol: meta.runtimeProtocol,
          entrypoints: meta.entrypoints,
          minAppVersion: meta.minAppVersion,
        }),
      );
    }
    mkdirSync(join(store, "bundles", release.bundle), { recursive: true });
    try {
      renameSync(staging, target);
    } catch {
      // A concurrent materializer won the race; its result is identical.
      rmSync(staging, { recursive: true, force: true });
      return false;
    }
    return true;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

const all = releases();
if (all.length === 0) {
  throw new Error("no release tags found (expected annotated tags named <bundle>/v<semver>)");
}
let added = 0;
for (const release of all) {
  if (materialize(release)) {
    added += 1;
    if (!quiet) console.log(`materialized ${release.bundle}@${release.version}`);
  }
}

const byBundle = new Map();
for (const release of all) {
  const entry = byBundle.get(release.bundle) ?? { versions: [], notes: {} };
  entry.versions.push(release.version);
  if (release.notes) entry.notes[release.version] = release.notes;
  byBundle.set(release.bundle, entry);
}
const index = {
  schemaVersion: "content-registry-index/v1",
  bundles: [...byBundle.entries()].map(([id, entry]) => {
    const versions = entry.versions.sort(compareSemver);
    return {
      id,
      latest: versions[versions.length - 1],
      versions,
      releases: Object.fromEntries(
        versions.map((version) => [version, { notes: entry.notes[version] ?? "" }]),
      ),
    };
  }),
};
mkdirSync(store, { recursive: true });
const indexStaging = join(store, `index.json.staging-${process.pid}`);
writeFileSync(indexStaging, `${JSON.stringify(index, null, 2)}\n`);
renameSync(indexStaging, join(store, "index.json"));

if (!quiet) {
  console.log(
    added > 0
      ? `store updated: ${added} new version(s); index rewritten`
      : "store up-to-date",
  );
}
