import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

import plugin, {
  COMPATIBLE_IDENTITY_SENTENCE,
  DEFAULT_IDENTITY_SENTENCE,
  MAX_IDENTITY_SENTENCE_LENGTH,
  OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
  ORIGINAL_IDENTITY_SENTENCE,
  PLUGIN_ID,
  createPromptCompatTextTransforms,
  replaceOpenClawPromptIdentity,
  resolveIdentitySentence,
} from "../dist/index.js";

const CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

/**
 * OpenClaw rewrote its system-prompt prose in 2026.7.2. None of that prose is
 * part of the fingerprint any more, so both wordings live here as fixture
 * literals and every positive case is run against both shapes.
 */
const PROMPT_SHAPES = [
  {
    version: "2026.7.1",
    toolingPreamble:
      "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.",
    workspaceLine: "Your working directory is: /workspace",
  },
  {
    version: "2026.7.2-beta",
    toolingPreamble: "Tools policy-filtered. Names case-sensitive; call exact.",
    workspaceLine: "Working directory: /workspace",
  },
];

const [SHAPE_2026_7_1] = PROMPT_SHAPES;
const TOOLING_PREAMBLE = SHAPE_2026_7_1.toolingPreamble;

function fullPrompt(identity = ORIGINAL_IDENTITY_SENTENCE, shape = SHAPE_2026_7_1) {
  return [
    identity,
    "## Tooling",
    shape.toolingPreamble,
    "## Safety",
    "No independent goals.",
    "## Workspace",
    shape.workspaceLine,
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw.",
  ].join("\n") + CACHE_BOUNDARY + [
    "## Messaging",
    "Use the message tool.",
    "## Runtime",
    "Runtime: agent=main | model=openai/gpt-5",
  ].join("\n");
}

function minimalPrompt(identity = ORIGINAL_IDENTITY_SENTENCE, shape = SHAPE_2026_7_1) {
  return [
    identity,
    "## Tooling",
    shape.toolingPreamble,
    "- read: Read file contents",
    "## Safety",
    "No independent goals.",
    "## Workspace",
    shape.workspaceLine,
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
  assert.equal(packageJson.version, "0.3.0");
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.configSchema.properties.identitySentence.type, "string");
  assert.equal(manifest.configSchema.properties.identitySentence.minLength, 1);
  assert.equal(
    manifest.configSchema.properties.identitySentence.maxLength,
    MAX_IDENTITY_SENTENCE_LENGTH,
  );
  assert.deepEqual(packageJson.openclaw.build, {
    openclawVersion: "2026.7.1",
    pluginSdkVersion: "2026.7.1",
  });
  assert.deepEqual(packageJson.openclaw.extensions, ["./dist/index.js"]);
  assert.equal(packageJson.openclaw.compat.pluginApi, ">=2026.7.1");
  assert.equal(packageJson.openclaw.install.minHostVersion, ">=2026.7.1");
  assert.equal(packageJson.peerDependencies.openclaw, ">=2026.7.1");
  assert.equal(
    packageJson.engines.node,
    ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0",
  );
  assert.equal(packageJson.dependencies, undefined);
});

test("rewrites full and minimal prompts across prose rewrites", () => {
  for (const shape of PROMPT_SHAPES) {
    for (const input of [fullPrompt(undefined, shape), minimalPrompt(undefined, shape)]) {
      assert.equal(
        replaceOpenClawPromptIdentity(input),
        input.replace(ORIGINAL_IDENTITY_SENTENCE, COMPATIBLE_IDENTITY_SENTENCE),
        `${shape.version} prompt shape must still match`,
      );
    }
  }
});

test("allows empty gaps between required prompt markers", () => {
  const input = [
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    "## Safety",
    "## Workspace",
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
    "## Safety",
    "## Workspace",
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
    `${TOOLING_PREAMBLE}\n`,
    `${TOOLING_PREAMBLE}\n${quotedCopy}\n`,
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
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n## Workspace Files (injected)\n## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n${CACHE_BOUNDARY}## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n## Workspace Files (injected)\n## Runtime\n${CACHE_BOUNDARY}`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n${CACHE_BOUNDARY}## Workspace Files (injected)\n## Runtime\n`,
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Workspace Files (injected)\n## Tooling\n${CACHE_BOUNDARY}## Runtime\n`,
  ];

  for (const input of partialAndWrongOrder) {
    assert.equal(replaceOpenClawPromptIdentity(input), input);
  }
});

test("rejects a prompt without the Safety section", () => {
  const input = fullPrompt().replace("## Safety\nNo independent goals.\n", "");

  assert.equal(input.includes("## Safety"), false);
  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("does not let Workspace Files stand in for the Workspace heading", () => {
  const input = [
    ORIGINAL_IDENTITY_SENTENCE,
    "## Tooling",
    TOOLING_PREAMBLE,
    "## Safety",
    "No independent goals.",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw.",
  ].join("\n") + CACHE_BOUNDARY + "## Runtime\nRuntime: agent=main | model=openai/gpt-5";

  assert.equal(input.includes("## Workspace Files (injected)"), true);
  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("rejects Safety and Workspace in the wrong order", () => {
  const input = fullPrompt().replace(
    "## Safety\nNo independent goals.\n## Workspace\n",
    `## Workspace\n${SHAPE_2026_7_1.workspaceLine}\n## Safety\nNo independent goals.\n`,
  );

  assert.equal(input.indexOf("## Workspace\n") < input.indexOf("## Safety\n"), true);
  assert.equal(replaceOpenClawPromptIdentity(input), input);
});

test("rejects changed case in the Safety and Workspace headings", () => {
  const variants = [
    fullPrompt().replace("\n## Safety\n", "\n## safety\n"),
    fullPrompt().replace("\n## Safety\n", "\n## SAFETY\n"),
    fullPrompt().replace("\n## Workspace\n", "\n## workspace\n"),
    fullPrompt().replace("\n## Workspace\n", "\n## WorkSpace\n"),
  ];

  for (const input of variants) {
    assert.equal(replaceOpenClawPromptIdentity(input), input);
  }
});

test("rejects Safety and Workspace headings placed mid-line", () => {
  const variants = [
    fullPrompt().replace("\n## Safety\n", "\nQuoted: ## Safety\n"),
    fullPrompt().replace("\n## Workspace\n", "\nQuoted: ## Workspace\n"),
  ];

  for (const input of variants) {
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
    fullPrompt().replace("\n## Safety\n", "\n## Safety \n"),
    fullPrompt().replace("\n## Safety\n", "\r\n## Safety\r\n"),
    fullPrompt().replace("\n## Workspace\n", "\n##  Workspace\n"),
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
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n`.repeat(12_000);
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
  const input = `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n${repeatedMarkers}`;
  const startedAt = performance.now();

  assert.equal(replaceOpenClawPromptIdentity(input), input);
  assert.ok(
    performance.now() - startedAt < 500,
    "adversarial marker-chain scan exceeded 500 ms",
  );
});

test("rejects repeated chains of every anchor without combinatorial backtracking", () => {
  const repeatedMarkers = [
    "",
    "## Safety",
    "No independent goals.",
    "## Workspace",
    "Working directory: /workspace",
    "## Workspace Files (injected)",
    "Injected content.",
    "<!-- OPENCLAW_CACHE_BOUNDARY -->",
    "",
  ].join("\n").repeat(1_000);
  const input = `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n${repeatedMarkers}`;
  const startedAt = performance.now();

  assert.equal(replaceOpenClawPromptIdentity(input), input);
  assert.ok(
    performance.now() - startedAt < 500,
    "adversarial full-anchor chain scan exceeded 500 ms",
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

function fakeLogger() {
  const warnings = [];
  return {
    warnings,
    warn(message) {
      warnings.push(message);
    },
  };
}

function register(api) {
  const registrations = [];
  plugin.register({
    registerTextTransforms(registration) {
      registrations.push(registration);
    },
    ...api,
  });

  assert.equal(registrations.length, 1);
  return registrations[0];
}

/** Replaces without letting the test itself hit `$` replacement sequences. */
function expectedRewrite(input, identity) {
  return input.replace(ORIGINAL_IDENTITY_SENTENCE, () => identity);
}

test("keeps the pre-configuration default sentence and export alias", () => {
  assert.equal(DEFAULT_IDENTITY_SENTENCE, "You are a personal assistant running within OpenClaw.");
  assert.equal(COMPATIBLE_IDENTITY_SENTENCE, DEFAULT_IDENTITY_SENTENCE);
  assert.equal(MAX_IDENTITY_SENTENCE_LENGTH, 2000);
});

test("uses the default sentence when no identitySentence is configured", () => {
  const logger = fakeLogger();
  const apis = [
    {},
    { pluginConfig: undefined, logger },
    { pluginConfig: {}, logger },
    { pluginConfig: { identitySentence: undefined }, logger },
  ];

  for (const api of apis) {
    const registration = register(api);

    assert.equal(
      applyRegistration(fullPrompt(), registration),
      expectedRewrite(fullPrompt(), DEFAULT_IDENTITY_SENTENCE),
    );
  }

  assert.deepEqual(logger.warnings, []);
});

test("rewrites full and minimal prompts with a configured sentence", () => {
  const identitySentence = "You are an assistant that helps with office and administrative work.";
  const logger = fakeLogger();
  const registration = register({ pluginConfig: { identitySentence }, logger });

  for (const shape of PROMPT_SHAPES) {
    for (const input of [fullPrompt(undefined, shape), minimalPrompt(undefined, shape)]) {
      const output = applyRegistration(input, registration);

      assert.equal(output, expectedRewrite(input, identitySentence));
      assert.equal(output.startsWith(identitySentence), true);
    }
  }

  assert.deepEqual(logger.warnings, []);
  assert.equal(
    replaceOpenClawPromptIdentity(fullPrompt(), identitySentence),
    expectedRewrite(fullPrompt(), identitySentence),
  );
});

test("inserts a configured sentence containing $ sequences literally", () => {
  const identitySentence =
    "You are an office assistant. Budget: $1 and $& and $' and $` and $$.";
  const registration = register({ pluginConfig: { identitySentence } });
  const input = fullPrompt();

  for (const output of [
    applyRegistration(input, registration),
    replaceOpenClawPromptIdentity(input, identitySentence),
  ]) {
    assert.equal(output.startsWith(identitySentence), true);
    assert.equal(output, expectedRewrite(input, identitySentence));
    assert.equal(output.includes(ORIGINAL_IDENTITY_SENTENCE), false);
    assert.equal(output.split("\n## Safety\n").length - 1, 1);
    assert.equal(output.split("\n## Workspace\n").length - 1, 1);
    assert.equal(output.split("\n## Workspace Files (injected)\n").length - 1, 1);
    assert.equal(output.split("## Runtime").length - 1, 1);
    assert.equal(output.split(CACHE_BOUNDARY).length - 1, 1);
  }
});

test("allows a multi-line configured sentence and keeps the Tooling section intact", () => {
  const identitySentence = "You are an office assistant.\nYou draft and file documents.";
  const registration = register({ pluginConfig: { identitySentence } });
  const output = applyRegistration(fullPrompt(), registration);

  assert.equal(output.startsWith(`${identitySentence}\n## Tooling\n`), true);
  assert.equal(output.includes(`\n## Tooling\n${TOOLING_PREAMBLE}\n`), true);
});

test("warns and falls back for invalid identitySentence values", () => {
  const invalidValues = [
    42,
    true,
    null,
    { sentence: "no" },
    ["no"],
    "",
    "   \n\t ",
    "x".repeat(MAX_IDENTITY_SENTENCE_LENGTH + 1),
  ];

  for (const identitySentence of invalidValues) {
    const logger = fakeLogger();
    const registration = register({ pluginConfig: { identitySentence }, logger });

    assert.equal(
      applyRegistration(fullPrompt(), registration),
      expectedRewrite(fullPrompt(), DEFAULT_IDENTITY_SENTENCE),
    );
    assert.equal(logger.warnings.length, 1);
    assert.equal(logger.warnings[0].includes("identitySentence"), true);
    assert.equal(logger.warnings[0].includes(PLUGIN_ID), true);
  }
});

test("resolves a trimmed sentence and tolerates a missing logger", () => {
  assert.equal(
    resolveIdentitySentence({ identitySentence: "  You are an office assistant.  " }),
    "You are an office assistant.",
  );
  assert.equal(resolveIdentitySentence(undefined), DEFAULT_IDENTITY_SENTENCE);
  assert.equal(resolveIdentitySentence("not an object"), DEFAULT_IDENTITY_SENTENCE);
  assert.equal(resolveIdentitySentence({ identitySentence: 42 }), DEFAULT_IDENTITY_SENTENCE);
  assert.equal(
    resolveIdentitySentence({ identitySentence: "x".repeat(MAX_IDENTITY_SENTENCE_LENGTH) }),
    "x".repeat(MAX_IDENTITY_SENTENCE_LENGTH),
  );
});

test("warns but keeps a configured sentence that repeats the original identity", () => {
  const identitySentence = `${ORIGINAL_IDENTITY_SENTENCE} You also handle office work.`;
  const logger = fakeLogger();
  const registration = register({ pluginConfig: { identitySentence }, logger });

  assert.equal(resolveIdentitySentence({ identitySentence }, logger), identitySentence);
  assert.equal(
    applyRegistration(fullPrompt(), registration).startsWith(identitySentence),
    true,
  );
  assert.equal(logger.warnings.length, 2);
  for (const warning of logger.warnings) {
    assert.equal(warning.includes("identitySentence"), true);
  }
});

test("keeps the fingerprint scope unchanged for a configured sentence", () => {
  const identitySentence = "You are an office assistant.";
  const registration = register({ pluginConfig: { identitySentence } });
  const unchangedInputs = [
    `Arbitrary role-less text.\n${fullPrompt()}`,
    `Inline copy: ${fullPrompt()}`,
    ORIGINAL_IDENTITY_SENTENCE,
    [
      "---",
      "",
      "OpenClaw plugin-injected system context. This block is not workspace file content.",
      "",
      ORIGINAL_IDENTITY_SENTENCE,
      "## Tooling",
      "## Safety",
      "## Workspace",
      "This is still quoted plugin context.",
      "",
      "---",
      "",
      fullPrompt(),
    ].join("\n"),
    `${ORIGINAL_IDENTITY_SENTENCE}\n## Tooling\n## Safety\n## Workspace\n## Workspace Files (injected)\n## Runtime\n`,
    fullPrompt().replace("\n## Tooling\n", "\n## tooling\n"),
    fullPrompt().replace("\n## Safety\n", "\n## safety\n"),
  ];

  for (const input of unchangedInputs) {
    assert.equal(applyRegistration(input, registration), input);
    assert.equal(replaceOpenClawPromptIdentity(input, identitySentence), input);
  }
});
