/**
 * The publish gate's proof that the app suite executed the candidate.
 *
 * The environment variables publish-bundle.mjs sets are a REQUEST, not a
 * result. Its first wiring set only the store directory and assumed that
 * carried the candidate into the suite; it did not — a store cannot move a
 * suite off a version pin — so the gate built a candidate store and then
 * watched the server suite execute the previous release, green. That is the
 * original bug rebuilt inside the check meant to catch it, and no amount of
 * care in setting environment variables can detect it, because setting a
 * variable is not evidence that anything read it. The receipt is: it is
 * written by the code that resolves the bundle, at the moment it resolves one,
 * and it names what that code chose.
 *
 * This lives beside the gate rather than inside it so the refusals can be
 * exercised directly. A gate whose only test is a real publish is a gate
 * nobody tests: publishing creates an immutable tag, so the one code path that
 * must never be wrong would otherwise be the one path never run on purpose.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Written by apps/server/test/server.test.ts (recordBundleUsed), whose field
 * names this gate must match exactly.
 */
export const RECEIPT_FILE = ".test-bundle-used.json";

/**
 * The fields compared. All must be present, non-empty strings.
 *
 * `storeRoot` is the store ROOT the suite read, deliberately not the receipt's
 * `bundleDir` — that one is the per-version directory inside it, and comparing
 * the wrong one of the two would accept a receipt from any version that
 * happened to live in the right store. Extra fields (bundleDir, suite,
 * writtenAt) are ignored: the writer may add to its account without the gate
 * needing a change.
 */
export const RECEIPT_FIELDS = ["bundle", "version", "storeRoot"];

/**
 * True when two paths name the same directory through different symlinks.
 *
 * Not an edge case: this is the NORMAL comparison during a publish. The gate
 * hands the suite a `mkdtempSync(tmpdir())` store, which on macOS is
 * /var/folders/…, and the suite records `realpathSync` of what it read, which
 * is /private/var/folders/… — the same directory spelled two ways. A plain
 * string compare would refuse every real publish while passing every test run
 * from a path that happens not to be symlinked.
 */
function sameDir(left, right) {
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      // Gone or unreadable: the literal path is all the comparison can use.
      return resolve(path);
    }
  };
  return resolve(left) === resolve(right) || real(left) === real(right);
}

/**
 * Turn the receipt into a verdict. Throws on anything short of proof —
 * including its absence, which is the case worth being loudest about: a green
 * suite that wrote no receipt never reached the resolver, so nothing executed
 * the candidate. Silently accepting that is exactly --no-app-check without the
 * operator ever choosing it.
 *
 * `root` only shortens paths in the messages; it never affects the verdict.
 */
export function confirmSuiteRanCandidate({ receiptPath, store, bundle, version, root }) {
  const shown = root && relative(root, receiptPath).length < receiptPath.length
    ? relative(root, receiptPath)
    : receiptPath;
  if (!existsSync(receiptPath)) {
    throw new Error(
      `the app suite left no receipt at ${shown} — not tagging.\n` +
        `  expected: a receipt naming ${bundle}@${version} out of ${store}\n` +
        "  found:    no file at all (the gate deleted any stale one before the run, so this\n" +
        "            is silence from THIS run, not a leftover that went missing)\n" +
        "A suite that passes without writing a receipt never reached the code that resolves a\n" +
        "bundle version, which means nothing in it executed this candidate. Green would have\n" +
        "meant only that the app's own tests pass. Check that the suite still writes the\n" +
        "receipt, then publish again.",
    );
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(
      `the receipt at ${shown} is not readable JSON — not tagging (${error.message}).\n` +
        `  expected: {"bundle": "${bundle}", "version": "${version}", "storeRoot": "${store}"}\n` +
        "A receipt the gate cannot read proves nothing, and an unprovable gate is not a gate.",
    );
  }
  const missing = RECEIPT_FIELDS.filter(
    (field) => typeof receipt?.[field] !== "string" || receipt[field].length === 0,
  );
  if (missing.length > 0) {
    throw new Error(
      `the receipt at ${shown} is missing ${missing.join(", ")} — not tagging.\n` +
        `  expected: {"bundle": "${bundle}", "version": "${version}", "storeRoot": "${store}"}\n` +
        `  found:    ${JSON.stringify(receipt)}\n` +
        "The gate must be able to compare all three: bundle and version say WHAT ran, storeRoot\n" +
        "says it came from the candidate store this run built rather than the real registry.\n" +
        "A receipt of this shape means the writer and this gate disagree about field names —\n" +
        "reconcile them rather than dropping the check, since a skipped check is the whole bug.",
    );
  }
  // Report every disagreement at once. A version mismatch and a store mismatch
  // mean different things — the pin won, versus the suite read the registry's
  // own store — and an operator who sees only the first fixes the wrong thing.
  const wrong = [];
  if (receipt.bundle !== bundle) wrong.push(`bundle ${receipt.bundle} (expected ${bundle})`);
  if (receipt.version !== version) wrong.push(`version ${receipt.version} (expected ${version})`);
  if (!sameDir(receipt.storeRoot, store)) {
    wrong.push(`storeRoot ${receipt.storeRoot} (expected ${store})`);
  }
  if (wrong.length > 0) {
    throw new Error(
      `the app suite executed something other than this candidate — not tagging.\n` +
        `  expected: ${bundle}@${version} out of ${store}\n` +
        `  found:    ${receipt.bundle}@${receipt.version} out of ${receipt.storeRoot}\n` +
        `  wrong:    ${wrong.join("; ")}\n` +
        "The suite runs the version pinned in the app's test-bundle.json unless the gate's\n" +
        "BRAIN_TEST_BUNDLE_VERSION reaches its resolver; when it does not, the version it runs\n" +
        "is the PREVIOUS release, and a green result would say nothing about this one.",
    );
  }
}
