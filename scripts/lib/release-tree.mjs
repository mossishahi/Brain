import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { buildManifest } from "./manifest.mjs";

/**
 * Build a content-root release tree with its manifest already included.
 * Older registries must not reconstruct release metadata using older code.
 * The exact manifest tested by the app rides in the tag, without modifying
 * the editable source, real staging area, branch, or tag namespace.
 */
export function buildReleaseTree({ repo, sourceDir, bundle, version, verifiedManifestText }) {
  const scratch = mkdtempSync(join(tmpdir(), "brain-release-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    const git = (args, options = {}) => execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8", env, ...options,
    }).trim();
    // Match candidate-store's Git filtering and archive semantics exactly.
    git([`--work-tree=${sourceDir}`, "add", "-A"]);
    const sourceTree = git(["write-tree"]);
    const snapshot = join(scratch, "content");
    mkdirSync(snapshot);
    const archive = execFileSync("git", ["-C", repo, "archive", "--format=tar", sourceTree], {
      maxBuffer: 256 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", snapshot], { input: archive });
    const meta = JSON.parse(readFileSync(join(snapshot, "bundle.json"), "utf8"));
    const manifest = buildManifest(snapshot, {
      bundle, version, runtimeProtocol: meta.runtimeProtocol,
      entrypoints: meta.entrypoints, minAppVersion: meta.minAppVersion,
    });
    if (verifiedManifestText !== undefined &&
        !isDeepStrictEqual(JSON.parse(verifiedManifestText), manifest)) {
      throw new Error(
        "the release content or metadata changed after the candidate suite — not tagging. " +
        "Run the publish gate again against the current source.",
      );
    }
    // Preserve verified bytes, including formatting. The explicit no-app-check
    // lane still gets a complete manifest, but cannot claim app verification.
    const manifestText = verifiedManifestText ?? `${JSON.stringify(manifest, null, 2)}\n`;
    const blob = git(["hash-object", "-w", "--stdin"], { input: manifestText });
    git(["update-index", "--add", "--cacheinfo", `100644,${blob},manifest.json`]);
    return git(["write-tree"]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
