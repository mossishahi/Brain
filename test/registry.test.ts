import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const landing = await fetch(running.url);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Brain Registry/);

    const indexResponse = await fetch(`${running.url}/v1/index.json`);
    assert.equal(indexResponse.status, 200);
    const index = await indexResponse.json() as {
      bundles: Array<{ id: string; latest: string }>;
    };
    assert.deepEqual(index.bundles, [{
      id: "brainstorm",
      latest: "0.1.0",
      versions: ["0.1.0"],
    }]);

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

test("MCP exposes static files as resources, with no executable tools", async () => {
  const running = await startContentRegistryServer({ port: 0 });
  const client = new Client({ name: "content-registry-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(running.mcpUrl));
  try {
    await client.connect(transport);
    await assert.rejects(
      client.listTools(),
      /Method not found/,
      "Brain Registry advertises no executable tools",
    );

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
  } finally {
    await transport.close().catch(() => undefined);
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
    assert.equal((await fetch(`${running.url}/health`)).status, 200);
  } finally {
    await running.close();
  }
});
