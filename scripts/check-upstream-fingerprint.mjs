#!/usr/bin/env node
/**
 * Upstream fingerprint watch.
 *
 * The plugin rewrites the OpenClaw identity sentence only when the system
 * prompt still carries the structural fingerprint in `src/index.ts`. When
 * upstream changes that structure the plugin fails closed — it silently does
 * nothing. That is safe, and it is invisible: the 2026.7.2 preamble rewrite
 * shipped in `2026.7.2-beta.1` on 07-15 and was not noticed until a manual
 * check on 07-27. The `2026.7.2` CHANGELOG has no entry for it, so release
 * notes cannot be the detector.
 *
 * This script is the detector. It resolves the npm `latest` and `beta`
 * OpenClaw releases, and for each one asks whether every fingerprint anchor is
 * still there.
 *
 * The fingerprint it asks about is always this repository's own, at the commit
 * being run: both the anchor literals and the regex are imported from the built
 * `dist/index.js`, never restated here. Nothing about the current anchor set is
 * baked into this file, so replacing an anchor — as `0.3.0` replaced the prose
 * preamble with `## Safety` and `## Workspace` — needs no change to the watch.
 * A run of this script on an old commit reports what the fingerprint of that
 * commit required, which is what makes it usable to reproduce a past break.
 *
 * Two layers, deliberately independent all the way down to how the bytes are
 * acquired, so that the fragile layer cannot take the reliable one with it:
 *
 *   (A) Anchor literal presence — always runs. Unpacks the tarball with
 *       `npm pack`, identifies the prompt builder by a quorum of the current
 *       anchors, and checks that each anchor still exists as a string literal. No dependency
 *       resolution, no code execution. The 2026.7.2 incident is caught by
 *       this layer alone: the preamble literal vanished outright.
 *
 *   (B) Real render plus fingerprint match — best effort. Installs the release
 *       into a throwaway directory, imports the builder, renders a prompt and
 *       runs the actual `OPENCLAW_SYSTEM_PROMPT_FINGERPRINT` against it. This
 *       is the only layer that catches a pure reordering, in which every
 *       anchor still exists but the sequence the regex requires is gone.
 *
 * (B) is quarantined on purpose. Importing a builder can have side effects:
 * in `2026.2.26` and `2026.3.24` the builder lives inside the monolithic CLI
 * bundle, and importing it reads `~/.openclaw`, runs auth-profile and
 * model-catalog bootstrap, and throws. Two guards apply. Candidate builder
 * exports are selected statically from the `export {}` clause, so a bundle
 * that exports no prompt builder is never imported at all; and the import
 * that does happen runs in a child process with a scrubbed environment whose
 * `HOME` points into the work directory. A failure in (B) is reported as
 * "not run", never as drift — an import that cannot run tells us nothing
 * about the upstream prompt.
 *
 * Drift is not a script failure. A broken script is. Missing anchors exit 0
 * and are reported for the workflow to open an issue about; a network
 * failure, a corrupt tarball or an unidentifiable builder exits 1, because
 * then the watch itself is down and nothing was actually checked.
 *
 * Usage:
 *   node scripts/check-upstream-fingerprint.mjs                  # latest + beta
 *   node scripts/check-upstream-fingerprint.mjs 2026.7.1 2026.3.24
 *
 *   --json <path>       write the structured result
 *   --markdown <path>   write the per-version issue bodies
 *   --work-dir <path>   reuse a directory instead of a fresh temp one
 *   --skip-render       do not attempt (B)
 *   --github-output     append `drift`/`drift_versions` to $GITHUB_OUTPUT
 *
 * This file is not published: `package.json#files` does not list `scripts`.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** npm dist-tags this watch follows. `alpha` is deliberately not watched. */
const WATCHED_DIST_TAGS = ["latest", "beta"];

/** Extensions worth scanning when looking for the prompt builder. */
const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);

/** Skip anything larger than this when scanning; no real builder approaches it. */
const MAX_SCANNED_FILE_BYTES = 64 * 1024 * 1024;

/** A builder export must match this to be worth importing in layer (B). */
const BUILDER_EXPORT_PATTERN = /^build[A-Za-z]*AgentSystemPrompt$/;

/** Rendering must not be able to hang the watch. */
const RENDER_TIMEOUT_MS = 120_000;

/** `npm install` of a full OpenClaw release is not fast, but it is bounded. */
const INSTALL_TIMEOUT_MS = 600_000;

/**
 * A failure of the watch itself, as opposed to a finding about upstream.
 * These exit non-zero; drift does not.
 */
class CheckError extends Error {}

/* -------------------------------------------------------------------------- */
/* Anchors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Anchor *names*, never anchor text.
 *
 * The literals themselves are read out of `dist/index.js` at run time, so this
 * file holds no second copy of them. Change an anchor in `src/index.ts` and the
 * watch follows on the next build with no edit here; the only thing that has to
 * change is this list, and only when an anchor is added, dropped or renamed —
 * which {@link loadFingerprint} turns into a hard failure rather than a silent
 * pass.
 *
 * One caveat, inherited rather than introduced. `src/index.ts` declares these
 * marker constants and separately spells the same text into the fingerprint
 * regex, and nothing ties the two together. So layer (A), which uses the
 * constants, can be checking a stale anchor if the regex alone was edited.
 * Layer (B) is the backstop: it runs the compiled regex itself, so a constant
 * that has drifted away from the pattern shows up as a real render that the
 * fingerprint rejects. This is a reason to keep (B), not a reason to duplicate
 * the literals here — a third copy would make the divergence worse, not
 * detectable.
 *
 * Order matches the order OpenClaw renders them, which layer (B) verifies and
 * layer (A) cannot see.
 */
const ANCHOR_EXPORTS = [
  ["identity", "ORIGINAL_IDENTITY_SENTENCE"],
  ["tooling", "TOOLING_SECTION_MARKER"],
  ["safety", "SAFETY_SECTION_MARKER"],
  ["workspace", "WORKSPACE_SECTION_MARKER"],
  ["workspaceFiles", "WORKSPACE_FILES_SECTION_MARKER"],
  ["cacheBoundary", "SYSTEM_PROMPT_CACHE_BOUNDARY"],
  ["runtime", "RUNTIME_SECTION_MARKER"],
];

async function loadFingerprint() {
  const distEntry = path.join(REPO_ROOT, "dist", "index.js");
  let plugin;
  try {
    plugin = await import(pathToFileURL(distEntry).href);
  } catch (error) {
    throw new CheckError(
      `cannot import ${path.relative(REPO_ROOT, distEntry)} (${error.message}). ` +
        `Run \`npm run build\` first — the watch checks the compiled fingerprint.`,
    );
  }

  const anchors = ANCHOR_EXPORTS.map(([id, exportName]) => {
    const value = plugin[exportName];
    if (typeof value !== "string" || value.length === 0) {
      throw new CheckError(
        `dist/index.js does not export a non-empty string \`${exportName}\`. ` +
          `The fingerprint anchors were renamed or removed; update ANCHOR_EXPORTS ` +
          `in ${path.relative(REPO_ROOT, fileURLToPath(import.meta.url))} to match.`,
      );
    }
    // Markers are stored with their surrounding newlines; the source literal
    // they come from does not carry them.
    return { id, exportName, literal: value.replace(/^\n+|\n+$/g, "") };
  });

  const fingerprint = plugin.OPENCLAW_SYSTEM_PROMPT_FINGERPRINT;
  if (!(fingerprint instanceof RegExp)) {
    throw new CheckError(
      "dist/index.js does not export OPENCLAW_SYSTEM_PROMPT_FINGERPRINT as a RegExp.",
    );
  }

  return { anchors, fingerprint };
}

/* -------------------------------------------------------------------------- */
/* npm                                                                         */
/* -------------------------------------------------------------------------- */

function runNpm(args, { cwd, env, timeout } = {}) {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    timeout: timeout ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
    env: env ?? process.env,
  });
  if (result.error) {
    throw new CheckError(`\`npm ${args.join(" ")}\` failed to start: ${result.error.message}`);
  }
  return result;
}

function npmOrThrow(args, options) {
  const result = runNpm(args, options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").slice(-6).join("\n");
    throw new CheckError(`\`npm ${args.join(" ")}\` exited ${result.status}:\n${detail}`);
  }
  return result.stdout;
}

function resolveWatchedVersions() {
  const raw = npmOrThrow(["view", "openclaw", "dist-tags", "--json"]);
  let tags;
  try {
    tags = JSON.parse(raw);
  } catch {
    throw new CheckError(`\`npm view openclaw dist-tags --json\` returned unparsable output:\n${raw}`);
  }

  const byVersion = new Map();
  for (const tag of WATCHED_DIST_TAGS) {
    const version = tags[tag];
    if (typeof version !== "string" || version.length === 0) {
      throw new CheckError(
        `npm dist-tag \`${tag}\` is missing from openclaw. Tags present: ${Object.keys(tags).join(", ") || "(none)"}.`,
      );
    }
    const entry = byVersion.get(version) ?? { version, tags: [] };
    entry.tags.push(tag);
    byVersion.set(version, entry);
  }
  return [...byVersion.values()];
}

/**
 * Downloads and unpacks a package. Unpack failures are watch failures: a
 * tarball we cannot read is not evidence about the prompt.
 */
function unpackPackage(spec, intoDir) {
  mkdirSync(intoDir, { recursive: true });
  const packed = npmOrThrow(
    ["pack", spec, "--pack-destination", intoDir, "--loglevel", "error"],
    { cwd: intoDir },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .pop();

  if (!packed) {
    throw new CheckError(`\`npm pack ${spec}\` produced no tarball name.`);
  }

  const tarball = path.join(intoDir, packed.trim());
  const extract = spawnSync("tar", ["-xzf", tarball, "-C", intoDir], {
    encoding: "utf8",
    timeout: 300_000,
  });
  if (extract.error) {
    throw new CheckError(`tar failed to start for ${spec}: ${extract.error.message}`);
  }
  if (extract.status !== 0) {
    throw new CheckError(
      `tar exited ${extract.status} unpacking ${spec}:\n${(extract.stderr || "").trim()}`,
    );
  }

  const root = path.join(intoDir, "package");
  if (!isDirectory(root)) {
    throw new CheckError(`${spec} unpacked without a \`package/\` root at ${root}.`);
  }
  return root;
}

/* -------------------------------------------------------------------------- */
/* Builder identification                                                      */
/* -------------------------------------------------------------------------- */

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function* walkSourceFiles(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* walkSourceFiles(full);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function readIfSmallEnough(file) {
  try {
    if (statSync(file).size > MAX_SCANNED_FILE_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Finds the prompt builder by content, never by filename or one required
 * anchor. The filename changed three times across the sampled releases
 * (`pi-embedded-*` → `system-prompt-*` → `system-prompt-config-*` →
 * `system-prompt-params-*`). A quorum still identifies the builder when one
 * monitored anchor is exactly the thing upstream removed.
 */
function findBuilderFiles(packageRoot, anchors) {
  const search = (root) => {
    const hits = [];
    for (const file of walkSourceFiles(root)) {
      const source = readIfSmallEnough(file);
      if (source === null) continue;
      const matchingAnchors = anchors.filter((anchor) =>
        containsAnchorLiteral(source, anchor.literal),
      );
      const hasBuilderExport = findBuilderExports(source).length > 0;
      // Three independent fingerprint anchors are strong content evidence on
      // their own. Two plus a statically visible builder export is also enough
      // for split/minified layouts. Crucially, no individual monitored anchor
      // is required: losing identity or Tooling must be reported as drift.
      if (matchingAnchors.length >= 3 || (matchingAnchors.length >= 2 && hasBuilderExport)) {
        hits.push({ file, source });
      }
    }
    return hits;
  };

  const distDir = path.join(packageRoot, "dist");
  let hits = isDirectory(distDir) ? search(distDir) : [];
  if (hits.length === 0) hits = search(packageRoot);

  if (hits.length === 0) {
    throw new CheckError(
      `no prompt builder found under ${packageRoot}: no file contains at least three ` +
        `fingerprint anchors (or two plus a prompt-builder export). The release is ` +
        `not identifiable enough for this watch to judge.`,
    );
  }
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Layer (A): anchor literal presence                                          */
/* -------------------------------------------------------------------------- */

/**
 * Characters that can legitimately bound a string literal's contents in a
 * bundled source: the quote itself, a template interpolation brace, an escaped
 * newline (the two source characters `\` and `n`), or a real newline in an
 * unminified file.
 *
 * Requiring a boundary is what keeps `## Workspace` from being satisfied by the
 * `## Workspace Files (injected)` line it prefixes — the same prefix trap the
 * fingerprint itself guards against with a trailing `\n`.
 */
const BOUNDARY_CHARS = new Set(['"', "'", "`", "}", "{", "\n", "\r"]);

function isLiteralBoundary(source, index, direction) {
  if (index < 0 || index >= source.length) return true; // start/end of file
  const char = source[index];
  if (BOUNDARY_CHARS.has(char)) return true;
  if (direction === "before") {
    // `...\n` — an escaped newline ends at `index`, so look at index-1..index.
    return char === "n" && source[index - 1] === "\\";
  }
  // `\n...` — an escaped newline starts at `index`.
  if (char === "\\" && source[index + 1] === "n") return true;
  // `${` opening a template interpolation directly after the anchor.
  return char === "$" && source[index + 1] === "{";
}

/** True when `anchor` appears as a self-contained line inside a string literal. */
function containsAnchorLiteral(source, anchor) {
  let from = 0;
  for (;;) {
    const at = source.indexOf(anchor, from);
    if (at === -1) return false;
    if (
      isLiteralBoundary(source, at - 1, "before") &&
      isLiteralBoundary(source, at + anchor.length, "after")
    ) {
      return true;
    }
    from = at + 1;
  }
}

/**
 * Pulls the individual lines out of every quoted string literal.
 *
 * Only used to suggest what a missing anchor may have turned into, so an
 * imprecise tokenization is acceptable here. The authoritative presence test is
 * {@link containsAnchorLiteral}, which needs no tokenizer at all.
 */
const QUOTED_LITERAL_PATTERN = /"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g;

function extractLiteralLines(source) {
  const lines = new Set();
  for (const match of source.matchAll(QUOTED_LITERAL_PATTERN)) {
    const raw = match[1] ?? match[2] ?? "";
    if (raw.length === 0 || raw.length > 4000) continue;
    const decoded = raw
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(["'\\])/g, "$1");
    for (const line of decoded.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length >= 3) lines.add(trimmed);
    }
  }
  return lines;
}

function tokenize(text) {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9#]+/)
      .filter((token) => token.length > 0),
  );
}

function similarity(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return { score: 0, shared: 0 };
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return { score: shared / (left.size + right.size - shared), shared };
}

/**
 * Given an anchor that is gone, suggests the literals that most look like what
 * replaced it. "The fingerprint broke" is not actionable on its own; the
 * 2026.7.2 break is only legible as
 * `Available tools are policy-filtered. …` → `Tools policy-filtered. …`.
 */
function findNearestLiterals(literalLines, anchor, limit = 3) {
  const scored = [];
  for (const line of literalLines) {
    if (line === anchor) continue;
    const { score, shared } = similarity(anchor, line);
    // Three shared words is enough to call a rewrite a rewrite; two only when
    // the overlap dominates both sides, as in `## Safety` -> `## Safety Rules`.
    // Without this floor a short marker anchor draws in every unrelated
    // identifier that happens to share a common word, and a suggestion that
    // confident and that wrong is worse than none.
    const plausible = shared >= 3 || (shared >= 2 && score >= 0.6);
    if (plausible && score >= 0.3) scored.push({ line, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ line, score }) => ({
    literal: line.length > 300 ? `${line.slice(0, 300)}…` : line,
    similarity: Number(score.toFixed(3)),
  }));
}

/**
 * Runs layer (A) against one release.
 *
 * Anchors are looked for in the builder first, then anywhere else in the
 * release, and finally in the release's own `@openclaw/*` dependencies. That
 * last hop is not optional: since `2026.7.1` the cache boundary constant lives
 * in `@openclaw/ai`, so grepping only the OpenClaw tarball reports it missing
 * on releases where it is present and working. The location each anchor was
 * found at is reported so that a move is legible as a move.
 */
function checkAnchorLiterals({ anchors, builders, packageRoot, workDir, spec }) {
  const builderSource = builders.map((builder) => builder.source).join("\n");
  const found = [];
  let pending = [];

  for (const anchor of anchors) {
    if (containsAnchorLiteral(builderSource, anchor.literal)) {
      found.push({ ...anchor, location: "builder" });
    } else {
      pending.push(anchor);
    }
  }

  if (pending.length > 0) {
    const builderFiles = new Set(builders.map((builder) => builder.file));
    const stillPending = [];
    for (const anchor of pending) {
      let location = null;
      for (const file of walkSourceFiles(packageRoot)) {
        if (builderFiles.has(file)) continue;
        const source = readIfSmallEnough(file);
        if (source !== null && containsAnchorLiteral(source, anchor.literal)) {
          location = `${path.relative(packageRoot, file)} (same package)`;
          break;
        }
      }
      if (location) found.push({ ...anchor, location });
      else stillPending.push(anchor);
    }
    pending = stillPending;
  }

  if (pending.length > 0) {
    for (const dependency of readOpenClawDependencies(packageRoot)) {
      if (pending.length === 0) break;
      const depDir = path.join(workDir, "deps", dependency.name.replace(/[^a-z0-9]+/gi, "-"));
      let depRoot;
      try {
        depRoot = unpackPackage(`${dependency.name}@${dependency.range}`, depDir);
      } catch (error) {
        // A declared dependency we cannot fetch leaves anchors unresolved, and
        // reporting those as drift would be a lie about upstream.
        throw new CheckError(
          `${spec} declares ${dependency.name}@${dependency.range}, which holds anchors ` +
            `not present in the release itself, but it could not be fetched: ${error.message}`,
        );
      }
      const stillPending = [];
      for (const anchor of pending) {
        let location = null;
        for (const file of walkSourceFiles(depRoot)) {
          const source = readIfSmallEnough(file);
          if (source !== null && containsAnchorLiteral(source, anchor.literal)) {
            location = `${dependency.name}@${dependency.range}:${path.relative(depRoot, file)}`;
            break;
          }
        }
        if (location) found.push({ ...anchor, location });
        else stillPending.push(anchor);
      }
      pending = stillPending;
    }
  }

  const literalLines = pending.length > 0 ? extractLiteralLines(builderSource) : new Set();
  const missing = pending.map((anchor) => ({
    id: anchor.id,
    literal: anchor.literal,
    nearest: findNearestLiterals(literalLines, anchor.literal),
  }));

  return { ran: true, found, missing };
}

function readOpenClawDependencies(packageRoot) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    throw new CheckError(`cannot read ${packageRoot}/package.json: ${error.message}`);
  }
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies };
  return Object.entries(declared)
    .filter(([name, range]) => name.startsWith("@openclaw/") && typeof range === "string")
    .map(([name, range]) => ({ name, range }));
}

/* -------------------------------------------------------------------------- */
/* Layer (B): real render and fingerprint match                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses the trailing `export { originalName as alias }` clause and keeps only
 * the aliases whose original name is a prompt builder.
 *
 * This filter is a safety device, not a convenience. When it finds nothing the
 * module is never imported, which is exactly what should happen for the
 * `2026.2.26`/`2026.3.24` monolithic CLI bundles: those export
 * `buildTtsSystemPromptHint` but no agent prompt builder, and importing them
 * runs OpenClaw's bootstrap against whatever `HOME` it is given.
 */
function findBuilderExports(source) {
  const clauses = source.match(/export\s*\{[^}]*\}/g);
  if (!clauses) return [];
  const candidates = new Map();
  for (const clause of clauses) {
    for (const part of clause.replace(/^export\s*\{|\}$/g, "").split(",")) {
      const named = /^\s*([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(part);
      const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(part);
      const original = named?.[1] ?? bare?.[1];
      const alias = named?.[2] ?? bare?.[1];
      if (original && alias && BUILDER_EXPORT_PATTERN.test(original)) {
        candidates.set(alias, original);
      }
    }
  }
  return [...candidates].map(([alias, original]) => ({ alias, original }));
}

const RENDER_PROBE_SENTINEL = "__OPENCLAW_FINGERPRINT_PROBE__";

/**
 * Runs inside the child process. Anything the imported module prints goes to
 * stdout too, so the result is framed by a sentinel rather than assumed to be
 * the whole stream.
 */
const RENDER_PROBE_SOURCE = `
import { pathToFileURL } from "node:url";

const [builderPath, candidatesJson, workspaceDir] = process.argv.slice(2);
const candidates = JSON.parse(candidatesJson);

function emit(payload) {
  process.stdout.write("\\n${RENDER_PROBE_SENTINEL}" + JSON.stringify(payload) + "\\n");
}

try {
  const mod = await import(pathToFileURL(builderPath).href);
  for (const { alias, original } of candidates) {
    const fn = mod[alias];
    if (typeof fn !== "function") continue;
    const renders = {};
    let usable = true;
    for (const [mode, params] of [
      ["default", { workspaceDir }],
      ["minimal", { workspaceDir, promptMode: "minimal" }],
    ]) {
      try {
        const rendered = await fn(params);
        if (typeof rendered !== "string" || rendered.length === 0) { usable = false; break; }
        renders[mode] = rendered;
      } catch (error) {
        usable = false;
        renders[mode + "Error"] = String(error && error.message).slice(0, 400);
        break;
      }
    }
    if (usable) { emit({ ok: true, builderExport: original, renders }); process.exit(0); }
  }
  emit({ ok: false, reason: "no exported builder produced a prompt string" });
  process.exit(0);
} catch (error) {
  emit({ ok: false, reason: "import failed: " + String(error && error.message).slice(0, 400) });
  process.exit(0);
}
`;

/**
 * Layer (B). Every exit path that is not "the fingerprint was tested" reports
 * `ran: false` with a reason; none of them report drift.
 */
function checkRenderedFingerprint({
  version,
  fingerprint,
  workDir,
  anchors,
  runNpmCommand = runNpm,
}) {
  const installDir = path.join(workDir, "install");
  const homeDir = path.join(workDir, "home");
  const workspaceDir = path.join(workDir, "workspace");
  for (const dir of [installDir, homeDir, workspaceDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(installDir, "package.json"),
    `${JSON.stringify({ name: "openclaw-fingerprint-probe", version: "0.0.0", private: true }, null, 2)}\n`,
  );

  // The install itself must not see the real home either: npm runs no lifecycle
  // scripts here, but the child that follows will import OpenClaw code.
  const isolatedEnv = {
    PATH: process.env.PATH,
    HOME: homeDir,
    USERPROFILE: homeDir,
    TMPDIR: process.env.TMPDIR,
    npm_config_cache: path.join(workDir, "npm-cache"),
    OPENCLAW_STATE_DIR: path.join(homeDir, "state"),
    OPENCLAW_CONFIG_PATH: path.join(homeDir, "openclaw.json"),
  };

  let install;
  try {
    install = runNpmCommand(
      [
        "install",
        `openclaw@${version}`,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "error",
      ],
      { cwd: installDir, env: isolatedEnv, timeout: INSTALL_TIMEOUT_MS },
    );
  } catch (error) {
    return {
      ran: false,
      reason: `npm install openclaw@${version} could not run: ${error.message}`,
    };
  }
  if (install.status !== 0) {
    return {
      ran: false,
      reason: `npm install openclaw@${version} exited ${install.status}`,
    };
  }

  const installedRoot = path.join(installDir, "node_modules", "openclaw");
  if (!isDirectory(installedRoot)) {
    return { ran: false, reason: "openclaw was not present in node_modules after install" };
  }

  let builders;
  try {
    builders = findBuilderFiles(installedRoot, anchors);
  } catch (error) {
    return { ran: false, reason: `builder not found in installed tree: ${error.message}` };
  }

  for (const builder of builders) {
    const candidates = findBuilderExports(builder.source);
    if (candidates.length === 0) continue;

    const probePath = path.join(workDir, "render-probe.mjs");
    writeFileSync(probePath, RENDER_PROBE_SOURCE);

    const child = spawnSync(
      process.execPath,
      [probePath, builder.file, JSON.stringify(candidates), workspaceDir],
      {
        cwd: workDir,
        env: isolatedEnv,
        encoding: "utf8",
        timeout: RENDER_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (child.error) {
      return { ran: false, reason: `render probe failed to start: ${child.error.message}` };
    }
    const marker = (child.stdout ?? "").lastIndexOf(RENDER_PROBE_SENTINEL);
    if (marker === -1) {
      const detail = child.signal
        ? `killed by ${child.signal} (likely the ${RENDER_TIMEOUT_MS} ms timeout)`
        : `exited ${child.status} without a result`;
      return { ran: false, reason: `render probe ${detail}` };
    }

    let payload;
    try {
      payload = JSON.parse(child.stdout.slice(marker + RENDER_PROBE_SENTINEL.length));
    } catch (error) {
      return { ran: false, reason: `render probe output was unparsable: ${error.message}` };
    }
    if (!payload.ok) {
      return { ran: false, reason: payload.reason };
    }

    const modes = {};
    for (const [mode, rendered] of Object.entries(payload.renders)) {
      modes[mode] = {
        matched: fingerprint.test(rendered),
        firstLine: rendered.split("\n", 1)[0],
        headings: rendered
          .split("\n")
          .filter((line) => line.startsWith("## ") || line.includes("CACHE_BOUNDARY")),
      };
    }
    return { ran: true, builderExport: payload.builderExport, modes };
  }

  return {
    ran: false,
    reason:
      "no builder export matched " +
      `${BUILDER_EXPORT_PATTERN} — the module was not imported, so nothing was executed`,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-version orchestration                                                   */
/* -------------------------------------------------------------------------- */

function inspectVersion({ version, tags, anchors, fingerprint, rootWorkDir, skipRender }) {
  const workDir = path.join(rootWorkDir, version.replace(/[^\w.-]+/g, "_"));
  mkdirSync(workDir, { recursive: true });

  const spec = `openclaw@${version}`;
  const packageRoot = unpackPackage(spec, path.join(workDir, "pack"));
  const builders = findBuilderFiles(packageRoot, anchors);

  const literalCheck = checkAnchorLiterals({ anchors, builders, packageRoot, workDir, spec });

  const renderCheck = skipRender
    ? { ran: false, reason: "disabled with --skip-render" }
    : checkRenderedFingerprint({ version, fingerprint, workDir, anchors });

  const driftReasons = [];
  for (const anchor of literalCheck.missing) {
    driftReasons.push(
      `anchor \`${anchor.id}\` (${JSON.stringify(anchor.literal)}) is not present as a string literal`,
    );
  }
  if (renderCheck.ran) {
    for (const [mode, result] of Object.entries(renderCheck.modes)) {
      if (!result.matched) {
        driftReasons.push(`the fingerprint does not match the real ${mode} render`);
      }
    }
  }

  return {
    version,
    tags,
    builderFiles: builders.map((builder) => path.relative(packageRoot, builder.file)),
    literalCheck: {
      ran: literalCheck.ran,
      found: literalCheck.found.map(({ id, literal, location }) => ({ id, literal, location })),
      missing: literalCheck.missing,
    },
    renderCheck,
    drift: driftReasons.length > 0,
    driftReasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                   */
/* -------------------------------------------------------------------------- */

function describeCoverage(result) {
  if (result.renderCheck.ran) {
    return "(A) anchor literals + (B) real render vs fingerprint";
  }
  return `(A) anchor literals only — (B) not run: ${result.renderCheck.reason}`;
}

function renderHumanReport(results) {
  const lines = [];
  for (const result of results) {
    const tagSuffix = result.tags.length > 0 ? ` [${result.tags.join(", ")}]` : "";
    lines.push("");
    const status = result.drift
      ? "DRIFT"
      : result.renderCheck.ran
        ? "PASS"
        : "LAYER A PASS (PARTIAL)";
    lines.push(`openclaw@${result.version}${tagSuffix} — ${status}`);
    lines.push(`  checks run: ${describeCoverage(result)}`);
    lines.push(`  builder:    ${result.builderFiles.join(", ")}`);

    lines.push("  (A) anchor literals:");
    for (const anchor of result.literalCheck.found) {
      const where = anchor.location === "builder" ? "" : `  <- ${anchor.location}`;
      lines.push(`        ok      ${anchor.id.padEnd(15)} ${JSON.stringify(anchor.literal)}${where}`);
    }
    for (const anchor of result.literalCheck.missing) {
      lines.push(`        MISSING ${anchor.id.padEnd(15)} ${JSON.stringify(anchor.literal)}`);
      for (const near of anchor.nearest) {
        lines.push(`                  closest literal (${near.similarity}): ${JSON.stringify(near.literal)}`);
      }
      if (anchor.nearest.length === 0) {
        lines.push("                  no similar literal in the builder — the anchor looks removed, not reworded");
      }
    }

    if (result.renderCheck.ran) {
      lines.push(`  (B) real render via ${result.renderCheck.builderExport}:`);
      for (const [mode, mode_result] of Object.entries(result.renderCheck.modes)) {
        lines.push(
          `        ${mode_result.matched ? "match  " : "NOMATCH"} ${mode.padEnd(15)} first line: ${JSON.stringify(mode_result.firstLine)}`,
        );
      }
    } else {
      lines.push(`  (B) real render: not run (${result.renderCheck.reason})`);
    }
  }

  const drifted = results.filter((result) => result.drift);
  lines.push("");
  if (drifted.length > 0) {
    lines.push(
      `Fingerprint drift in ${drifted.length} of ${results.length} watched release(s): ${drifted
        .map((result) => result.version)
        .join(", ")}`,
    );
  } else if (results.some((result) => !result.renderCheck.ran)) {
    lines.push(
      `Layer (A) passed for all ${results.length} watched release(s); coverage is partial, ` +
        "so the full fingerprint was not verified for every release.",
    );
  } else {
    lines.push(`All ${results.length} watched release(s) passed the full fingerprint check.`);
  }
  return lines.join("\n");
}

function renderMarkdownReport(results) {
  return results
    .map((result) => {
      if (result.drift) return renderIssueBody(result);
      const tags = result.tags.length > 0 ? ` (${result.tags.join(", ")})` : "";
      const verdict = result.renderCheck.ran
        ? "The anchor literals and real rendered prompt both passed."
        : "Layer (A) found every anchor literal. Coverage is partial; the full fingerprint was not verified.";
      return [
        `## openclaw@${result.version}${tags}`,
        "",
        `- **Status:** ${result.renderCheck.ran ? "full fingerprint passed" : "Layer A passed (partial)"}`,
        `- **Checks run:** ${describeCoverage(result)}`,
        `- **Prompt builder:** \`${result.builderFiles.join("`, `")}\``,
        "",
        verdict,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

/** A stable id for one drift finding, so the workflow can tell repeats from changes. */
function driftDigest(result) {
  const shape = JSON.stringify({
    version: result.version,
    missing: result.literalCheck.missing.map((anchor) => anchor.id).sort(),
    unmatched: result.renderCheck.ran
      ? Object.entries(result.renderCheck.modes)
          .filter(([, mode]) => !mode.matched)
          .map(([mode]) => mode)
          .sort()
      : [],
  });
  return createHash("sha256").update(shape).digest("hex").slice(0, 12);
}

function renderIssueBody(result) {
  const lines = [];
  lines.push(
    `The OpenClaw system-prompt fingerprint used by this plugin no longer holds for ` +
      `\`openclaw@${result.version}\`${result.tags.length > 0 ? ` (npm \`${result.tags.join("\`, \`")}\`)` : ""}.`,
  );
  lines.push("");
  lines.push(
    "While this is true, the plugin fails closed on that release: the identity sentence " +
      "is left untouched and no warning is emitted, so no user-visible error will appear.",
  );
  lines.push("");
  lines.push(`- **Checks run:** ${describeCoverage(result)}`);
  lines.push(`- **Prompt builder:** \`${result.builderFiles.join("`, `")}\``);
  lines.push(`- **npm dist-tags:** ${result.tags.length > 0 ? result.tags.join(", ") : "(checked explicitly, not via a tag)"}`);
  lines.push("");

  if (result.literalCheck.missing.length > 0) {
    lines.push("## Anchors no longer present");
    lines.push("");
    for (const anchor of result.literalCheck.missing) {
      lines.push(`### \`${anchor.id}\``);
      lines.push("");
      lines.push("```text");
      lines.push(`before  ${anchor.literal}`);
      if (anchor.nearest.length > 0) {
        for (const near of anchor.nearest) {
          lines.push(`after?  ${near.literal}   (similarity ${near.similarity})`);
        }
      } else {
        lines.push("after?  (no similar literal in the builder — looks removed, not reworded)");
      }
      lines.push("```");
      lines.push("");
    }
  }

  if (result.renderCheck.ran) {
    const unmatched = Object.entries(result.renderCheck.modes).filter(([, mode]) => !mode.matched);
    if (unmatched.length > 0) {
      lines.push("## Renders the fingerprint rejected");
      lines.push("");
      for (const [mode, modeResult] of unmatched) {
        lines.push(`**\`${mode}\`** — first line: \`${modeResult.firstLine}\``);
        lines.push("");
        lines.push("```text");
        lines.push(modeResult.headings.join("\n"));
        lines.push("```");
        lines.push("");
      }
      lines.push(
        "Every anchor above was found as a literal, so this is an ordering or " +
          "rendering-condition change rather than a removed anchor.",
      );
      lines.push("");
    }
  }

  lines.push("## Anchors still present");
  lines.push("");
  lines.push("```text");
  for (const anchor of result.literalCheck.found) {
    lines.push(
      `${anchor.id.padEnd(16)} ${JSON.stringify(anchor.literal)}` +
        (anchor.location === "builder" ? "" : `   <- ${anchor.location}`),
    );
  }
  lines.push("```");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```sh");
  lines.push("npm ci && npm run build");
  lines.push(`node scripts/check-upstream-fingerprint.mjs ${result.version}`);
  lines.push("```");
  lines.push("");
  lines.push(
    "Background on how these anchors were chosen and what upstream tends to change: " +
      "`docs/2026-07-27-openclaw-2026.7.2-fingerprint-survey.md`.",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    versions: [],
    json: null,
    markdown: null,
    workDir: null,
    skipRender: false,
    githubOutput: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const takeValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CheckError(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--json":
        options.json = takeValue(arg);
        break;
      case "--markdown":
        options.markdown = takeValue(arg);
        break;
      case "--work-dir":
        options.workDir = takeValue(arg);
        break;
      case "--skip-render":
        options.skipRender = true;
        break;
      case "--github-output":
        options.githubOutput = true;
        break;
      default:
        if (arg.startsWith("--")) throw new CheckError(`unknown option ${arg}`);
        options.versions.push(arg);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { anchors, fingerprint } = await loadFingerprint();

  const targets =
    options.versions.length > 0
      ? options.versions.map((version) => ({ version, tags: [] }))
      : resolveWatchedVersions();

  const rootWorkDir =
    options.workDir ?? mkdtempSync(path.join(tmpdir(), "openclaw-fingerprint-watch-"));
  mkdirSync(rootWorkDir, { recursive: true });

  process.stdout.write(
    `Fingerprint: ${fingerprint.source.length} chars, ${anchors.length} anchors, ` +
      `from dist/index.js\n` +
      `Watching:    ${targets
        .map((target) => target.version + (target.tags.length > 0 ? ` [${target.tags.join(", ")}]` : ""))
        .join(", ")}\n` +
      `Work dir:    ${rootWorkDir}\n`,
  );

  const results = [];
  for (const target of targets) {
    results.push(
      inspectVersion({
        version: target.version,
        tags: target.tags,
        anchors,
        fingerprint,
        rootWorkDir,
        skipRender: options.skipRender,
      }),
    );
  }

  process.stdout.write(`${renderHumanReport(results)}\n`);

  const drifted = results.filter((result) => result.drift);
  const report = {
    generatedAt: new Date().toISOString(),
    watchedDistTags: options.versions.length > 0 ? null : WATCHED_DIST_TAGS,
    fingerprintSource: fingerprint.source,
    drift: drifted.length > 0,
    versions: results.map((result) => ({
      ...result,
      coverage: describeCoverage(result),
      digest: driftDigest(result),
      issueTitle: `OpenClaw ${result.version}: system-prompt fingerprint no longer matches`,
      issueBody: result.drift ? renderIssueBody(result) : null,
    })),
  };

  if (options.json) {
    mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nJSON report: ${options.json}\n`);
  }

  if (options.markdown) {
    mkdirSync(path.dirname(path.resolve(options.markdown)), { recursive: true });
    writeFileSync(
      options.markdown,
      `${renderMarkdownReport(results)}\n`,
    );
    process.stdout.write(`Markdown report: ${options.markdown}\n`);
  }

  if (options.githubOutput && process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `drift=${drifted.length > 0}\n` +
        `drift_versions=${drifted.map((result) => result.version).join(",")}\n`,
    );
  }

  // Drift is a finding about upstream, not a failure of this check.
  process.exitCode = 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    if (error instanceof CheckError) {
      process.stderr.write(`\nupstream fingerprint watch failed: ${error.message}\n`);
    } else {
      process.stderr.write(`\nupstream fingerprint watch crashed:\n${error?.stack ?? error}\n`);
    }
    process.exitCode = 1;
  });
}

export {
  CheckError,
  checkAnchorLiterals,
  checkRenderedFingerprint,
  describeCoverage,
  findBuilderFiles,
  renderHumanReport,
  renderMarkdownReport,
};
