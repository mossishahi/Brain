import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { defaultRepoRoot, startContentRegistryServer } from "../src/index.js";
import { TaxonomyService, encoderStoreName } from "../src/taxonomy.js";

const repoRoot = defaultRepoRoot();
const script = join(repoRoot, "scripts", "build-node-vectors.mjs");
const seedPath = join(repoRoot, "content-src", "brainstorm", "catalog", "taxonomy.json");

/** A tiny exported vector file + texts asset + manifest, as the encoder export writes them. */
function fixture(dir: string, dim = 4): { manifest: string; texts: string; vectors: string; values: Float32Array; textsSha: string } {
  const entries = [
    { id: "T10001", text: "Graph Neural Networks. Message passing over graphs." },
    { id: "T10002", text: "Gaussian Processes. Kernel priors." },
    { id: "C:x", text: "Curated \u00e9 node. Also known as: X." },
  ];
  const textsSha = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  const texts = join(dir, "taxonomy-texts.json");
  writeFileSync(texts, JSON.stringify({ version: 1, snapshot: { source: "openalex-s3", date: "2026-09-23" }, recipe: "test", sha256: textsSha, entries }));
  const values = new Float32Array(entries.length * dim);
  for (let r = 0; r < entries.length; r += 1) {
    const raw = Array.from({ length: dim }, (_, k) => Math.sin(r * 7 + k) + 0.1);
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
    raw.forEach((x, k) => (values[r * dim + k] = x / norm));
  }
  const vectors = join(dir, "rows.f32");
  writeFileSync(vectors, Buffer.from(values.buffer));
  const manifest = join(dir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      id: "specter2",
      dim,
      version: 1,
      models: { "allenai/specter2_base": "3447645e1def9117997203454fa4495937bfbd83" },
      pooling: "cls",
      docFormat: "{title}[SEP]{body}",
      queryFormat: "{text}",
      verification: [{ text: "a", mode: "query", head: [0.1, 0.2], tolerance: 0.002 }],
      graphs: { doc: { file: "doc.onnx", sha256: "a".repeat(64) }, query: { file: "query.onnx", sha256: "b".repeat(64) } },
      variants: { int8: {} },
    }),
  );
  return { manifest, texts, vectors, values, textsSha };
}

function build(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test("encoder store names are single path segments", () => {
  assert.equal(encoderStoreName("specter2"), "specter2");
  assert.equal(encoderStoreName("openrouter:openai/text-embedding-3-small"), "openrouter%3Aopenai%2Ftext-embedding-3-small");
  assert.equal(encoderStoreName(".."), undefined);
  assert.equal(encoderStoreName("."), undefined);
  assert.equal(encoderStoreName(""), undefined);
  assert.equal(encoderStoreName("../../etc"), "..%2F..%2Fetc");
});

test("build-node-vectors writes the served format; the default index is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-node-vectors-"));
  try {
    const storeDir = join(dir, "store");
    const service = new TaxonomyService({ seedPath, storeDir });
    const revision = service.graph.revision;
    const before = service.embeddings();
    assert.equal(service.neuralEmbeddings("specter2"), undefined, "nothing precomputed yet");
    const f = fixture(dir);
    const out = JSON.parse(
      execFileSync(process.execPath, [script, "--manifest", f.manifest, "--vectors", f.vectors, "--texts", f.texts, "--revision", String(revision), "--store", storeDir], { encoding: "utf8" }),
    );
    assert.equal(out.out, join(storeDir, "embeddings", "specter2", `${revision}.json`));
    const served = service.neuralEmbeddings("specter2");
    assert.ok(served);
    assert.deepEqual(Object.keys(served).sort(), ["dim", "encoder", "ids", "nodeTextsSha256", "revision", "vectorsB64", "vectorsSha256"]);
    assert.equal(served.revision, revision);
    assert.equal(served.encoder.id, "specter2");
    assert.equal(served.dim, 4);
    assert.deepEqual(served.ids, ["T10001", "T10002", "C:x"]);
    assert.equal(served.nodeTextsSha256, f.textsSha);
    assert.deepEqual(Object.keys(served.encoder).sort(), ["dim", "docFormat", "id", "models", "pooling", "queryFormat", "verification", "version"]);
    assert.equal((served.encoder.models as Record<string, string>)["onnx:doc"], "a".repeat(64));
    assert.equal((served.encoder.models as Record<string, string>)["onnx:query"], "b".repeat(64));
    const bytes = Buffer.from(served.vectorsB64, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), served.vectorsSha256);
    const decoded = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.deepEqual(Array.from(decoded), Array.from(f.values));
    // other encoders, other revisions and unsafe names are not served
    assert.equal(service.neuralEmbeddings("bge-base-en-v1.5"), undefined);
    assert.equal(service.neuralEmbeddings(".."), undefined);
    // the default index is untouched by the precomputed file
    assert.deepEqual(service.embeddings(), before);
    assert.equal(service.embeddings().embedder.id, "hash-ngram-v1");
    // refuses to overwrite, rejects shape errors and unnormalized rows
    const again = build(["--manifest", f.manifest, "--vectors", f.vectors, "--texts", f.texts, "--revision", String(revision), "--store", storeDir]);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /exists/);
    const short = join(dir, "short.f32");
    writeFileSync(short, Buffer.from(f.values.buffer, 0, 8 * 4));
    assert.match(build(["--manifest", f.manifest, "--vectors", short, "--texts", f.texts, "--revision", "9", "--store", storeDir]).stderr, /expected 3 x 4 x 4/);
    const loose = join(dir, "loose.f32");
    writeFileSync(loose, Buffer.from(f.values.map((x) => x * 2).buffer));
    assert.match(build(["--manifest", f.manifest, "--vectors", loose, "--texts", f.texts, "--revision", "9", "--store", storeDir]).stderr, /not L2-normalized/);
    // a corrupted file is not served (falls back to the default index)
    const forced = build(["--manifest", f.manifest, "--vectors", f.vectors, "--texts", f.texts, "--revision", String(revision), "--store", storeDir, "--force"]);
    assert.equal(forced.status, 0, forced.stderr);
    const file = join(storeDir, "embeddings", "specter2", `${revision}.json`);
    const tampered = JSON.parse(readFileSync(file, "utf8"));
    tampered.vectorsSha256 = "0".repeat(64);
    writeFileSync(file, JSON.stringify(tampered));
    assert.equal(service.neuralEmbeddings("specter2"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("taxonomy_embeddings: optional encoder argument; no argument behaves as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-node-vectors-mcp-"));
  const storeDir = join(dir, "store");
  const running = await startContentRegistryServer({ port: 0, taxonomyStoreDir: storeDir });
  const client = new Client({ name: "content-registry-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl));
  const toolJson = async (args: Record<string, unknown>): Promise<any> => {
    const result = await client.callTool({ name: "taxonomy_embeddings", arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    assert.ok(content && content.type === "text" && typeof content.text === "string");
    return JSON.parse(content.text);
  };
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === "taxonomy_embeddings");
    assert.ok(tool);
    assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ["encoder", "knownRevision"]);

    const plain = await toolJson({});
    assert.equal(plain.embedder.id, "hash-ngram-v1");
    assert.equal(plain.nodes.length, plain.vectors.length);
    assert.deepEqual(await toolJson({ knownRevision: plain.revision }), { revision: plain.revision, unchanged: true });
    // an encoder the store holds nothing for: exactly the default payload
    assert.deepEqual(await toolJson({ encoder: "specter2" }), plain);
    assert.deepEqual(await toolJson({ encoder: "" }), plain);

    const f = fixture(dir);
    const built = build(["--manifest", f.manifest, "--vectors", f.vectors, "--texts", f.texts, "--revision", String(plain.revision), "--store", storeDir]);
    assert.equal(built.status, 0, built.stderr);
    const neural = await toolJson({ encoder: "specter2" });
    assert.equal(neural.revision, plain.revision);
    assert.equal(neural.encoder.id, "specter2");
    assert.equal(neural.dim, 4);
    assert.deepEqual(neural.ids, ["T10001", "T10002", "C:x"]);
    assert.equal(neural.nodeTextsSha256, f.textsSha);
    assert.equal(createHash("sha256").update(Buffer.from(neural.vectorsB64, "base64")).digest("hex"), neural.vectorsSha256);
    assert.deepEqual(await toolJson({ encoder: "specter2", knownRevision: plain.revision }), {
      revision: plain.revision,
      encoder: "specter2",
      unchanged: true,
    });
    // old clients (no encoder argument) and other encoders still see the default index
    assert.deepEqual(await toolJson({}), plain);
    assert.deepEqual(await toolJson({ encoder: "bge-base-en-v1.5" }), plain);
    assert.deepEqual(await toolJson({ knownRevision: plain.revision }), { revision: plain.revision, unchanged: true });
  } finally {
    await transport.close().catch(() => undefined);
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
