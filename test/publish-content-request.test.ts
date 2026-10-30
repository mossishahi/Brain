import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

// These release scripts run directly in Node, outside the compiled package.
const scriptPath = new URL("../../scripts/publish-content-request.mjs", import.meta.url);
const { validateReleaseRequest, publishReleaseRequest } = await import(scriptPath.href);

const request = {
  bundle: "brainstorm",
  version: "0.30.0",
  notes: "Keep authored arguments; make provider thinking summaries optional.",
  appRevision: "1234567890abcdef1234567890abcdef12345678",
};

test("release requests pin an exact app commit and reject ambiguous or injected fields", () => {
  assert.deepEqual(validateReleaseRequest(request), request);
  for (const input of [
    null, [], "request", { ...request, skipAppCheck: true },
    { ...request, appRevision: "main" }, { ...request, appRevision: `${request.appRevision}\ntag=other` },
    { ...request, bundle: "../brainstorm" }, { ...request, bundle: "--all" },
    { ...request, version: "0.30.0-beta.1" }, { ...request, version: "00.30.0" },
    { ...request, notes: " " }, { ...request, notes: "x\0y" }, { ...request, notes: "x".repeat(2001) },
  ]) assert.throws(() => validateReleaseRequest(input));
});

test("publishing uses the full app gate and pushes only the expected annotated tag", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const notes = "Literal notes: `no command` $(no substitution)\nsecond line";
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("rev-parse")) return `${request.appRevision}\n`;
    if (args.includes("cat-file")) return "tag\n";
    return "";
  };
  const app = fileURLToPath(new URL("../../app", import.meta.url));
  const ref = publishReleaseRequest({ ...request, notes }, app, run);
  assert.equal(ref, "refs/tags/brainstorm/v0.30.0");
  const gate = calls.find((call) => call.command === process.execPath)!;
  assert.ok(gate);
  assert.deepEqual(gate.args.slice(1), ["brainstorm", "0.30.0", "--notes", notes, "--app", app]);
  assert.equal(gate.args.includes("--no-app-check"), false);
  assert.deepEqual(calls.at(-1)?.args.slice(2), ["-c", "push.followTags=false", "push", "origin", `${ref}:${ref}`]);
});

test("a mismatched or changed app checkout prevents candidate publication", () => {
  for (const mismatch of ["revision", "dirty"]) {
    let gateCalled = false;
    const run = (command: string, args: string[]) => {
      if (command === process.execPath) gateCalled = true;
      if (args.includes("rev-parse")) return mismatch === "revision" ? "0".repeat(40) : request.appRevision;
      if (args.includes("status")) return " M package.json";
      return "";
    };
    assert.throws(() => publishReleaseRequest(request, "/tmp/app", run));
    assert.equal(gateCalled, false);
  }
});

test("a failed candidate suite or invalid tag cannot reach git push", () => {
  for (const failure of ["gate", "tag"]) {
    let pushed = false;
    const run = (command: string, args: string[]) => {
      if (args.includes("rev-parse")) return request.appRevision;
      if (command === process.execPath && failure === "gate") throw new Error("candidate suite failed");
      if (args.includes("cat-file")) return "commit";
      if (args.includes("push")) pushed = true;
      return "";
    };
    assert.throws(() => publishReleaseRequest(request, "/tmp/app", run));
    assert.equal(pushed, false);
  }
});
