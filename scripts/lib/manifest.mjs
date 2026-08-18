import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

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

function walk(directory, manifestPath) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path, manifestPath);
      return entry.isFile() && path !== manifestPath ? [path] : [];
    });
}

/** Hashes every file below `versionDir` (except manifest.json) into a manifest object. */
export function buildManifest(
  versionDir,
  { bundle, version, runtimeProtocol, entrypoints, minAppVersion },
) {
  if (typeof runtimeProtocol !== "string" || runtimeProtocol.length === 0) {
    throw new Error("runtimeProtocol is required for a manifest");
  }
  if (minAppVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(String(minAppVersion))) {
    throw new Error(`minAppVersion must be a plain semver, got "${minAppVersion}"`);
  }
  const manifestPath = join(versionDir, "manifest.json");
  const files = walk(versionDir, manifestPath).map((path) => {
    const contents = readFileSync(path);
    return {
      path: relative(versionDir, path).split(sep).join("/"),
      sha256: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.length,
      mediaType: mediaType(path),
    };
  });
  return {
    schemaVersion: "content-registry-manifest/v1",
    bundle,
    version,
    runtimeProtocol,
    // The oldest app release that can run this bundle. The runtime protocol
    // says which CONTRACT the content speaks; this says which app actually
    // implements the parts this version uses, so a host too old to bind a
    // field the workflow names is turned away before it spends anything
    // rather than dying mid-run against content that looks valid.
    ...(minAppVersion !== undefined ? { minAppVersion: String(minAppVersion) } : {}),
    ...(entrypoints ? { entrypoints } : {}),
    files,
  };
}

export function writeManifest(versionDir, manifest) {
  writeFileSync(join(versionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
