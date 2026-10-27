#!/usr/bin/env node
/**
 * Convert an exported node-vector file into the registry's precomputed
 * neural index for one (encoder, taxonomy revision):
 *
 *   <store>/embeddings/<encodeURIComponent(encoder id)>/<revision>.json
 *   = {revision, encoder, ids, dim, vectorsB64, vectorsSha256, nodeTextsSha256}
 *
 * which taxonomy_embeddings serves when a client sends {encoder}. <store> is
 * the taxonomy store directory (default deployment: .registry-store/taxonomy).
 *
 * Usage:
 *   node scripts/build-node-vectors.mjs --manifest <encoder manifest.json>
 *     --vectors <rows.f32 | rows.npy> --texts <catalog/taxonomy-texts.json>
 *     --revision <taxonomy revision> --store <taxonomy store dir>
 *     [--ids <ids.json: array or {ids}>] [--force]
 *
 * - vectors: float32 little-endian rows (raw .f32, or a C-order '<f4' .npy),
 *   one row per id, L2-normalized; ids default to the texts asset's entry order.
 * - encoder: the manifest's contract fields (id, dim, version, models, pooling,
 *   docFormat, queryFormat, verification); for ONNX exports the graph checksums
 *   are added to models as "onnx:doc" / "onnx:query", as the app's encoder does.
 * - nodeTextsSha256: the asset's sha256, re-derived from its entries.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function fail(message) {
  console.error(`build-node-vectors: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--force") args.force = true;
    else if (["--manifest", "--vectors", "--texts", "--revision", "--store", "--ids"].includes(key)) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${key} needs a value`);
      args[key.slice(2)] = value;
      i += 1;
    } else fail(`unknown argument ${key}`);
  }
  for (const key of ["manifest", "vectors", "texts", "revision", "store"]) if (!args[key]) fail(`--${key} is required`);
  return args;
}

function readRows(path) {
  const buf = readFileSync(path);
  if (buf.length >= 10 && buf[0] === 0x93 && buf.toString("latin1", 1, 6) === "NUMPY") {
    const major = buf[6];
    const hlen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
    const off = major === 1 ? 10 : 12;
    const header = buf.toString("latin1", off, off + hlen);
    if (!/'descr': '<f4'/.test(header) || /'fortran_order': True/.test(header)) fail(`${path}: only C-order <f4 .npy is supported`);
    const shape = header.match(/'shape': \((\d+), (\d+)\)/);
    if (!shape) fail(`${path}: expected a 2-D array`);
    return { bytes: buf.subarray(off + hlen), rows: Number(shape[1]), dim: Number(shape[2]) };
  }
  return { bytes: buf, rows: undefined, dim: undefined };
}

const args = parseArgs(process.argv.slice(2));
const revision = Number(args.revision);
if (!Number.isSafeInteger(revision) || revision < 1) fail("--revision must be a positive integer");
const manifestFile = JSON.parse(readFileSync(args.manifest, "utf8"));
const encoder = {};
for (const key of ["id", "dim", "version", "models", "pooling", "docFormat", "queryFormat", "verification"]) {
  if (manifestFile[key] === undefined) fail(`manifest lacks ${key}`);
  encoder[key] = manifestFile[key];
}
encoder.models = { ...encoder.models };
if (manifestFile.graphs?.doc?.sha256) encoder.models["onnx:doc"] = manifestFile.graphs.doc.sha256;
if (manifestFile.graphs?.query?.sha256) encoder.models["onnx:query"] = manifestFile.graphs.query.sha256;
const dim = encoder.dim;
if (!Number.isSafeInteger(dim) || dim < 1) fail("manifest dim must be a positive integer");

const asset = JSON.parse(readFileSync(args.texts, "utf8"));
if (!Array.isArray(asset.entries)) fail("texts asset has no entries");
const nodeTextsSha256 = createHash("sha256")
  .update(JSON.stringify(asset.entries.map((entry) => ({ id: entry.id, text: entry.text }))))
  .digest("hex");
if (asset.sha256 !== nodeTextsSha256) fail(`texts asset sha256 ${asset.sha256} does not match its entries (${nodeTextsSha256})`);

let ids = asset.entries.map((entry) => entry.id);
if (args.ids) {
  const parsed = JSON.parse(readFileSync(args.ids, "utf8"));
  ids = Array.isArray(parsed) ? parsed : parsed.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) fail("--ids must hold an array of strings");
}
if (new Set(ids).size !== ids.length) fail("ids are not unique");

const { bytes, rows, dim: npyDim } = readRows(args.vectors);
if (npyDim !== undefined && npyDim !== dim) fail(`vectors have ${npyDim} dims, manifest says ${dim}`);
if (rows !== undefined && rows !== ids.length) fail(`vectors have ${rows} rows for ${ids.length} ids`);
if (bytes.length !== ids.length * dim * 4) fail(`vectors hold ${bytes.length} bytes, expected ${ids.length} x ${dim} x 4`);
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
for (let row = 0; row < ids.length; row += 1) {
  let norm = 0;
  for (let k = 0; k < dim; k += 1) {
    const value = view.getFloat32((row * dim + k) * 4, true);
    if (!Number.isFinite(value)) fail(`row ${row} holds a non-finite value`);
    norm += value * value;
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) fail(`row ${row} (${ids[row]}) is not L2-normalized (norm ${Math.sqrt(norm)})`);
}
const payload = {
  revision,
  encoder,
  ids,
  dim,
  vectorsB64: Buffer.from(bytes).toString("base64"),
  vectorsSha256: createHash("sha256").update(bytes).digest("hex"),
  nodeTextsSha256,
};
const name = encodeURIComponent(encoder.id);
if (name === "" || name === "." || name === "..") fail(`encoder id "${encoder.id}" cannot name a directory`);
const out = join(args.store, "embeddings", name, `${revision}.json`);
if (existsSync(out) && !args.force) fail(`${out} exists (pass --force to replace it)`);
mkdirSync(dirname(out), { recursive: true });
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
renameSync(tmp, out);
console.log(JSON.stringify({ out, encoder: encoder.id, revision, ids: ids.length, dim, vectorsSha256: payload.vectorsSha256, nodeTextsSha256 }));
