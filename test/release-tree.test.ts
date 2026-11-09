import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const scripts = fileURLToPath(new URL("../../scripts/", import.meta.url));
const { buildReleaseTree } = await import(new URL("../../scripts/lib/release-tree.mjs", import.meta.url).href);
const { buildManifest } = await import(new URL("../../scripts/lib/manifest.mjs", import.meta.url).href);

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "brain-release-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const sourceDir = join(repo, "content-src", "brainstorm");
  mkdirSync(join(sourceDir, "workflows"), { recursive: true });
  mkdirSync(join(sourceDir, "skills"));
  mkdirSync(join(sourceDir, "controls"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("config", "tag.gpgSign", "false");
  // Exclude a private local file and even manifest.json: explicit insertion
  // must still include the generated manifest in the temporary release index.
  writeFileSync(join(repo, ".git", "info", "exclude"), "private.local\nmanifest.json\n");
  const meta = {
    runtimeProtocol: "brainstorm-runtime/v1", minAppVersion: "0.2.90",
    entrypoints: { workflow: "workflows/brainstorm.workflow.json", controls: ["controls/default.json"] },
  };
  writeFileSync(join(sourceDir, "bundle.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(sourceDir, "workflows/brainstorm.workflow.json"), '{\n  "version": "0.31.0"\n}\n');
  writeFileSync(join(sourceDir, "controls/default.json"), "{}\n");
  writeFileSync(join(sourceDir, "skills/judge.md"), "# Judge\nVerify before accepting.\n");
  writeFileSync(join(repo, "staged.txt"), "Preserve the developer's staging area.\n");
  git("add", "staged.txt");
  const options = { repo, sourceDir, bundle: "brainstorm", version: "0.31.0" };
  const manifest = () => buildManifest(sourceDir, { ...options, ...meta });
  const tagTree = (tree: string, version = options.version) => {
    const commit = git("commit-tree", tree, "-m", `brainstorm@${version}`).trim();
    git("tag", "-a", `brainstorm/v${version}`, "-m", `Release ${version}`, commit);
  };
  const materialize = (store: string) => execFileSync(process.execPath, [
    join(scripts, "materialize-store.mjs"), "--repo", repo, "--store", store, "--quiet",
  ]);
  return { dir, repo, sourceDir, options, meta, git, manifest, tagTree, materialize };
}

test("release trees embed the exact verified manifest and preserve content-root paths and developer state", (t) => {
  const f = fixture(t);
  const expected = f.manifest();
  // Deliberately unusual formatting proves preservation of verified bytes.
  const verifiedManifestText = `${JSON.stringify(expected, null, 4)}\n\n`;
  writeFileSync(join(f.sourceDir, "private.local"), "DO NOT DISTRIBUTE\n");
  const indexBefore = readFileSync(join(f.repo, ".git/index"));
  const statusBefore = f.git("status", "--porcelain");
  const tree = buildReleaseTree({ ...f.options, verifiedManifestText });
  assert.equal(f.git("show", `${tree}:manifest.json`), verifiedManifestText);
  assert.equal(expected.minAppVersion, "0.2.90");
  assert.deepEqual(expected.files.map((file: { path: string }) => file.path).sort(), [
    "bundle.json", "controls/default.json", "skills/judge.md", "workflows/brainstorm.workflow.json",
  ]);
  for (const file of expected.files) {
    const contents = execFileSync("git", ["-C", f.repo, "show", `${tree}:${file.path}`]);
    assert.equal(contents.length, file.bytes);
    assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256);
  }
  assert.deepEqual(f.git("ls-tree", "-r", "--name-only", tree).trim().split("\n"), [
    "bundle.json", "controls/default.json", "manifest.json", "skills/judge.md", "workflows/brainstorm.workflow.json",
  ]);
  assert.deepEqual(readFileSync(join(f.repo, ".git/index")), indexBefore);
  assert.equal(f.git("status", "--porcelain"), statusBefore);
  assert.equal(existsSync(join(f.sourceDir, "manifest.json")), false);
  assert.equal(f.git("tag", "-l"), "");
});

test("release trees reject content or compatibility-floor drift after candidate verification", (t) => {
  for (const change of ["content", "floor", "version"]) {
    const f = fixture(t);
    const verifiedManifestText = JSON.stringify(f.manifest());
    if (change === "content") writeFileSync(join(f.sourceDir, "skills/judge.md"), "Changed after the suite.\n");
    if (change === "floor") writeFileSync(join(f.sourceDir, "bundle.json"), JSON.stringify({ ...f.meta, minAppVersion: "0.2.91" }));
    assert.throws(() => buildReleaseTree({
      ...f.options, ...(change === "version" ? { version: "0.32.0" } : {}), verifiedManifestText,
    }), /changed after the candidate suite/);
    assert.equal(f.git("tag", "-l"), "");
    assert.equal(existsSync(join(f.sourceDir, "manifest.json")), false);
  }
});

test("explicitly unchecked releases still carry a complete compatibility manifest", (t) => {
  const f = fixture(t);
  const tree = buildReleaseTree(f.options);
  const result = JSON.parse(f.git("show", `${tree}:manifest.json`));
  assert.deepEqual(result, f.manifest());
  assert.equal(result.files.some((file: { path: string }) => file.path === "manifest.json"), false);
});

test("materialization honors supplied manifest bytes and leaves existing versions untouched", (t) => {
  const f = fixture(t);
  const oldTree = buildReleaseTree({ ...f.options, version: "0.30.1" });
  f.tagTree(oldTree, "0.30.1");
  const store = join(f.dir, "store");
  f.materialize(store);
  const oldManifestPath = join(store, "bundles/brainstorm/0.30.1/manifest.json");
  const oldBytes = readFileSync(oldManifestPath);
  const verifiedManifestText = `${JSON.stringify(f.manifest(), null, 4)}\n\n`;
  f.tagTree(buildReleaseTree({ ...f.options, verifiedManifestText }));
  f.materialize(store);
  assert.equal(readFileSync(join(store, "bundles/brainstorm/0.31.0/manifest.json"), "utf8"), verifiedManifestText);
  assert.deepEqual(readFileSync(oldManifestPath), oldBytes);
  assert.equal(JSON.parse(readFileSync(join(store, "index.json"), "utf8")).bundles[0].latest, "0.31.0");
  f.materialize(store);
  assert.deepEqual(readFileSync(oldManifestPath), oldBytes);
});

test("publisher carries the candidate suite's exact manifest into the final tag", (t) => {
  const f = fixture(t);
  f.tagTree(buildReleaseTree({ ...f.options, version: "0.30.1" }), "0.30.1");
  cpSync(scripts, join(f.repo, "scripts"), { recursive: true });
  const app = join(f.dir, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), JSON.stringify({ scripts: { test: "node test.mjs" } }));
  // A fixture suite records exactly the candidate resolved through the
  // publisher's environment. No real app builds or real release tags.
  writeFileSync(join(app, "test.mjs"), `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const manifestPath = join(process.env.BRAIN_TEST_CONTENT_DIR, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bytes = JSON.stringify(manifest, null, 4) + '\\n\\n';
    writeFileSync(manifestPath, bytes);
    writeFileSync('verified-manifest.json', bytes);
    writeFileSync('.test-bundle-used.json', JSON.stringify({
      bundle: manifest.bundle, version: manifest.version,
      storeRoot: process.env.BRAIN_TEST_REGISTRY_DIR,
    }));
  `);
  execFileSync(process.execPath, [join(f.repo, "scripts/publish-bundle.mjs"), "brainstorm", "0.31.0", "--app", app], {
    maxBuffer: 1024 * 1024,
  });
  const verified = readFileSync(join(app, "verified-manifest.json"), "utf8");
  assert.equal(f.git("show", "brainstorm/v0.31.0:manifest.json"), verified);
  assert.equal(JSON.parse(verified).minAppVersion, "0.2.90");
  assert.equal(existsSync(join(f.sourceDir, "manifest.json")), false);
});
