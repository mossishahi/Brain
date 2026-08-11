# Brain Registry

The centralized, authoritative static content used by Brain apps: role and technique skills,
workflow definitions, capability declarations, catalogs, and logical model routes.

Brain Registry contains no domain processing. Its tiny transport does not parse front matter, validate
workflows, resolve dependencies, bind `{{variables}}`, select skills, choose tools, call models,
or execute workflows. It only lists and returns committed files. The host server downloads one
immutable bundle version, verifies every byte against the committed SHA-256 manifest,
materializes it per job, and performs all parsing/validation/execution locally.

## Static layout

```text
content/
  index.json
  bundles/
    brainstorm/
      0.1.0/
        manifest.json
        workflows/
        skills/
          roles/
          techniques/
        capabilities/
        catalog/
        routes/
```

`index.json` lists available immutable versions. Each `manifest.json` declares its runtime
protocol and every file's path, media type, byte count, and SHA-256 digest. A job resolves
`latest` once, then records and uses the resulting concrete version + manifest digest forever.

## Read-only interfaces

HTTP:

- `GET /v1/index.json`
- `GET /v1/bundles/{bundle}/{version}/manifest.json`
- `GET /v1/bundles/{bundle}/{version}/{path}`
- `GET /health`

MCP is available at `/mcp`. Bundle content is served through **resources only**
(`resources/list` and `resources/read`) — no tool returns bundle files. When the shared-taxonomy
store is enabled (a taxonomy seed or an existing store is present, which is the default), the
server additionally advertises exactly four taxonomy tools: `taxonomy_resolve`, `taxonomy_tree`,
`taxonomy_embeddings`, and `taxonomy_suggest`. Reads answer from the latest committed revision;
`taxonomy_suggest` appends to a review queue and never mutates the tree.
Consumers read `index.json` and one manifest first, then request exact role/technique resources
only when needed. The service applies safe-path checks, bounded request bodies/sessions, and a
per-client rate limit.

## Running

```bash
npm install
npm run build
node dist/src/main.js --host 127.0.0.1 --port 51011
```

To expose it remotely, bind an externally reachable interface behind TLS and authentication:

```bash
node dist/src/main.js --host 0.0.0.0 --port 51011
```

The generic transport itself currently has no authentication; do not expose it directly to the
public internet without trusted TLS and edge hardening. The current content is public; deployment
assets for HTTPS on a bare IP are documented in [`deploy/README.md`](deploy/README.md).

## Authoring and publishing

The repo carries exactly ONE copy of the content: `content-src/<bundle>/`, the editable source
tree (its `bundle.json` declares the runtime protocol and entrypoints). Releases are **annotated
git tags** named `<bundle>/v<semver>` whose tree is the bundle content — no version directories
live in the repo.

To release the current source:

```bash
npm run publish-bundle -- brainstorm 0.5.0 --notes "What changed, one line."
```

This stamps the workflow's bundle version, hashes the source into a git tree (your branch and
staging area are untouched), commits it with the previous release as parent, and tags it. The
notes become the release metadata consumers see.

Serving: the registry server materializes `.registry-store/` (gitignored) from the release tags
at startup, and rescans on a TTL — a freshly pushed tag appears in the served `index.json`
(versions, `latest`, per-version release notes) within a minute, and connected MCP clients get a
`resources/list_changed` notification. Published versions are immutable by construction: the
store is append-only and every version's SHA-256 manifest is generated from the immutable tag.

To run against unpublished work-in-progress content, point the worker at the source tree
(`--content-dir .../content-src/brainstorm/`) or set `BRAIN_TEST_CONTENT_DIR` for the app tests.
App test suites materialize the store themselves via `scripts/materialize-store.mjs`.

Deployment note: release mode requires `git` and the repo (with tags) on the host. To serve a
prebuilt store without git, materialize it first and pass `--content-root <store>`.
