/**
 * OpenClaw prompt identity compatibility transform.
 *
 * The replacement changes only the identity sentence. Atomic-lookahead
 * captures and backreferences fingerprint the ordered OpenClaw system-prompt
 * structure — section headings and internal markers only, never prose —
 * without consuming or rewriting the rest of the prompt.
 *
 * The fingerprint is fixed. Only the replacement sentence is configurable, so
 * user configuration can never widen what this plugin matches.
 */

export const PLUGIN_ID = "openclaw-prompt-compat";
export const PLUGIN_NAME = "OpenClaw Prompt Compatibility";
export const PLUGIN_DESCRIPTION =
  "Rewrites the fingerprinted OpenClaw system-prompt identity sentence with a configurable sentence.";

export const ORIGINAL_IDENTITY_SENTENCE =
  "You are a personal assistant running inside OpenClaw.";

/**
 * Used whenever no valid `identitySentence` is configured. Its value is frozen:
 * an install that carries no configuration must behave exactly as before this
 * setting existed.
 */
export const DEFAULT_IDENTITY_SENTENCE =
  "You are a personal assistant running within OpenClaw.";

/** Pre-configuration name for {@link DEFAULT_IDENTITY_SENTENCE}. */
export const COMPATIBLE_IDENTITY_SENTENCE = DEFAULT_IDENTITY_SENTENCE;

/** Mirrors `configSchema.properties.identitySentence.maxLength` in the manifest. */
export const MAX_IDENTITY_SENTENCE_LENGTH = 2000;

/** Declared in the order OpenClaw renders them. */
export const TOOLING_SECTION_MARKER = "\n## Tooling\n";
export const SAFETY_SECTION_MARKER = "\n## Safety\n";
export const WORKSPACE_SECTION_MARKER = "\n## Workspace\n";
export const WORKSPACE_FILES_SECTION_MARKER = "\n## Workspace Files (injected)\n";
export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
export const RUNTIME_SECTION_MARKER = "\n## Runtime\n";

/**
 * The OpenClaw core prompt starts with the identity sentence. Requiring that
 * absolute root prevents arbitrary or hook-prepended text from borrowing the
 * real prompt's later markers. Each marker segment is captured in an atomic
 * lookahead and consumed by backreference, keeping adversarial failure paths
 * linear while leaving the matched span limited to the identity.
 *
 * Every anchor is a structural heading or marker. Prose was measured to be an
 * unstable anchor — descriptive sentences are rewritten release to release,
 * while the five headings and their order held across all 11 sampled OpenClaw
 * releases from 2026.2.26 through 2026.7.2-beta.4. The cache boundary is the
 * one exception: it was introduced in 2026.4.15 and has been unchanged since,
 * so it is the reason rendered prompts match no further back than that
 * release. Every anchor renders unconditionally in the releases that have it,
 * including under `promptMode: "minimal"`.
 *
 * The regex is non-global and non-sticky, so repeated calls are stateless and
 * at most one identity sentence is changed per input string.
 */
const ORIGINAL_IDENTITY_PATTERN =
  "You are a personal assistant running inside OpenClaw\\.";

/**
 * A marker segment: everything up to the next line that starts with `marker`.
 * The trailing `\n` keeps `## Workspace` from being satisfied by the later
 * `## Workspace Files (injected)` line it prefixes.
 *
 * `marker` is a regex fragment, not a literal — escaping is the caller's
 * responsibility. An anchor containing `.`, `(`, or any other metacharacter
 * would silently widen the pattern if passed unescaped.
 */
const markerSegment = (marker: string) =>
  `(?=([\\s\\S]*?(?<![^\\n])${marker}\\n))`;

export const OPENCLAW_SYSTEM_PROMPT_FINGERPRINT =
  new RegExp(
    `^${ORIGINAL_IDENTITY_PATTERN}(?=` +
      "\\n## Tooling\\n" +
      markerSegment("## Safety") + "\\1" +
      markerSegment("## Workspace") + "\\2" +
      markerSegment("## Workspace Files \\(injected\\)") + "\\3" +
      markerSegment("<!-- OPENCLAW_CACHE_BOUNDARY -->") + "\\4" +
      markerSegment("## Runtime") + "\\5" +
      ")",
  );

/**
 * Escapes a sentence for use as a `String.prototype.replace` replacement.
 *
 * A replacement string treats `$$`, `$&`, `` $` ``, `$'`, and `$1`-`$9` as
 * substitution sequences, and the fingerprint above has five capture groups.
 * A configured sentence containing `$` would otherwise splice captured prompt
 * body text into the output or lose characters. The replacer callback returns
 * its value literally, so `$` becomes exactly `$$`.
 */
function escapeReplacementSentence(sentence: string): string {
  return sentence.replace(/\$/g, () => "$$");
}

/** Escaped {@link DEFAULT_IDENTITY_SENTENCE}, as registered when unconfigured. */
export const COMPATIBLE_IDENTITY_REPLACEMENT =
  escapeReplacementSentence(DEFAULT_IDENTITY_SENTENCE);

export type PromptCompatConfig = {
  identitySentence?: string;
};

export type PromptCompatLogger = {
  warn(message: string): void;
};

export type PromptCompatTextReplacement = {
  from: string | RegExp;
  to: string;
};

export type PromptCompatTextTransforms = {
  input?: PromptCompatTextReplacement[];
  output?: PromptCompatTextReplacement[];
};

export type PromptCompatPluginApi = {
  registerTextTransforms(transforms: PromptCompatTextTransforms): void;
  pluginConfig?: Record<string, unknown>;
  logger?: PromptCompatLogger;
};

export type PromptCompatPluginEntry = {
  id: string;
  name: string;
  description: string;
  register(api: PromptCompatPluginApi): void;
};

/**
 * Resolves the sentence to write, falling back to
 * {@link DEFAULT_IDENTITY_SENTENCE} for any value the manifest schema would
 * not accept. Every fallback warns: a silently inert plugin is the failure
 * mode this project most wants to avoid. Absent configuration is the normal
 * path and warns nothing.
 *
 * Multi-line sentences are allowed. The prompt continues with `## Tooling` on
 * its own line, so extra lines cannot damage the surrounding structure.
 */
export function resolveIdentitySentence(
  pluginConfig: unknown,
  logger?: PromptCompatLogger,
): string {
  if (typeof pluginConfig !== "object" || pluginConfig === null) {
    return DEFAULT_IDENTITY_SENTENCE;
  }

  const configured = (pluginConfig as PromptCompatConfig).identitySentence;
  if (configured === undefined) {
    return DEFAULT_IDENTITY_SENTENCE;
  }

  if (typeof configured !== "string") {
    logger?.warn(
      `${PLUGIN_ID}: config "identitySentence" must be a string, received ${typeof configured}; ` +
        `using the default sentence instead.`,
    );
    return DEFAULT_IDENTITY_SENTENCE;
  }

  const sentence = configured.trim();
  if (sentence.length === 0) {
    logger?.warn(
      `${PLUGIN_ID}: config "identitySentence" is empty or whitespace only; ` +
        `using the default sentence instead.`,
    );
    return DEFAULT_IDENTITY_SENTENCE;
  }

  if (sentence.length > MAX_IDENTITY_SENTENCE_LENGTH) {
    logger?.warn(
      `${PLUGIN_ID}: config "identitySentence" is ${sentence.length} characters, ` +
        `above the ${MAX_IDENTITY_SENTENCE_LENGTH} character limit; ` +
        `using the default sentence instead.`,
    );
    return DEFAULT_IDENTITY_SENTENCE;
  }

  if (sentence.includes(ORIGINAL_IDENTITY_SENTENCE)) {
    logger?.warn(
      `${PLUGIN_ID}: config "identitySentence" contains the original OpenClaw identity sentence, ` +
        `which defeats the compatibility rewrite; using the configured value as given.`,
    );
  }

  return sentence;
}

/** Returns a fresh one-replacement registration payload. */
export function createPromptCompatTextTransforms(
  identitySentence: string = DEFAULT_IDENTITY_SENTENCE,
): PromptCompatTextTransforms {
  return {
    input: [
      {
        from: OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
        to: escapeReplacementSentence(identitySentence),
      },
    ],
  };
}

/** Applies the same replacement used by the OpenClaw registration. */
export function replaceOpenClawPromptIdentity(
  text: string,
  identitySentence: string = DEFAULT_IDENTITY_SENTENCE,
): string {
  return text.replace(
    OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
    escapeReplacementSentence(identitySentence),
  );
}

/** Registers exactly one input-only compatibility replacement. */
export function registerPromptCompat(api: PromptCompatPluginApi): void {
  api.registerTextTransforms(
    createPromptCompatTextTransforms(
      resolveIdentitySentence(api.pluginConfig, api.logger),
    ),
  );
}

const plugin: PromptCompatPluginEntry = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  register: registerPromptCompat,
};

export default plugin;
