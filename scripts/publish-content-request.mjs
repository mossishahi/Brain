#!/usr/bin/env node
/** Publish a reviewed release request through the existing candidate-suite gate. */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fields = ["appRevision", "bundle", "notes", "version"];

export function validateReleaseRequest(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release request must be an object");
  }
  if (Object.keys(value).sort().join(",") !== fields.join(",")) {
    throw new Error(`release request must contain exactly ${fields.join(", ")}`);
  }
  if (typeof value.bundle !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.bundle)) {
    throw new Error("bundle must be a lowercase content bundle identifier");
  }
  if (typeof value.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)) {
    throw new Error("version must be a canonical plain semver (x.y.z)");
  }
  if (typeof value.notes !== "string" || value.notes.trim().length === 0 || value.notes.length > 2000 || value.notes.includes("\0")) {
    throw new Error("notes must be a nonempty message of at most 2000 characters without NUL bytes");
  }
  if (typeof value.appRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.appRevision)) {
    throw new Error("appRevision must be an exact lowercase 40-character commit SHA");
  }
  return { bundle: value.bundle, version: value.version, notes: value.notes, appRevision: value.appRevision };
}

export function publishReleaseRequest(request, appDirectory, run = execFileSync) {
  const release = validateReleaseRequest(request);
  const app = resolve(appDirectory);
  const actualRevision = run("git", ["-C", app, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (actualRevision !== release.appRevision) {
    throw new Error(`app checkout is ${actualRevision}, expected ${release.appRevision}`);
  }
  const dirty = run("git", ["-C", app, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
  if (dirty.length > 0) throw new Error("the pinned app checkout has tracked changes");

  // This script is deliberately unable to bypass the candidate execution and
  // receipt checks in publish-bundle. A failed gate stops before any push.
  run(process.execPath, [
    resolve(root, "scripts/publish-bundle.mjs"), release.bundle, release.version,
    "--notes", release.notes, "--app", app,
  ], { cwd: root, stdio: "inherit" });

  const ref = `refs/tags/${release.bundle}/v${release.version}`;
  const type = run("git", ["-C", root, "cat-file", "-t", ref], { encoding: "utf8" }).trim();
  if (type !== "tag") throw new Error(`${ref} is not an annotated release tag`);
  // An explicit refspec and disabled followTags prevent unrelated local tags
  // or branches from being published by the release runner.
  run("git", ["-C", root, "-c", "push.followTags=false", "push", "origin", `${ref}:${ref}`], { stdio: "inherit" });
  return ref;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, requestPath, ...args] = process.argv.slice(2);
  if (!requestPath || (command !== "validate" && command !== "publish") ||
      (command === "validate" && args.length !== 0) ||
      (command === "publish" && (args.length !== 2 || args[0] !== "--app" || !args[1] || args[1].startsWith("--")))) {
    throw new Error("Usage: publish-content-request.mjs validate <request.json> | publish <request.json> --app <checkout>");
  }
  const request = validateReleaseRequest(JSON.parse(readFileSync(requestPath, "utf8")));
  if (command === "validate") {
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `appRevision=${request.appRevision}\ntag=${request.bundle}/v${request.version}\n`);
    }
    console.log(`Validated ${request.bundle}/v${request.version} against app ${request.appRevision}`);
  } else {
    publishReleaseRequest(request, args[1]);
  }
}
