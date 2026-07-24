import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import plugin, {
  COMPATIBLE_IDENTITY_SENTENCE,
  OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
  ORIGINAL_IDENTITY_SENTENCE,
  PLUGIN_ID,
  TOOLING_SECTION_PREAMBLE,
  createPromptCompatTextTransforms,
  replaceOpenClawPromptIdentity,
} from "../dist/index.js";

const CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

function fullPrompt(identity = ORIGINAL_IDENTITY_SENTENCE) {
  return [
    identity,
    "## Tooling",
    TOOLING_SECTION_PREAMBLE,
    "## Safety",
    "No independent goals.",
    "## Workspace",
    "Your working directory is: /workspace",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw.",
  ].join("\n") + CACHE_BOUNDARY + [
    "## Messaging",
    "Use the message tool.",
    "## Runtime",
    "Runtime: agent=main | model=openai/gpt-5",
  ].join("\n");
}

function minimalPrompt(identity = ORIGINAL_IDENTITY_SENTENCE) {
  return [
    identity,
    "## Tooling",
    TOOLING_SECTION_PREAMBLE,
    "- read: Read file contents",
    "## Workspace",
    "Your working directory is: /workspace",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw.",
  ].join("\n") + CACHE_BOUNDARY + [
    "## Subagent Context",
    "Handle one bounded task.",
    "## Runtime",
    "Runtime: agent=worker | model=openai/gpt-5",
  ].join("\n");
}

function applyRegistration(text, registration = createPromptCompatTextTransforms()) {
  return (registration.input ?? []).reduce(
    (next, replacement) => next.replace(replacement.from, replacement.to),
    text,
  );
}

test("declares a host-compatible external package contract", async () => {
  const [packageJson, manifest] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

  assert.equal(packageJson.name, "@mir-stream/openclaw-prompt-compat");
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.version, packageJson.version);
  assert.deepEqual(packageJson.openclaw.build, {
    openclawVersion: "2026.7.1",
    pluginSdkVersion: "2026.7.1",
  });
  assert.deepEqual(packageJson.openclaw.extensions, ["./dist/index.js"]);
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1");
  assert.equal(
    packageJson.engines.node,
    ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0",
  );
  assert.equal(packageJson.dependencies, undefined);
});

test("rewrites a full OpenClaw system-prompt fingerprint", () => {
  const input = fullPrompt();
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(output, input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE));
});

test("rewrites a minimal OpenClaw system-prompt fingerprint", () => {
  const input = minimalPrompt();
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(output, input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE));
});

test("allows empty gaps between required prompt markers", () => {
  const input = [
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    TOOLING_SECTION_PREAMBLE,
    "## Workspace Files (injected)",
    "<!-- OPENCLAW_CACHE_BOUNDARY -->",
    "## Runtime",
    "Runtime: agent=minimal | model=compat/test",
  ].join("\n");

  assert.equal(
    replaceOpenClawPromptIdentity(input),
    input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE),
  );
});

test("rejects standardized plugin context prepended before the core prompt", () => {
  const input = [
    "---",
    "",
    "OpenClaw plugin-injected system context. This block is not workspace file content.",
    "",
    "OpenClaw plugin-injected system context.",
    "Compatibility context.",
    "",
    "---",
    "",
    fullPrompt(),
  ].join("\n");

  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("does not let a prepended identity and Tooling decoy borrow real markers", () => {
  const input = [
    "---",
    "",
    "OpenClaw plugin-injected system context. This block is not workspace file content.",
    "",
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    "This is only a quoted two-line decoy.",
    "",
    "---",
    "",
    fullPrompt(),
  ].join("\n");
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(output, input);
  assert.equal(output.split(ORIGINAL_IDENTITY_SENTENCE).length - 1, 2);
  assert.equal(output.includes(COMPATIBLE_IDENTITY_SENTENCE), false);
});

test("does not let an exact scaffold inside wrapped plugin context become the root", () => {
  const input = [
    "---",
    "",
    "OpenClaw plugin-injected system context. This block is not workspace file content.",
    "",
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    TOOLING_SECTION_PREAMBLE,
    "This is still quoted plugin context.",
    "",
    "---",
    "",
    fullPrompt(),
  ].join("\n");
  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("rejects arbitrary text prepended before the core prompt", () => {
  const input = `Arbitrary role-less text.\n${fullPrompt()}`;

  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("ignores an identity and Tooling copy inside the real Tooling section", () => {
  const quotedCopy = [
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    "This is quoted tool documentation, not a prompt root.",
  ].join("\n");
  const input = fullPrompt().replace(
    `${TOOLING_SECTION_PREAMBLE}\n`,
    `${TOOLING_SECTION_PREAMBLE}\n${quotedCopy}\n`,
  );
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(
    output,
    input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE),
  );
  assert.equal(output.includes(quotedCopy), true);
});

test("ignores an identity and Tooling copy after Workspace Files", () => {
  const quotedCopy = [
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    "This is quoted project context, not a prompt root.",
  ].join("\n");
  const input = fullPrompt().replace(
    "These user-editable files are loaded by OpenClaw.",
    `These user-editable files are loaded by OpenClaw.\n${quotedCopy}`,
  );
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(
    output,
    input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE),
  );
  assert.equal(output.includes(quotedCopy), true);
});

test("does not rewrite a standalone user copy of the identity sentence", () => {
  assert.equal(
    replaceOpenClawPromptIdentity(ORIGINAL_IDENTITY_SENTENCE),
    ORIGINAL_IDENTITY_SENTENCE,
  );
});

test("does not rewrite the identity sentence in the middle of a line", () => {
  const input = `Inline copy: ${fullPrompt()}`;

  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("rejects partial and incorrectly ordered fingerprints", () => {
  const partialAndWrongOrder = [
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n## Workspace Files (injected)\n## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n${CACHE_BOUNDARY}## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n## Workspace Files (injected)\n## Runtime\n${CACHE_BOUNDARY}`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n${CACHE_BOUNDARY}## Workspace Files (injected)\n## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Workspace Files (injected)\n## Tooling\n${CACHE_BOUNDARY}## Runtime\n`,
  ];

  for (const input of partialAndWrongOrder) {
    assert.equal(replaceOpenClawPromptIdentity(input), input);
  }
});

test("does not rewrite promptMode none shapes", () => {
  const nonePrompts = [
    ORIGINAL_IDENTITY_SENTENCE,
    `${ORIGINAL_IDENTITY_SENTENCE}\nCurrent model identity: openai/gpt-5.`,
    "Current model identity: openai/gpt-5.",
  ];

  for (const input of nonePrompts) {
    assert.equal(replaceOpenClawPromptIdentity(input), input);
  }
});

test("requires exact identity, marker case, and whitespace", () => {
  const variants = [
    fullPrompt("you are a personal assistant running inside OpenClaw."),
    fullPrompt(` ${ORIGINAL_IDENTITY_SENTENCE}`),
    fullPrompt("You are a personal assistant running  inside OpenClaw."),
    fullPrompt("You are a personal assistant running inside OpenClaw. "),
    fullPrompt().replace(
      `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n`,
      `${ORIGINAL_IDENTITY_SENTENCE}\n\n## Tooling\n`,
    ),
    fullPrompt().replace("\n## Tooling\n", "\n## tooling\n"),
    fullPrompt().replace("\n## Tooling\n", "\r\n## Tooling\r\n"),
    fullPrompt().replace(
      TOOLING_SECTION_PREAMBLE,
      "Available tools are policy filtered. Names are case-sensitive; call exactly as listed.",
    ),
    fullPrompt().replace(
      "\n## Workspace Files (injected)\n",
      "\n## Workspace Files (Injected)\n",
    ),
    fullPrompt().replace(CACHE_BOUNDARY, "\n<!-- openclaw_cache_boundary -->\n"),
    fullPrompt().replace("\n## Runtime\n", "\n## Runtime \n"),
  ];

  for (const input of variants) {
    assert.equal(replaceOpenClawPromptIdentity(input), input);
  }
});

test("uses a non-global stateless regex and changes at most one identity", () => {
  assert.equal(OPENCLAW_SYSTEM_PROMPT_FINGERPRINT.source.startsWith("^"), true);
  assert.equal(OPENCLAW_SYSTEM_PROMPT_FINGERPRINT.global, false);
  assert.equal(OPENCLAW_SYSTEM_PROMPT_FINGERPRINT.sticky, false);

  const input = `${fullPrompt()}\n\n${fullPrompt()}`;
  const output = replaceOpenClawPromptIdentity(input);

  assert.equal(output.split(COMPATIBLE_IDENTITY_SENTENCE).length - 1, 1);
  assert.equal(output.split(ORIGINAL_IDENTITY_SENTENCE).length - 1, 1);
  assert.equal(OPENCLAW_SYSTEM_PROMPT_FINGERPRINT.lastIndex, 0);
});

test("rejects repeated near-matches without quadratic rescanning", () => {
  const input =
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n`.repeat(12_000);
  const startedAt = performance.now();

  assert.equal(replaceOpenClawPromptIdentity(input), input);
  assert.ok(
    performance.now() - startedAt < 500,
    "adversarial near-match scan exceeded 500 ms",
  );
});

test("rejects repeated marker chains without combinatorial backtracking", () => {
  const repeatedMarkers = [
    "",
    "## Workspace Files (injected)",
    "Injected content.",
    "<!-- OPENCLAW_CACHE_BOUNDARY -->",
    "",
  ].join("\n").repeat(1_000);
  const input =
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${TOOLING_SECTION_PREAMBLE}\n${repeatedMarkers}`;
  const startedAt = performance.now();

  assert.equal(replaceOpenClawPromptIdentity(input), input);
  assert.ok(
    performance.now() - startedAt < 500,
    "adversarial marker-chain scan exceeded 500 ms",
  );
});

test("registers exactly one input replacement and no output replacement", () => {
  const registrations = [];
  plugin.register({
    registerTextTransforms(registration) {
      registrations.push(registration);
    },
  });

  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(registrations.length, 1);
  assert.deepEqual(Object.keys(registrations[0]), ["input"]);
  assert.equal(registrations[0].input.length, 1);
  assert.equal(registrations[0].output, undefined);
  assert.equal(applyRegistration(fullPrompt(), registrations[0]).startsWith(
    COMPATIBLE_IDENTITY_SENTENCE,
  ), true);
});

test("documents the residual collision for a deliberately copied full fingerprint", () => {
  const copiedUserContent = fullPrompt();
  const output = applyRegistration(copiedUserContent);

  assert.notEqual(output, copiedUserContent);
  assert.equal(output.includes(COMPATIBLE_IDENTITY_SENTENCE), true);
});
