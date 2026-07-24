#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [bundle, version, requestedProtocol] = process.argv.slice(2);
if (!bundle || !version) {
  throw new Error(
    "Usage: node scripts/generate-manifest.mjs <bundle> <version> [runtimeProtocol]",
  );
}
if (![bundle, version].every((value) => /^[A-Za-z0-9._-]+$/.test(value))) {
  throw new Error("bundle and version may contain only letters, digits, dot, dash, underscore");
}

const moduleRoot = fileURLToPath(new URL("../", import.meta.url));
const versionDir = join(moduleRoot, "content", "bundles", bundle, version);
const manifestPath = join(versionDir, "manifest.json");
let existing = {};
try {
  existing = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  // A first publication supplies runtimeProtocol on the command line.
}
const runtimeProtocol = requestedProtocol ?? existing.runtimeProtocol;
if (typeof runtimeProtocol !== "string" || runtimeProtocol.length === 0) {
  throw new Error("runtimeProtocol is required for a new manifest");
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.isFile() && path !== manifestPath ? [path] : [];
    });
}

function mediaType(path) {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    default:
      return "application/octet-stream";
  }
}

const files = walk(versionDir).map((path) => {
  const contents = readFileSync(path);
  return {
    path: relative(versionDir, path).split(sep).join("/"),
    sha256: createHash("sha256").update(contents).digest("hex"),
    bytes: contents.length,
    mediaType: mediaType(path),
  };
});
const manifest = {
  schemaVersion: "content-registry-manifest/v1",
  bundle,
  version,
  runtimeProtocol,
  ...(existing.entrypoints ? { entrypoints: existing.entrypoints } : {}),
  files,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Wrote ${relative(dirname(moduleRoot), manifestPath)} (${files.length} files)`,
);
