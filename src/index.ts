/**
 * OpenClaw prompt identity compatibility transform.
 *
 * The replacement changes only the identity sentence. Atomic-lookahead
 * captures and backreferences fingerprint the ordered OpenClaw system-prompt
 * structure without consuming or rewriting the rest of the prompt.
 */

export const PLUGIN_ID = "openclaw-prompt-compat";
export const PLUGIN_NAME = "OpenClaw Prompt Compatibility";
export const PLUGIN_DESCRIPTION =
  "Rewrites one fingerprinted OpenClaw system-prompt identity sentence for endpoint compatibility.";

export const ORIGINAL_IDENTITY_SENTENCE =
  "You are a personal assistant running inside OpenClaw.";
export const COMPATIBLE_IDENTITY_SENTENCE =
  "You are a personal assistant running within OpenClaw.";

export const TOOLING_SECTION_MARKER = "\n## Tooling\n";
export const TOOLING_SECTION_PREAMBLE =
  "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.";
export const WORKSPACE_FILES_SECTION_MARKER = "\n## Workspace Files (injected)\n";
export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";
export const RUNTIME_SECTION_MARKER = "\n## Runtime\n";

/**
 * OpenClaw 2026.7.1's core prompt starts with the identity sentence. Requiring
 * that absolute root prevents arbitrary or hook-prepended text from borrowing
 * the real prompt's later markers. Each marker segment is captured in an
 * atomic lookahead and consumed by backreference, keeping adversarial failure
 * paths linear while leaving the matched span limited to the identity.
 *
 * The regex is non-global and non-sticky, so repeated calls are stateless and
 * at most one identity sentence is changed per input string.
 */
const ORIGINAL_IDENTITY_PATTERN =
  "You are a personal assistant running inside OpenClaw\\.";
const TOOLING_SECTION_PREAMBLE_PATTERN =
  "Available tools are policy-filtered\\. Names are case-sensitive; call exactly as listed\\.";

export const OPENCLAW_SYSTEM_PROMPT_FINGERPRINT =
  new RegExp(
    `^${ORIGINAL_IDENTITY_PATTERN}(?=` +
      "\\n## Tooling\\n" +
      `${TOOLING_SECTION_PREAMBLE_PATTERN}\\n` +
      "(?=([\\s\\S]*?(?<![^\\n])## Workspace Files \\(injected\\)\\n))\\1" +
      "(?=([\\s\\S]*?(?<![^\\n])<!-- OPENCLAW_CACHE_BOUNDARY -->\\n))\\2" +
      "(?=([\\s\\S]*?(?<![^\\n])## Runtime\\n))\\3" +
      ")",
  );

export const COMPATIBLE_IDENTITY_REPLACEMENT =
  COMPATIBLE_IDENTITY_SENTENCE;

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
};

export type PromptCompatPluginEntry = {
  id: string;
  name: string;
  description: string;
  register(api: PromptCompatPluginApi): void;
};

/** Returns a fresh one-replacement registration payload. */
export function createPromptCompatTextTransforms(): PromptCompatTextTransforms {
  return {
    input: [
      {
        from: OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
        to: COMPATIBLE_IDENTITY_REPLACEMENT,
      },
    ],
  };
}

/** Applies the same replacement used by the OpenClaw registration. */
export function replaceOpenClawPromptIdentity(text: string): string {
  return text.replace(
    OPENCLAW_SYSTEM_PROMPT_FINGERPRINT,
    COMPATIBLE_IDENTITY_REPLACEMENT,
  );
}

/** Registers exactly one input-only compatibility replacement. */
export function registerPromptCompat(api: PromptCompatPluginApi): void {
  api.registerTextTransforms(createPromptCompatTextTransforms());
}

const plugin: PromptCompatPluginEntry = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: PLUGIN_DESCRIPTION,
  register: registerPromptCompat,
};

export default plugin;
