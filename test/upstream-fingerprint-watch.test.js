import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  CheckError,
  checkAnchorLiterals,
  checkRenderedFingerprint,
  classifyFingerprintFindings,
  findBuilderExports,
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

function fixtureWithout(missingId, decoySource = "") {
  const root = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-test-"));
  const dist = path.join(root, "dist");
  mkdirSync(dist);
  const present = ANCHORS.filter((anchor) => anchor.id !== missingId);
  const declarations = present
    .map((anchor, index) => `const marker${index} = ${JSON.stringify(anchor.literal)};`)
    .join("\n");
  writeFileSync(
    path.join(dist, "system-prompt.js"),
    `${decoySource}
${declarations}
function buildAgentSystemPrompt() { return [${present.map((_, index) => `marker${index}`).join(", ")}].join("\\n"); }
export { buildAgentSystemPrompt };
`,
  );
  writeFileSync(path.join(root, "package.json"), '{"dependencies":{}}\n');
  return root;
}

function assertMissingAnchorIsDrift(missingId, decoySource = "") {
  const packageRoot = fixtureWithout(missingId, decoySource);
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

test("does not count an anchor preserved only in a block comment", () => {
  assertMissingAnchorIsDrift("identity", '/* const old = "You are OpenClaw."; */');
});

test("does not count an anchor preserved only in a line comment", () => {
  assertMissingAnchorIsDrift("identity", '// const old = "You are OpenClaw.";');
});

test("does not count anchor text in a regex literal", () => {
  assertMissingAnchorIsDrift("safety", "const oldSafetyPattern = /## Safety/;");
});

test("indexes quote/template segments and comment-looking string content", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-literals-test-"));
  const dist = path.join(root, "dist");
  mkdirSync(dist);
  try {
    writeFileSync(
      path.join(dist, "system-prompt.js"),
      `const identity = 'You are OpenClaw.';
const tooling = \`## Tooling\${dynamicSuffix}\`;
const safety = "// still string content\\n## Safety\\n/* still string content */";
const workspace = "## Workspace";
const runtime = \`before\\n## Runtime\\nafter\`;
function buildAgentSystemPrompt() {
  return [identity, tooling, safety, workspace, runtime].join("\\n");
}
export { buildAgentSystemPrompt };
`,
    );
    writeFileSync(path.join(root, "package.json"), '{"dependencies":{}}\n');
    const builders = findBuilderFiles(root, ANCHORS);
    const literalCheck = checkAnchorLiterals({
      anchors: ANCHORS,
      builders,
      packageRoot: root,
      workDir: path.join(root, "work"),
      spec: "openclaw@test",
    });
    assert.deepEqual(literalCheck.missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovers and passes builders whose anchors use legal mixed escapes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fingerprint-watch-escapes-test-"));
  const dist = path.join(root, "dist");
  mkdirSync(dist);
  try {
    writeFileSync(
      path.join(dist, "system-prompt.js"),
      [
        'const identity = "\\u0059ou are OpenClaw.";',
        'const tooling = "\\x23# Tooling";',
        "const safety = `\\u{23}# Safety`;",
        'const workspace = "\\u0023\\x23 Workspace";',
        'const runtime = "## \\u0052untime";',
        "function buildAgentSystemPrompt() {",
        '  return [identity, tooling, safety, workspace, runtime].join("\\n");',
        "}",
        "export { buildAgentSystemPrompt };",
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(root, "package.json"), '{"dependencies":{}}\n');
    const builders = findBuilderFiles(root, ANCHORS);
    assert.equal(builders.length, 1);
    const literalCheck = checkAnchorLiterals({
      anchors: ANCHORS,
      builders,
      packageRoot: root,
      workDir: path.join(root, "work"),
      spec: "openclaw@test",
    });
    assert.deepEqual(literalCheck.missing, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds a sole pending dependency anchor encoded with escapes", () => {
  const packageRoot = fixtureWithout(null);
  const dependencyRoot = mkdtempSync(
    path.join(tmpdir(), "fingerprint-watch-dependency-escapes-test-"),
  );
  const cacheAnchor = {
    id: "cacheBoundary",
    exportName: "CACHE_BOUNDARY",
    literal: "<!-- OPENCLAW_CACHE_BOUNDARY -->",
  };
  try {
    writeFileSync(
      path.join(packageRoot, "package.json"),
      '{"dependencies":{"@openclaw/ai":"1.0.0"}}\n',
    );
    const dependencyDist = path.join(dependencyRoot, "dist");
    mkdirSync(dependencyDist);
    writeFileSync(
      path.join(dependencyDist, "cache-boundary.js"),
      'export const boundary = "\\x3c!-- OPENCLAW_CACHE_BOUNDARY --\\u003e";\n',
    );
    const anchors = [...ANCHORS, cacheAnchor];
    const builders = findBuilderFiles(packageRoot, anchors);
    const literalCheck = checkAnchorLiterals({
      anchors,
      builders,
      packageRoot,
      workDir: path.join(packageRoot, "work"),
      spec: "openclaw@test",
      unpackPackageCommand(spec) {
        assert.equal(spec, "@openclaw/ai@1.0.0");
        return dependencyRoot;
      },
    });

    assert.deepEqual(literalCheck.missing, []);
    assert.match(
      literalCheck.found.find((anchor) => anchor.id === "cacheBoundary").location,
      /^@openclaw\/ai@1\.0\.0:/,
    );
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(dependencyRoot, { recursive: true, force: true });
  }
});

test("does not let Workspace Files satisfy the Workspace anchor", () => {
  assertMissingAnchorIsDrift(
    "workspace",
    'const workspaceFilesOnly = "## Workspace Files (injected)";',
  );
});

function parseJavaScript(source) {
  return ts.createSourceFile(
    "fixture.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
}

test("ignores prompt-builder export text in comments and strings", () => {
  const sourceFile = parseJavaScript(`
// export { buildCommentAgentSystemPrompt };
const decoy = "export { buildStringAgentSystemPrompt as builder }";
/* export { buildBlockAgentSystemPrompt } */
`);
  assert.deepEqual(findBuilderExports(sourceFile), []);
});

test("finds legitimate bare and aliased prompt-builder exports", () => {
  const sourceFile = parseJavaScript(`
const buildBareAgentSystemPrompt = () => "";
const buildAliasedAgentSystemPrompt = () => "";
export {
  buildBareAgentSystemPrompt,
  buildAliasedAgentSystemPrompt as publicBuilder,
};
`);
  assert.deepEqual(findBuilderExports(sourceFile), [
    { alias: "buildBareAgentSystemPrompt", original: "buildBareAgentSystemPrompt" },
    { alias: "publicBuilder", original: "buildAliasedAgentSystemPrompt" },
  ]);
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

function missingIdentityLiteralCheck() {
  return {
    ran: true,
    found: ANCHORS.filter((anchor) => anchor.id !== "identity"),
    missing: [{ id: "identity", literal: "You are OpenClaw.", nearest: [] }],
  };
}

function renderCheck(defaultMatched, minimalMatched) {
  return {
    ran: true,
    builderExport: "buildAgentSystemPrompt",
    modes: {
      default: { matched: defaultMatched, firstLine: "You are OpenClaw.", headings: [] },
      minimal: { matched: minimalMatched, firstLine: "You are OpenClaw.", headings: [] },
    },
  };
}

test("treats a missing source literal as diagnostic when both real renders match", () => {
  const literalCheck = missingIdentityLiteralCheck();
  const checkedRender = renderCheck(true, true);
  assert.deepEqual(classifyFingerprintFindings(literalCheck, checkedRender), {
    driftReasons: [],
    sourceLayoutDiagnostics: ["identity"],
  });

  const result = {
    version: "2026.7.2",
    tags: ["latest"],
    builderFiles: ["dist/system-prompt.js"],
    literalCheck,
    renderCheck: checkedRender,
    drift: false,
    driftReasons: [],
    sourceLayoutDiagnostics: ["identity"],
  };
  const human = renderHumanReport([result]);
  const markdown = renderMarkdownReport([result]);
  assert.match(human, /PASS \(SOURCE-LAYOUT DIAGNOSTIC\)/);
  assert.match(human, /LAYOUT\s+identity/);
  assert.doesNotMatch(human, /both layers passed/i);
  assert.match(markdown, /real-render fingerprint passed \(source-layout diagnostic\)/);
  assert.match(markdown, /not runtime drift/);
  assert.doesNotMatch(markdown, /anchor literals and real rendered prompt both passed/);
});

test("keeps a missing source literal as drift when real rendering is unavailable", () => {
  const classified = classifyFingerprintFindings(missingIdentityLiteralCheck(), {
    ran: false,
    reason: "render unavailable",
  });
  assert.equal(classified.sourceLayoutDiagnostics.length, 0);
  assert.match(classified.driftReasons.join("\n"), /identity.*not present as a string literal/);
});

test("keeps a missing source literal as drift when one real render mismatches", () => {
  const classified = classifyFingerprintFindings(
    missingIdentityLiteralCheck(),
    renderCheck(true, false),
  );
  assert.equal(classified.sourceLayoutDiagnostics.length, 0);
  assert.match(classified.driftReasons.join("\n"), /identity.*not present as a string literal/);
  assert.match(classified.driftReasons.join("\n"), /real minimal render/);
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

function loadPublisherScript() {
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
  return scriptLines.join("\n");
}

test("artifact upload overwrites the stable report name on job reruns", () => {
  const workflow = readFileSync(".github/workflows/upstream-watch.yml", "utf8");
  assert.match(
    workflow,
    /uses: actions\/upload-artifact@v4[\s\S]*?name: fingerprint-report[\s\S]*?overwrite: true/,
  );
});

test("embedded publisher accepts render-confirmed source-layout diagnostics and sanitizes drift", async () => {
  const publisherScript = loadPublisherScript();

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
  const versionEntry = (
    version,
    tags,
    { missingIdentity = false, reason, renderModes },
  ) => ({
    version,
    tags,
    drift: missingIdentity && !renderModes,
    literalCheck: {
      ran: true,
      found: anchorIds
        .filter((id) => !missingIdentity || id !== "identity")
        .map((id) => ({ id })),
      missing: missingIdentity
        ? [{ id: "identity", literal: "You are OpenClaw.", nearest: [] }]
        : [],
    },
    renderCheck: renderModes
      ? { ran: true, modes: renderModes }
      : { ran: false, reason },
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
        missingIdentity: true,
        renderModes: {
          default: { matched: true },
          minimal: { matched: true },
        },
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

async function runPublisherWithMatchingDigestComment(commentLogin) {
  const publisherScript = loadPublisherScript();
  const version = "2026.7.2";
  const anchorIds = [
    "identity",
    "tooling",
    "safety",
    "workspace",
    "workspaceFiles",
    "cacheBoundary",
    "runtime",
  ];
  const shape = JSON.stringify({
    version,
    missing: ["identity"],
    unmatched: [],
  });
  const digest = createHash("sha256").update(shape).digest("hex").slice(0, 12);
  const report = {
    incomplete: false,
    watchedDistTags: ["latest", "beta"],
    drift: true,
    versions: [
      {
        version,
        tags: ["latest", "beta"],
        drift: true,
        literalCheck: {
          ran: true,
          found: anchorIds
            .filter((id) => id !== "identity")
            .map((id) => ({ id })),
          missing: [{ id: "identity", literal: "You are OpenClaw.", nearest: [] }],
        },
        renderCheck: { ran: false, reason: "render unavailable" },
      },
    ],
  };
  const versionMarker = `<!-- upstream-fingerprint-watch version=${version} -->`;
  const digestMarker = `<!-- upstream-fingerprint-watch digest=${digest} -->`;
  const createdComments = [];
  const listForRepo = async () => {};
  const listComments = async () => {};
  const github = {
    paginate: async (method) => {
      if (method === listForRepo) {
        return [{ number: 23, body: versionMarker }];
      }
      if (method === listComments) {
        return [{ body: digestMarker, user: { login: commentLogin } }];
      }
      throw new Error("Unexpected pagination method");
    },
    rest: {
      issues: {
        createLabel: async () => {},
        listForRepo,
        listComments,
        create: async () => {
          throw new Error("Existing version issue should be reused");
        },
        createComment: async (input) => {
          createdComments.push(input);
        },
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
        execFileSync: () => JSON.stringify({ latest: version, beta: version }),
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
  return createdComments;
}

test("untrusted matching digest comment does not suppress drift publication", async () => {
  const createdComments = await runPublisherWithMatchingDigestComment("attacker");
  assert.equal(createdComments.length, 1);
  assert.equal(createdComments[0].issue_number, 23);
});

test("trusted workflow bot matching digest comment suppresses duplicate publication", async () => {
  const createdComments =
    await runPublisherWithMatchingDigestComment("github-actions[bot]");
  assert.equal(createdComments.length, 0);
});
