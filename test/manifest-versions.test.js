import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The version lives in two independent places: package.json (what npm
 * publishes) and openclaw.plugin.json (what OpenClaw reads at load time).
 * Nothing keeps them in step, so bumping one and forgetting the other ships a
 * package whose manifest reports a version the tarball never had.
 *
 * release.yml already refuses to publish when the two disagree — but that gate
 * only fires once a tag is pushed, which is days after the mistake was
 * committed and precisely when someone is trying to ship. This test exists to
 * move discovery to the commit that caused it: it runs in `npm test`, so CI
 * flags the mismatch on the push and the pull request that introduced it.
 *
 * Deliberately no assertion on the version *format*. The `vX.Y.Z` rule is
 * enforced by release.yml's tag gate; restating it here would mean two places
 * define it, and whoever changes one is not told the other exists.
 */
test("package.json and openclaw.plugin.json declare the same version", async () => {
  const [packageJson, manifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  // Both values go in the message: the failure has to say which file drifted,
  // because the log is all the next person gets from a CI run.
  assert.equal(
    manifest.version,
    packageJson.version,
    `Version mismatch: package.json is ${JSON.stringify(packageJson.version)}, ` +
      `openclaw.plugin.json is ${JSON.stringify(manifest.version)}. ` +
      "Both files must be bumped together.",
  );
});
