import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The version lives in three places: package.json (what npm publishes),
 * openclaw.plugin.json (what OpenClaw reads at load time) and package-lock.json
 * (which npm derives, in two fields). Nothing keeps them in step, so bumping one
 * and forgetting the others ships a package whose manifest reports a version the
 * tarball never had.
 *
 * This is not hypothetical. When this test was written the lockfile still said
 * 0.1.0 while the package was at 0.3.0 — two releases of drift that nothing
 * caught, because npm reconciles the dependency graph on `npm ci` but never the
 * root version field. That is the signature of bumping the version by editing
 * package.json rather than running `npm version`, which would have rewritten all
 * of them together.
 *
 * release.yml already refuses to publish when the tag and the two manifests
 * disagree — but that gate only fires once a tag is pushed, which is days after
 * the mistake was committed and precisely when someone is trying to ship. This
 * test exists to move discovery to the commit that caused it: it runs in
 * `npm test`, so CI flags the mismatch on the push and the pull request that
 * introduced it.
 *
 * Deliberately no assertion on the version *format*. The `vX.Y.Z` rule is
 * enforced by release.yml's tag gate; restating it here would mean two places
 * define it, and whoever changes one is not told the other exists.
 */
test("every manifest declares the same version", async () => {
  const [packageJson, manifest, lockfile] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  // Every comparison below is against package.json, so if it carried no version
  // at all the whole test would reduce to `undefined === undefined` and pass
  // while checking nothing. A guard that goes green without verifying anything
  // is worse than no guard, so establish the reference value first.
  assert.equal(
    typeof packageJson.version,
    "string",
    "package.json declares no version string, so there is nothing to compare against.",
  );

  // Both values go in every message: the failure has to say which file drifted,
  // because the log is all the next person gets from a CI run.
  const expected = packageJson.version;
  const actuals = [
    ["openclaw.plugin.json", manifest.version],
    ["package-lock.json", lockfile.version],
    ['package-lock.json packages[""]', lockfile.packages?.[""]?.version],
  ];

  for (const [source, actual] of actuals) {
    assert.equal(
      actual,
      expected,
      `Version mismatch: package.json is ${JSON.stringify(expected)}, ` +
        `${source} is ${JSON.stringify(actual)}. ` +
        "Bump them together — `npm version` does this for you.",
    );
  }
});
