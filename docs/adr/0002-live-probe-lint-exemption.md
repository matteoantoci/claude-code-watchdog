# The live probe is outside the lint and the type check; the plugin is not

`.oxlintrc.json` keeps `"ignorePatterns": ["scripts/live-probe/"]`, and the root `tsconfig.json` does not include that folder. The lint rules and the type check are for the plugin, the code that ships. The L3 live probe (spec §16.3) does not ship: a person runs it by hand before a release, on a real model and login, and neither pre-commit nor CI runs it. It is Node code that must import `node:*` (`node:child_process` to start `claude`, `node:fs` to read the session logs, `node:http` for the error proxy). The repo installs no Node types, because spec §2 allows no `node:*` module in the plugin. So the type-aware rules read each `node:*` value as `any` and flag it thousands of times (`no-unsafe-*`), and `proxy.mjs` is a near-verbatim copy that spec §16.3 requires.

## Consequences

- The plugin's lint config stays the spec §2 config: `base` plus `typescript`, with no `overrides` key and no `oxlint-disable` comment. The ignore names one folder outside `plugins/`, so no rule is turned off for plugin code.
- The probe folder gets no lint at all, not only no type-aware rules: its long check files and their numbers are not held to `max-lines` or `no-magic-numbers`. `oxfmt` still formats it, so `npm run check` keeps its layout.
- A probe bug shows when a person runs the probe, not in `npm run check`.
- A file under `scripts/live-probe/` must never be imported by the plugin.

## Considered Options

- Lint the probe with the plugin's config: rejected, because every `node:*` value fails the type-aware rules, and the spec forbids the overrides that would turn those rules off.
- An `overrides` block that turns off the type-aware rules for `scripts/live-probe/`: rejected, because spec §2 says "No overrides", and the block would sit in the same config as the plugin's rules.
- Install Node types for the probe only: rejected, because the plugin and the probe share one `node_modules` and one type check, so the plugin could then type-check a `node:*` import that spec §2 forbids.
