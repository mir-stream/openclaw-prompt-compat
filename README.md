# @mir-stream/openclaw-prompt-compat

An OpenClaw compatibility plugin that changes one identity sentence in
fingerprinted OpenClaw system prompts:

```text
You are a personal assistant running inside OpenClaw.
→
You are a personal assistant running within OpenClaw.
```

The plugin is provider- and model-independent. It has no configuration and no
runtime dependencies.

## How it is scoped

The plugin registers one input-only text replacement with
`api.registerTextTransforms`. The non-global regular expression changes only
the exact identity sentence at the absolute string start and only when the same
string also contains this ordered fingerprint:

1. `## Tooling` immediately after the identity sentence
2. OpenClaw 2026.7.1's fixed Tooling preamble immediately after that heading:
   `Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.`
3. `## Workspace Files (injected)` later in the string
4. OpenClaw's internal `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker later still
5. `## Runtime` after the cache boundary

The core prompt must start at the absolute string start. Arbitrary or
hook-prepended system context before the core prompt, an inline copy, changed
capitalization, whitespace, headings, marker order, or an incomplete prompt
does not match. `promptMode: "none"` does not carry the required fingerprint
and is not changed.

The absolute anchor prevents quoted identity or scaffold text in prepended
context from borrowing the real prompt's later markers. Atomic marker segments
prevent repeated near-matches or marker chains from causing quadratic or
combinatorial rescans. Marker gaps may be empty, including a cache boundary
immediately followed by `## Runtime`.

## Compatibility

- Package: `@mir-stream/openclaw-prompt-compat@0.1.0`
- Plugin id: `openclaw-prompt-compat`
- OpenClaw host: `>=2026.7.1`
- OpenClaw plugin API: `>=2026.7.1`
- Node.js: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`

The fingerprint is intentionally tied to the OpenClaw `2026.7.1` prompt
structure. Future OpenClaw prompt changes fail closed: if the required
structure is absent or reordered, this plugin makes no replacement.

## Install

Install and pin the published version:

```sh
openclaw plugins install \
  "npm:@mir-stream/openclaw-prompt-compat@0.1.0" \
  --pin
```

Restart the Gateway if the running deployment does not reload plugins
automatically:

```sh
openclaw gateway restart
```

## Disable or uninstall

Disabling is the preferred operational rollback because it preserves the
installed package:

```sh
openclaw plugins disable openclaw-prompt-compat
openclaw gateway restart
```

Setup automation should preserve an explicitly disabled entry. Avoid
unconditionally reinstalling with `plugins install --force`, which can enable
the plugin again.

To remove the managed package and its install record:

```sh
openclaw plugins uninstall openclaw-prompt-compat
```

An external setup process may reinstall an absent plugin. If setup automation
manages this package, give it a persistent opt-out before uninstalling.

## Security limitation

`registerTextTransforms` is a global input-text compatibility API, not a
system-prompt-only API. OpenClaw can apply registered input replacements to
system prompts, user and assistant messages, tool results, conversation
history, and string values inside tool-call arguments.

The structural fingerprint makes ordinary collisions—including a standalone
identity sentence or a generic identity-plus-Tooling quote—very unlikely. It is
not a security boundary. A user, tool result, or history entry that deliberately
copies the exact identity, fixed 2026.7.1 Tooling preamble, and later structural
markers can also match and have its first identity sentence changed. Strict
system-prompt-only behavior requires a dedicated upstream OpenClaw transform
surface.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run pack
```

`npm run pack` performs an npm package dry-run and lists the files that would
be published.
