# @mir-stream/openclaw-prompt-compat

An OpenClaw compatibility plugin that changes one identity sentence in
fingerprinted OpenClaw system prompts:

```text
You are a personal assistant running inside OpenClaw.
→
You are a personal assistant running within OpenClaw.
```

The replacement sentence is configurable; the sentence and structure it matches
are not. The plugin is provider- and model-independent and has no runtime
dependencies.

## Configuration

The plugin exposes one setting, `identitySentence`: the sentence written in
place of the matched OpenClaw identity. The plugin makes no assumptions about
the role — use any sentence that fits your deployment.

Config path:

```text
plugins.entries.openclaw-prompt-compat.config.identitySentence
```

### Set it non-interactively

Install `0.2.0` (or later) first — the setting is rejected by the strict config
schema until the version that declares it is installed. Then write the value and
restart the Gateway:

```sh
openclaw config set \
  "plugins.entries.openclaw-prompt-compat.config.identitySentence" \
  "You are the assistant for the Acme support desk."

openclaw gateway restart
```

The example sentence is illustrative only; substitute your own.

In a setup script, prefer batch mode — unlike value mode, it validates the
write against the schema, so an unknown key or an uninstalled version fails
loudly instead of writing silently:

```sh
openclaw config set --batch-file ./identity.batch.json
```

```json
[
  {
    "path": "plugins.entries.openclaw-prompt-compat.config.identitySentence",
    "value": "You are the assistant for the Acme support desk."
  }
]
```

Confirm the stored value with
`openclaw config get "plugins.entries.openclaw-prompt-compat.config.identitySentence"`.

### Equivalent config-file form

```json
{
  "plugins": {
    "entries": {
      "openclaw-prompt-compat": {
        "config": {
          "identitySentence": "You are the assistant for the Acme support desk."
        }
      }
    }
  }
}
```

### Behavior

- Default: `You are a personal assistant running within OpenClaw.` An install
  with no `config` behaves exactly as it did before this setting existed.
- Maximum length: 2000 characters, after trimming surrounding whitespace.
- Multiple lines are allowed. The prompt continues with `## Tooling` on its own
  line, so extra lines do not disturb the surrounding structure.
- A non-string, empty, whitespace-only, or over-long value logs a warning and
  falls back to the default rather than silently doing nothing. A value that
  repeats the original identity sentence is used as given, with a warning that
  it defeats the rewrite.
- Changing the value takes effect only after a Gateway restart — the rewrite is
  registered once at plugin startup.

## How it is scoped

The plugin registers one input-only text replacement with
`api.registerTextTransforms`. The non-global regular expression changes only
the exact identity sentence at the absolute string start, and only when that
string carries this ordered structural fingerprint:

1. The exact identity sentence at the absolute string start
2. `## Tooling` immediately after the identity sentence
3. `## Safety` later in the string
4. `## Workspace` after that, on a line of its own — the
   `## Workspace Files (injected)` line it prefixes does not satisfy it
5. `## Workspace Files (injected)` after that
6. OpenClaw's internal `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker later still
7. `## Runtime` after the cache boundary

Apart from the identity sentence itself, every anchor is a section heading or
an internal marker. Prompt prose is deliberately excluded: descriptive
sentences are rewritten from release to release, while these headings and their
order have held.

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

- Package: `@mir-stream/openclaw-prompt-compat@0.3.0`
- Plugin id: `openclaw-prompt-compat`
- OpenClaw host: `>=2026.7.1`
- OpenClaw plugin API: `>=2026.7.1`
- Node.js: `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`

The fingerprint uses only structural headings and markers — no prompt prose.
`## Tooling`, `## Safety`, `## Workspace`, `## Workspace Files (injected)`, and
`## Runtime` were present and in order in all 11 sampled OpenClaw releases from
`2026.2.26` through `2026.7.2-beta.4`; the `<!-- OPENCLAW_CACHE_BOUNDARY -->`
marker was introduced in `2026.4.15` and has not changed since. Rendered
prompts from `2026.4.15` through `2026.7.2-beta.4` all match.

That match range is not a support range. The supported host floor stays
`>=2026.7.1`; the fingerprint simply happens to match further back.

The fingerprint remains a structural dependency and fails closed: if the
required structure is absent or reordered, this plugin makes no replacement.

## Install

Install and pin the published version:

```sh
openclaw plugins install \
  "npm:@mir-stream/openclaw-prompt-compat@0.3.0" \
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
copies the exact identity sentence at its start and then all of the ordered
structural headings and markers can also match and have its first identity
sentence changed. Strict
system-prompt-only behavior requires a dedicated upstream OpenClaw transform
surface.

Because `identitySentence` is user-authored text, that text is what gets written
wherever the fingerprint matches — not only in system prompts. Treat a
configured sentence as content that may surface in any matching string, and keep
it free of secrets.

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
