import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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
    assert.match(result.candidateFailures.join("\n"), /decoy cannot render/);
    assert.equal(result.modes.default.matched, true);
    assert.equal(result.modes.minimal.matched, true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function checkRenderedBuilderSet(builders) {
  const workDir = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-candidates-test-"));
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
      for (const { file, exportName, matches } of builders) {
        const rendered = matches
          ? `[${ANCHORS.map((_, index) => `marker${index}`).join(", ")}].join("\\n")`
          : `"rendered prompt without the fingerprint"`;
        writeFileSync(
          path.join(dist, file),
          `${declarations}
function ${exportName}() { return ${rendered}; }
export { ${exportName} };
`,
        );
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  rmSync(workDir, { recursive: true, force: true });
  return result;
}

for (const fixture of [
  [
    { file: "a-match.mjs", exportName: "buildMatchingAgentSystemPrompt", matches: true },
    { file: "z-mismatch.mjs", exportName: "buildRejectingAgentSystemPrompt", matches: false },
  ],
  [
    { file: "a-mismatch.mjs", exportName: "buildRejectingAgentSystemPrompt", matches: false },
    { file: "z-match.mjs", exportName: "buildMatchingAgentSystemPrompt", matches: true },
  ],
]) {
  test(`reports render ambiguity regardless of candidate order (${fixture[0].file} first)`, () => {
    const result = checkRenderedBuilderSet(fixture);
    assert.equal(result.ran, false);
    assert.match(result.reason, /ambiguous real-render candidates disagree/);
    assert.match(result.reason, /default=true, minimal=true/);
    assert.match(result.reason, /default=false, minimal=false/);
  });
}

test("accepts multiple usable builders that agree and selects deterministically", () => {
  const result = checkRenderedBuilderSet([
    { file: "z-match.mjs", exportName: "buildZedAgentSystemPrompt", matches: true },
    { file: "a-match.mjs", exportName: "buildAlphaAgentSystemPrompt", matches: true },
  ]);
  assert.equal(result.ran, true);
  assert.equal(result.builderExport, "buildAlphaAgentSystemPrompt");
  assert.deepEqual(result.builderCandidates, [
    "dist/a-match.mjs:buildAlphaAgentSystemPrompt",
    "dist/z-match.mjs:buildZedAgentSystemPrompt",
  ]);
  assert.equal(result.modes.default.matched, true);
  assert.equal(result.modes.minimal.matched, true);
});

test("fails Layer B closed when one quorum file exceeds the export candidate limit", () => {
  const workDir = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-cap-test-"));
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
        const excessiveExports = [
          "Alpha",
          "Beta",
          "Gamma",
          "Delta",
          "Epsilon",
          "Zeta",
          "Eta",
          "Theta",
          "Iota",
        ].map((name) => `build${name}AgentSystemPrompt`);
        writeFileSync(
          path.join(dist, "a-over-limit.mjs"),
          `${declarations}
${excessiveExports.map((name) => `function ${name}() { return "unused"; }`).join("\n")}
export { ${excessiveExports.join(", ")} };
`,
        );
        writeFileSync(
          path.join(dist, "z-usable.mjs"),
          `${declarations}
function buildUsableAgentSystemPrompt() {
  return [${ANCHORS.map((_, index) => `marker${index}`).join(", ")}].join("\\n");
}
export { buildUsableAgentSystemPrompt };
`,
        );
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(result.ran, false);
    assert.equal("builderExport" in result, false);
    assert.match(result.reason, /exceeded the 8-candidate aggregate limit/);
    assert.match(result.reason, /a-over-limit\.mjs: 9 exports exceeded/);
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

test("embedded publisher keeps a hostile render reason inert in created Markdown", async () => {
  const workflow = readFileSync(".github/workflows/upstream-watch.yml", "utf8");
  const marker = "          script: |\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1);
  const scriptLines = [];
  for (const line of workflow.slice(start + marker.length).split("\n")) {
    if (line.length === 0) {
      scriptLines.push("");
      continue;
    }
    if (!line.startsWith("            ")) break;
    scriptLines.push(line.slice(12));
  }
  const publisherScript = scriptLines.join("\n");

  const anchorIds = [
    "identity",
    "tooling",
    "safety",
    "workspace",
    "workspaceFiles",
    "cacheBoundary",
    "runtime",
  ];
  const hostileReason =
    "[click](https://evil.example) @octocat **bold** <b>html</b> `tick` " +
    "<!-- evil-marker --> \u202E\u2066hidden";
  const versionEntry = (version, tags, { missingIdentity = false, reason }) => ({
    version,
    tags,
    drift: missingIdentity,
    literalCheck: {
      ran: true,
      found: anchorIds
        .filter((id) => !missingIdentity || id !== "identity")
        .map((id) => ({ id })),
      missing: missingIdentity
        ? [{ id: "identity", literal: "You are OpenClaw.", nearest: [] }]
        : [],
    },
    renderCheck: { ran: false, reason },
    issueTitle: "artifact-controlled title must be ignored",
    issueBody: "artifact-controlled body must be ignored",
    digest: "000000000000",
  });
  const report = {
    incomplete: false,
    watchedDistTags: ["latest", "beta"],
    drift: true,
    versions: [
      versionEntry("2026.7.2", ["latest"], {
        missingIdentity: true,
        reason: hostileReason,
      }),
      versionEntry("2026.7.3-beta.1", ["beta"], {
        reason: "render unavailable",
      }),
    ],
  };

  const createdIssues = [];
  const listForRepo = async () => {};
  const listComments = async () => {};
  const github = {
    paginate: async (method) => (method === listForRepo ? [] : []),
    rest: {
      issues: {
        createLabel: async () => {},
        listForRepo,
        listComments,
        create: async (input) => {
          createdIssues.push(input);
          return { data: { number: 17 } };
        },
        createComment: async () => {},
      },
    },
  };
  const actualRequire = createRequire(import.meta.url);
  const mockedRequire = (specifier) => {
    if (specifier === "node:fs") {
      return {
        statSync: () => ({ size: JSON.stringify(report).length }),
        readFileSync: () => JSON.stringify(report),
      };
    }
    if (specifier === "node:child_process") {
      return {
        execFileSync: () =>
          JSON.stringify({ latest: "2026.7.2", beta: "2026.7.3-beta.1" }),
      };
    }
    return actualRequire(specifier);
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runPublisher = new AsyncFunction(
    "require",
    "process",
    "github",
    "context",
    "core",
    publisherScript,
  );
  await runPublisher(
    mockedRequire,
    { env: { REPORT_PATH: "/mock/report.json" } },
    github,
    { repo: { owner: "owner", repo: "repo" } },
    { notice() {}, info() {} },
  );

  assert.equal(createdIssues.length, 1);
  assert.equal(
    createdIssues[0].title,
    "OpenClaw 2026.7.2: system-prompt fingerprint no longer matches",
  );
  assert.doesNotMatch(createdIssues[0].body, /artifact-controlled/);
  const checksLine = createdIssues[0].body
    .split("\n")
    .find((line) => line.startsWith("- **Checks run:**"));
  assert.ok(checksLine);
  const firstBacktick = checksLine.indexOf("`");
  const lastBacktick = checksLine.lastIndexOf("`");
  assert.notEqual(firstBacktick, -1);
  assert.ok(lastBacktick > firstBacktick);
  assert.equal(checksLine.match(/`/g).length, 2);
  const inertReason = checksLine.slice(firstBacktick + 1, lastBacktick);
  assert.match(inertReason, /\[click\]\(https:\/\/evil\.example\)/);
  assert.match(inertReason, /@octocat/);
  assert.match(inertReason, /\*\*bold\*\*/);
  assert.match(inertReason, /&lt;b&gt;html&lt;\/b&gt;/);
  assert.match(inertReason, /&#96;tick&#96;/);
  assert.match(inertReason, /&lt;!-- evil-marker --&gt;/);
  assert.doesNotMatch(inertReason, /\p{Cf}/u);
});
