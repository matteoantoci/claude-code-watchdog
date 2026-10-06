# L3 live probe

Run it by hand before each release and before each bump of the pinned Claude Code version, on a real model and login
(spec §16.3). It is not part of pre-commit or CI.

```
node scripts/live-probe/probe.mjs --list
node scripts/live-probe/probe.mjs                       # writes /tmp/wd-live-probe/<time>/report.md
node scripts/live-probe/probe.mjs --only fc,l3 --out /tmp/wd-live-probe/mine
```

It runs the 11 first checks (spec §16.4), the L3 column of §16.1 and the release-probe items of §16.5, with the §16.3
setup: the cached `~/.cache/claude-code-2.1.290/node_modules/.bin/claude` by its full path, `DISABLE_AUTOUPDATER=1`,
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `--setting-sources project,local`, and `env -u NO_COLOR -u CI TERM=xterm-256color`.

- A **deterministic** check fails the run (exit 1). An **advisory** check is model behavior or an engine fact the
  plugin does not depend on: it is reported and never fails the run.
- **inconclusive** means the model did not do the action the check needs, so the fact could not be seen. Rerun it.
- A deterministic check that this machine cannot run fails the run too (exit 1): the TUI checks need `tmux`. The
  summary line `missing on this machine: ...` names the missing capability and each check it kept from running. A
  check that you leave out with `--only`, `--skip`, `--kind`, `--with` or `--no-user-settings` does not fail the run.
- Some checks need an account state or an org setting. They are skipped unless you opt in, and they must be true when
  you do: `--with account:limit` (the account is at its subscription limit), `--with account:billing` (an API-key
  account with no credit), `--with account:api-key` (an API-key account), `--with org:ceiling`, `--with org:managed`.
- `--claude-version 2.1.x` runs `~/.cache/claude-code-2.1.x/node_modules/.bin/claude`, for a bump probe.
- A reload check writes `~/.claude/settings.json`. It is backed up first and restored in the same run, also on Ctrl-C.
  `--no-user-settings` skips those checks.
- Each session's files (stream-json, debug log, observer log, TUI captures, dump copies) are under `<out>/runs/`. The
  probe moves the dump files it made out of `~/.claude/watchdog/dumps/`, and it puts back the plugin's generated
  `.claude-plugin/types/` files, which each probe session writes again for its own settings.

`proxy.mjs` is the error proxy (copied from the failure probe, with the billing probe's keys merged in). The probe
starts it itself; `ANTHROPIC_BASE_URL` points at it only in the sessions that need an injected error.

## Why this folder is excluded from the checks

`scripts/live-probe/` is excluded from oxlint (`.oxlintrc.json` `ignorePatterns`) and is outside the `tsconfig.json`
include. The probe cannot follow the plugin's lint rules: it is Node code that imports `node:*`, and the repo has no
Node types (spec §2 allows no `node:*` in the plugin, so none are installed), so the type-aware rules flag each
`node:*` value as `any` (thousands of `no-unsafe-*` errors). `proxy.mjs` is a near-verbatim copy that the spec
requires. oxfmt still formats the folder. `npm run check` does not run the probe. The decision and its options are in
[ADR 0002](../../docs/adr/0002-live-probe-lint-exemption.md).

## Desktop checklist

Desktop support starts when Claude.app bundles Claude Code 2.1.290 or later. The probe cannot drive the desktop app, so
run this list by hand on that version and keep your notes beside the probe report (spec §16.3, §16.5). Install from the
marketplace first (`/plugin marketplace add matteoantoci/claude-code-watchdog`, `/plugin install watchdog@matteoantoci`)
and open a small git repo with a `WATCHDOG.json` of one `haiku` watchdog.

- [ ] `/watchdog` draws the status table, not `unsupported`: the bundled engine is 2.1.290 or later.
- [ ] The attach switch (§5.3): quit Claude.app, start it with `open --env CLAUDE_WATCHDOG=on -a Claude` and open a
      session. `/watchdog` shows it off, and `/watchdog dump` lists the warning `CLAUDE_WATCHDOG on state dropped at
      the Desktop attach`.
- [ ] A late `onByDefault` registration: with `onByDefault` on in `/config`, a new Desktop session is on before the
      first prompt, with no `/watchdog on`, and the first prompt gets a review.
- [ ] `/watchdog on` and `/watchdog off` answer, and `/watchdog status` draws the table (name, state, source file,
      tokens, cost).
- [ ] One real review: a note lands as a band card and a log row; a note that comes after the reply nudges; with
      `"subagents": { "Explore": true }`, an Explore subagent gets its note inside its tool result.
- [ ] The band paints, and the ctrl+o transcript view shows the review rows.
- [ ] `/watchdog dump` writes the file that the reply names. Desktop has no clipboard path, so there is no copy button.
- [ ] Stop a running review from the Desktop tasks UI: its dump record shows `- end: aborted`. The spawn caps and
      `maxTurns` act as in the terminal.
- [ ] `$.ui.log` rows, toasts and the status render on Desktop.
- [ ] A full L3 pass: the deterministic checks of one probe report hold on Desktop too (repeat by hand the steps that
      the probe drives in the terminal).
