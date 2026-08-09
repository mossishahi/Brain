import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  defaultContentRoot,
  startContentRegistryServer,
} from "../src/index.js";

test("HTTP API serves only the committed static index, manifest, and files", async () => {
  const running = await startContentRegistryServer({ port: 0 });
  try {
    const indexResponse = await fetch(`${running.url}/v1/index.json`);
    assert.equal(indexResponse.status, 200);
    const index = await indexResponse.json() as {
      bundles: Array<{ id: string; latest: string; versions: string[] }>;
    };
    // The response must be exactly the committed index — whatever versions
    // the publish script has appended to it.
    const committed = JSON.parse(
      readFileSync(join(defaultContentRoot(), "index.json"), "utf8"),
    ) as { bundles: unknown };
    assert.deepEqual(index.bundles, committed.bundles);
    const brainstorm = index.bundles.find((bundle) => bundle.id === "brainstorm");
    assert.ok(brainstorm, "the index publishes the brainstorm bundle");
    assert.ok(brainstorm.versions.includes(brainstorm.latest));

    const prefix = `${running.url}/v1/bundles/brainstorm/0.1.0`;
    const manifestResponse = await fetch(`${prefix}/manifest.json`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json() as {
      schemaVersion: string;
      entrypoints: { workflow: string; controls: string[] };
      files: Array<{ path: string }>;
    };
    assert.equal(manifest.schemaVersion, "content-registry-manifest/v1");
    assert.equal(
      manifest.entrypoints.workflow,
      "workflows/brainstorm.workflow.json",
    );
    assert.ok(manifest.entrypoints.controls.length >= 6);
    assert.ok(
      manifest.files.some((file) => file.path === "skills/roles/brain.md"),
    );

    const fileResponse = await fetch(`${prefix}/skills/roles/brain.md`);
    assert.equal(fileResponse.status, 200);
    assert.equal(
      await fileResponse.text(),
      readFileSync(
        join(
          defaultContentRoot(),
          "bundles",
          "brainstorm",
          "0.1.0",
          "skills",
          "roles",
          "brain.md",
        ),
        "utf8",
      ),
    );
    assert.equal(
      (await fetch(`${running.url}/v1/../../package.json`)).status,
      404,
    );
  } finally {
    await running.close();
  }
});

test("MCP exposes static files as resources and the taxonomy tools", async () => {
  const running = await startContentRegistryServer({ port: 0 });
  const client = new Client({ name: "content-registry-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl));
  try {
    await client.connect(transport);

    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates[0]?.uriTemplate, "brain://file/{path}");
    const brain = resources.resources.find(
      (resource) =>
        resource.name ===
        "bundles/brainstorm/0.1.0/skills/roles/brain.md",
    );
    assert.ok(brain);

    const read = await client.readResource({ uri: brain.uri });
    assert.equal(read.contents.length, 1);
    assert.match(
      "text" in read.contents[0]! ? read.contents[0].text : "",
      /name: brain/,
    );

    // The live taxonomy store is mutable state behind the tools — it must
    // never leak into the immutable static content tree.
    assert.equal(
      resources.resources.some((resource) => resource.name.startsWith("taxonomy/")),
      false,
      "the taxonomy store is not served as static content",
    );
  } finally {
    await transport.close().catch(() => undefined);
    await running.close();
  }
});

test("taxonomy tools: exact resolve, candidate names on a miss, tree, and suggestion receipts", async () => {
  const running = await startContentRegistryServer({ port: 0 });
  const client = new Client({ name: "content-registry-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl));
  const toolJson = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content as Array<{ type: string; text?: string }>)[0];
    assert.ok(content && content.type === "text" && typeof content.text === "string");
    return JSON.parse(content.text);
  };
  try {
    await client.connect(transport);
    assert.equal(running.taxonomyEnabled, true);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["taxonomy_embeddings", "taxonomy_resolve", "taxonomy_suggest", "taxonomy_tree"],
    );

    // The node-embedding index: metadata parallel to vectors, the embedder
    // manifest with its conformance table, and the revision-elision path.
    const embeddings = await toolJson("taxonomy_embeddings", {});
    assert.ok(embeddings.revision >= 1);
    assert.equal(embeddings.embedder.id, "hash-ngram-v1");
    assert.equal(embeddings.nodes.length, embeddings.vectors.length);
    assert.ok(embeddings.nodes.length > 4000);
    assert.equal(embeddings.vectors[0].length, embeddings.embedder.dim);
    assert.ok(embeddings.embedder.verification.length > 0);
    const unchanged = await toolJson("taxonomy_embeddings", {
      knownRevision: embeddings.revision,
    });
    assert.deepEqual(unchanged, { revision: embeddings.revision, unchanged: true });

    // Exact hit: position + the revision it was answered from.
    const hit = await toolJson("taxonomy_resolve", { query: "artificial INTELLIGENCE" });
    assert.equal(hit.found, true);
    assert.equal(hit.position.level, "subfield");
    assert.equal(hit.position.path.join(" > "), "Physical Sciences > Computer Science > Artificial Intelligence");
    assert.ok(hit.revision >= 1);

    // Miss: the server-side processor runs revise_query and returns candidate
    // NAMES only — alphabetized, no scores anywhere in the payload.
    const miss = await toolJson("taxonomy_resolve", { query: "Neural Message Passing" });
    assert.equal(miss.found, false);
    assert.equal(miss.status, "NA");
    assert.ok(Array.isArray(miss.options) && miss.options.length > 0);
    assert.deepEqual(
      miss.options,
      [...miss.options].sort((a: string, b: string) => a.localeCompare(b)),
    );
    assert.ok(!("alpha" in miss) && !("hits" in miss));

    // The whole latest tree, revision-stamped; a branch export via exact name.
    const branch = await toolJson("taxonomy_tree", { root: "Computer Science" });
    assert.ok(branch.outline.startsWith("Computer Science"));
    assert.ok(branch.nodeCount > 100);
    assert.equal(branch.revision, hit.revision);

    // Suggestions are saved with a receipt, never applied: the revision does
    // not move, and the batch lands as its own <time>-<user>.json file.
    const receipt = await toolJson("taxonomy_suggest", {
      entries: [
        { term: "Message Passing Neural Networks", kind: "place", detail: { parent: "Artificial Intelligence" } },
      ],
      submittedBy: "registry-test",
    });
    assert.equal(receipt.queued, 1);
    assert.ok(receipt.id.length > 0);
    assert.match(receipt.file, /^[0-9T-]+Z-registry-test(?:-\d+)?\.json$/);
    const after = await toolJson("taxonomy_resolve", { query: "Message Passing Neural Networks" });
    assert.equal(after.found, false);
    assert.equal(after.revision, receipt.revision);

    const saved = JSON.parse(
      readFileSync(
        join(defaultContentRoot(), "taxonomy", "suggestions", receipt.file),
        "utf8",
      ),
    );
    assert.equal(saved.id, receipt.id);
    assert.equal(saved.entries[0].term, "Message Passing Neural Networks");
    assert.equal(saved.submittedBy, "registry-test");
  } finally {
    await transport.close().catch(() => undefined);
    await running.close();
  }
});

test("the root page and health announce the server and bundle versions", async () => {
  const running = await startContentRegistryServer({ port: 0 });
  try {
    const committed = JSON.parse(
      readFileSync(join(defaultContentRoot(), "index.json"), "utf8"),
    ) as { bundles: Array<{ id: string; latest: string }> };
    const latest = committed.bundles.find((bundle) => bundle.id === "brainstorm")!.latest;

    // The landing page is what the app's brain icon links to: a human page
    // naming the server version and every served bundle version.
    const page = await fetch(`${running.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    const html = await page.text();
    assert.match(html, /Brain Registry/);
    assert.match(html, /brain-content-registry v0\.1\.0/);
    assert.ok(html.includes(`brainstorm@${latest}`));
    assert.match(html, /latest/);

    const health = await fetch(`${running.url}/health`);
    assert.equal(health.status, 200);
    const payload = await health.json() as {
      ok: boolean;
      server: { name: string; version: string };
      rateLimit: { requestsPerMinute: number; windowMs: number };
      bundles: Array<{ id: string; latest: string; versions: string[] }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.server.name, "brain-content-registry");
    assert.match(payload.server.version, /^\d+\.\d+\.\d+$/);
    // The declared budget clients pace their 429 retries by.
    assert.deepEqual(payload.rateLimit, { requestsPerMinute: 300, windowMs: 60_000 });
    const brainstorm = payload.bundles.find((bundle) => bundle.id === "brainstorm");
    assert.ok(brainstorm);
    assert.equal(brainstorm.latest, latest);
    assert.ok(brainstorm.versions.includes(latest));
  } finally {
    await running.close();
  }
});

test("rate limiting protects content while leaving health available", async () => {
  const running = await startContentRegistryServer({
    port: 0,
    requestsPerMinute: 1,
  });
  try {
    assert.equal((await fetch(`${running.url}/v1/index.json`)).status, 200);
    const limited = await fetch(`${running.url}/v1/index.json`);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    // Health stays reachable while throttled AND declares the configured
    // budget, so a throttled client can learn how long to pace itself.
    const health = await fetch(`${running.url}/health`);
    assert.equal(health.status, 200);
    const payload = (await health.json()) as {
      rateLimit: { requestsPerMinute: number; windowMs: number };
    };
    assert.deepEqual(payload.rateLimit, { requestsPerMinute: 1, windowMs: 60_000 });
  } finally {
    await running.close();
  }
});

test("ingest saves telemetry and diagnostics to disk and never serves them back", async () => {
  const server = await startContentRegistryServer({ host: "127.0.0.1", port: 0 });
  try {
    const base = server.url;

    const accepted = await fetch(`${base}/v1/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { type: "run.summary", eventId: "e1", installId: "i1", summary: { status: "completed" } },
        { type: "heartbeat", eventId: "e2", installId: "i1" },
      ]),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { accepted: 2 });

    const report = await fetch(`${base}/v1/diagnostics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "r1", note: "TOP-SECRET-SUBMISSION-TEXT" }),
    });
    assert.equal(report.status, 200);
    const received = ((await report.json()) as { received: string }).received;
    assert.match(received, /\.json\.gz$/);

    // Saved, gzipped, under the one writable store path.
    const storeRoot = defaultContentRoot();
    const telemetryDay = `${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
    const spooled = gunzipSync(readFileSync(join(storeRoot, "telemetry", telemetryDay)))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { eventId: string });
    assert.deepEqual(spooled.map((entry) => entry.eventId), ["e1", "e2"]);

    // NEVER served back. A diagnostic can carry a submitter's unpublished
    // research, so serving it would be a disclosure, not a rendering bug.
    const asStatic = await fetch(`${base}/v1/diagnostics/${received}`);
    assert.equal(asStatic.status, 404, "diagnostics are not static content");
    const index = (await (await fetch(`${base}/health`)).json()) as { files: number };
    assert.ok(index.files > 0);

    const client = new Client({ name: "leak-probe", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl)));
    try {
      const resources = await client.listResources();
      for (const resource of resources.resources) {
        assert.ok(
          !resource.uri.includes("diagnostics") && !resource.uri.includes("telemetry"),
          `ingested data must not be an MCP resource: ${resource.uri}`,
        );
      }
    } finally {
      await client.close();
    }
  } finally {
    rmSync(join(defaultContentRoot(), "telemetry"), { recursive: true, force: true });
    rmSync(join(defaultContentRoot(), "diagnostics"), { recursive: true, force: true });
    await server.close();
  }
});
