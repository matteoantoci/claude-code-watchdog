# watchdog

A second model reviews each step that Claude Code takes and sends it short notes while it works: `nit`, `concern` or
`blocker`.

![A watchdog flags a planted bug and nudges Claude, which fixes it; the band card marks the note as maybe outdated and opens to the whole note, /watchdog status shows the review cost, and a later review retracts the note and raises a held concern: Claude reported a result it never ran](docs/assets/demo.gif)

## Requirements

Claude Code 2.1.290 or later. Watchdog is a mod: a plugin whose code Claude Code runs inside your session. The npm
`stable` channel (2.1.285 on 2026-10-06) has no mods. Below 2.1.290 the plugin shows `unsupported`. Desktop support
starts when Claude.app bundles Claude Code 2.1.290 or later.

## Quick start

```
/plugin marketplace add matteoantoci/claude-code-watchdog
/plugin install watchdog@matteoantoci
```

Then run `/watchdog on` (reviews are off until you do) and ask Claude for a small change. The note shows as a
`watchdog: [concern] …` line in the transcript and as a card, one line with its first sentence above the prompt box.
Click the card's `▸`, or press ctrl+x tab and then its letter (`a`, `b`, `c`), to read the whole note with its
watchdog, age and state; Esc gives the focus back to the prompt. Run `/watchdog status` to see each watchdog's reviews,
notes, tokens and cost. A card names its watchdog when you run two or more.

At its right end a card shows only what needs a look: the subagent type for a note on a subagent; the state while the
note has not reached Claude yet, `nudge pending` (the plugin starts a turn so that Claude reads it), `held` or `aside`
(Claude reads it with your next prompt); nothing once it is `steered` (Claude reads it after its next tool result) or
`nudged`. When Claude edited files after the review read its update, the card says `outdated? N edits` (the open card
says `may be outdated: N edits since`), and Claude reads the same mark with the note. The next review of the same
watchdog sees the edits and the note; when the note no longer holds, it retracts it: the card goes, and a note that
waits never reaches Claude. A blocker that may be outdated and came after Claude's reply waits as `held` for that
review before it nudges, so Claude does not go after a bug it already fixed.

## What runs on your machine

- The mod runs inside Claude Code with your permissions. Its code is in `plugins/watchdog/hooks/`.
- It reads the `WATCHDOG.json` and `WATCHDOG.md` files, the session's memory files (such as `CLAUDE.md`), each update
  of the agent you work with and, when `CLAUDE_WATCHDOG` is set in a `claude -p` run, your project and local settings.
- It sends each update to the review model, as an agent that Claude Code runs on your account, and puts the notes into
  your session. `/watchdog on` also sends one 1-token request for each model, to check that it exists. Apart from these
  model requests through Claude Code, the mod makes no network calls: its code never calls `$.http.fetch` or `fetch`.
- Its only file write is the dump, under `<config>/watchdog/dumps/` (`<config>` is `$CLAUDE_CONFIG_DIR` or
  `~/.claude`). It keeps its notes and review state in Claude Code's session state and plugin store. In the terminal,
  `/watchdog dump` also copies the dump text to the clipboard.
- By default a reviewer gets `Read`, `Grep` and `Glob`. A project `WATCHDOG.json` can grant no more; only
  `<config>/WATCHDOG.json` can grant other tools and `mcp__*` tools. `Bash`, `Edit`, `Write`, `NotebookEdit`, `Agent`,
  `SendMessage`, `AskUserQuestion` and `ToolSearch` are always refused. A reviewer never asks you for a permission.
- The mod allows its own review spawn (the `Agent` call of a `watchdog:*` type) when Claude Code would ask, so no
  dialog or Auto-mode classifier sees it. A permission rule that denies `Agent` still wins.

## Cost and off switch

- Each review is one more agent, on `opus` with `medium` effort by default (in the demo: 3 reviews, 37.2k tokens,
  $0.07). The built-in "You should know" mod, when on, runs its own side agent too; turn it off in `/plugin` to pay
  for one only.
- `/watchdog off` stops reviews for this session. `/plugin uninstall watchdog@matteoantoci` removes the plugin.
- Settings, in `/plugin` (Installed, Watchdog, Configure options) or `/config`: `onByDefault` (default `false`) turns
  reviews on in each new interactive session. `immuneTurns` (0 to 5, default `3`) is the number of turns after a nudge
  before the next nudge for a concern; a nudge is a turn that the plugin starts so that Claude reads a note that came
  after its reply.
- Each nudge is one more turn of Claude. After each of your prompts the plugin sends at most 1 nudge for concerns and
  2 for blockers (a concern that comes with a blocker rides along); a later note waits for your next prompt.
  `/watchdog status` shows both counts, for example `nudge 1/1 · blocker 0/2`.

## Commands

- `/watchdog` or `/watchdog status`: each watchdog's state, reviews, notes, tokens and cost, and the session totals.
  For a state such as `halted`, see [docs/failures.md](docs/failures.md).
- `/watchdog on` and `/watchdog off`: turn reviews on or off for this session.
- `/watchdog dump` and `/watchdog dump raw`: write the review log to a file (`raw` adds the review prompts).

## Configure

A `WATCHDOG.json` in your project or in `~/.claude` sets the watchdogs. The load order, every key and the tool grants
are in [docs/configuration.md](docs/configuration.md). This file adds a second reviewer to the default one:

```json
{ "watchdogs": [{ "name": "default" }, { "name": "security", "model": "sonnet", "effort": "high" }] }
```

## Limitations

- Notes are advice: the agent may reject one. A review runs in the background, so a note can come after the step; the
  outdated mark above counts every edit since the review, whatever file it touched.
- Reviews run only on Anthropic models. `claude -p` needs `CLAUDE_WATCHDOG=on` and has no nudge and no cards: see
  [docs/headless.md](docs/headless.md).
- The cost comes from the plugin's own price table (`plugins/watchdog/hooks/prices.ts`); a model not in it shows `$?`.

## Development

`npm install` sets up the tools and the pre-commit hook. `npm run check` runs the 6 checks of pre-commit and CI:
`rules`, `fmt:check`, `lint`, `typecheck`, `validate` and `test`. See [docs/plugin-dev.md](docs/plugin-dev.md). Before
a release and before a bump of the pinned Claude Code version, run the live probe by hand, on a real model and login:
[scripts/live-probe/README.md](scripts/live-probe/README.md).

## License

Apache-2.0
