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

MCP is available at `/mcp` using **resources only** (`resources/list` and `resources/read`).
Brain Registry advertises no executable MCP tools.
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

## Publishing a new version

Content versions are immutable. Copy the previous version to a new directory, edit only the new
directory, regenerate its committed manifest with:

```bash
npm run manifest -- brainstorm 0.2.0 brainstorm.workflow/v1
```

Validate it through the app test suite, then add the new version to `content/index.json` atomically.
Never modify files under a published version:
hosts and caches are entitled to treat versioned URLs as immutable.
