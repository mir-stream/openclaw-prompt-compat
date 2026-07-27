import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CheckError,
  checkAnchorLiterals,
  checkRenderedFingerprint,
  findBuilderFiles,
  inspectTargets,
  renderHumanReport,
  renderMarkdownReport,
} from "../scripts/check-upstream-fingerprint.mjs";

const ANCHORS = [
  { id: "identity", exportName: "IDENTITY", literal: "You are OpenClaw." },
  { id: "tooling", exportName: "TOOLING", literal: "## Tooling" },
  { id: "safety", exportName: "SAFETY", literal: "## Safety" },
  { id: "workspace", exportName: "WORKSPACE", literal: "## Workspace" },
  { id: "runtime", exportName: "RUNTIME", literal: "## Runtime" },
];

function fixtureWithout(missingId) {
  const root = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-test-"));
  const dist = path.join(root, "dist");
  mkdirSync(dist);
  const present = ANCHORS.filter((anchor) => anchor.id !== missingId);
  const declarations = present
    .map((anchor, index) => `const marker${index} = ${JSON.stringify(anchor.literal)};`)
    .join("\n");
  writeFileSync(
    path.join(dist, "system-prompt.js"),
    `${declarations}
function buildAgentSystemPrompt() { return [${present.map((_, index) => `marker${index}`).join(", ")}].join("\\n"); }
export { buildAgentSystemPrompt };
`,
  );
  writeFileSync(path.join(root, "package.json"), '{"dependencies":{}}\n');
  return root;
}

function assertMissingAnchorIsDrift(missingId) {
  const packageRoot = fixtureWithout(missingId);
  const workDir = path.join(packageRoot, "work");
  mkdirSync(workDir);
  try {
    const builders = findBuilderFiles(packageRoot, ANCHORS);
    assert.equal(builders.length, 1);
    const literalCheck = checkAnchorLiterals({
      anchors: ANCHORS,
      builders,
      packageRoot,
      workDir,
      spec: "openclaw@test",
    });
    assert.deepEqual(
      literalCheck.missing.map((anchor) => anchor.id),
      [missingId],
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
}

test("discovers the builder and reports drift when identity is missing", () => {
  assertMissingAnchorIsDrift("identity");
});

test("discovers the builder and reports drift when Tooling is missing", () => {
  assertMissingAnchorIsDrift("tooling");
});

test("reserves CheckError for a package without enough builder evidence", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-test-"));
  try {
    writeFileSync(path.join(root, "unrelated.js"), 'export const value = "## Safety";\n');
    assert.throws(() => findBuilderFiles(root, ANCHORS), CheckError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports render-not-run results as partial in human and Markdown output", () => {
  const result = {
    version: "2026.7.2",
    tags: ["latest"],
    builderFiles: ["dist/system-prompt.js"],
    literalCheck: { ran: true, found: ANCHORS, missing: [] },
    renderCheck: { ran: false, reason: "install unavailable" },
    drift: false,
    driftReasons: [],
  };

  const human = renderHumanReport([result]);
  const markdown = renderMarkdownReport([result]);
  assert.match(human, /LAYER A PASS \(PARTIAL\)/);
  assert.match(human, /full fingerprint was not verified/);
  assert.doesNotMatch(human, /still carry the fingerprint/);
  assert.match(markdown, /Layer A passed \(partial\)/);
  assert.match(markdown, /Coverage is partial; the full fingerprint was not verified/);
  assert.match(markdown, /install unavailable/);
});

test("turns npm install spawn failures into a render-not-run result", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-render-test-"));
  try {
    const result = checkRenderedFingerprint({
      version: "2026.7.2",
      fingerprint: /unused/,
      workDir,
      anchors: ANCHORS,
      runNpmCommand() {
        throw new CheckError("failed to start: ETIMEDOUT");
      },
    });
    assert.deepEqual(result, {
      ran: false,
      reason:
        "npm install openclaw@2026.7.2 could not run: failed to start: ETIMEDOUT",
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("continues from an unrenderable decoy builder to a later real builder", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-fallback-test-"));
  try {
    const result = checkRenderedFingerprint({
      version: "2026.7.2",
      fingerprint: /You are OpenClaw\.[\s\S]*## Tooling[\s\S]*## Runtime/,
      workDir,
      anchors: ANCHORS,
      runNpmCommand(_args, { cwd }) {
        const dist = path.join(cwd, "node_modules", "openclaw", "dist");
        mkdirSync(dist, { recursive: true });
        const declarations = ANCHORS.map(
          (anchor, index) => `const marker${index} = ${JSON.stringify(anchor.literal)};`,
        ).join("\n");
        writeFileSync(
          path.join(dist, "a-decoy.mjs"),
          `${declarations}
function buildDecoyAgentSystemPrompt() { throw new Error("decoy cannot render"); }
export { buildDecoyAgentSystemPrompt };
`,
        );
        writeFileSync(
          path.join(dist, "z-real.mjs"),
          `${declarations}
function buildRealAgentSystemPrompt() {
  return [${ANCHORS.map((_, index) => `marker${index}`).join(", ")}].join("\\n");
}
export { buildRealAgentSystemPrompt };
`,
        );
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.ran, true);
    assert.equal(result.builderExport, "buildRealAgentSystemPrompt");
    assert.equal(result.modes.default.matched, true);
    assert.equal(result.modes.minimal.matched, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("retains completed targets and reports later fatal target failures", () => {
  const completed = {
    version: "2026.7.1",
    tags: ["latest"],
    builderFiles: ["dist/system-prompt.js"],
    literalCheck: { ran: true, found: ANCHORS, missing: [] },
    renderCheck: { ran: false, reason: "disabled for fixture" },
    drift: false,
    driftReasons: [],
  };
  const inspected = [];
  const { results, failures } = inspectTargets({
    targets: [
      { version: "2026.7.1", tags: ["latest"] },
      { version: "2026.7.2-beta.1", tags: ["beta"] },
    ],
    inspectTarget(target) {
      inspected.push(target.version);
      if (target.version === "2026.7.2-beta.1") {
        throw new CheckError("corrupt tarball");
      }
      return completed;
    },
  });

  assert.deepEqual(inspected, ["2026.7.1", "2026.7.2-beta.1"]);
  assert.deepEqual(results, [completed]);
  assert.deepEqual(failures, [
    {
      version: "2026.7.2-beta.1",
      tags: ["beta"],
      error: "corrupt tarball",
    },
  ]);
  const human = renderHumanReport(results, failures);
  const markdown = renderMarkdownReport(results, failures);
  assert.match(human, /openclaw@2026\.7\.1.*LAYER A PASS \(PARTIAL\)/);
  assert.match(human, /openclaw@2026\.7\.2-beta\.1.*CHECK FAILED/);
  assert.match(human, /Completed 1 target\(s\); 1 target\(s\) failed/);
  assert.match(markdown, /Layer A passed \(partial\)/);
  assert.match(markdown, /openclaw@2026\.7\.2-beta\.1/);
  assert.match(markdown, /No conclusion is available for this target/);
});
