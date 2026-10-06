# watchdog

A Claude Code plugin with a hooks module. Watchdog agents review each update of the agent you work with, each on its own
model, and push short notes to it: `nit`, `concern` or `blocker`.

## Requirements

Claude Code 2.1.290 or later. The npm `stable` channel (2.1.285 on 2026-10-06) has no mods. Below 2.1.290 the plugin
shows `unsupported`. Desktop support starts when Claude.app bundles Claude Code 2.1.290 or later.

## Install

```
/plugin marketplace add matteoantoci/claude-code-watchdog
/plugin install watchdog@matteoantoci
```

## Use

- `/watchdog` or `/watchdog status`: a short status.
- `/watchdog on` and `/watchdog off`: turn reviews on or off for this session.
- `/watchdog dump` and `/watchdog dump raw`: write the review log to a file.

## Headless runs

```
CLAUDE_WATCHDOG=on claude -p "…"
```

- Set `CLAUDE_WATCHDOG` for one run, not in a shell profile. `on` and `1` turn the run on; another value leaves it
  off with a warning in the dump. The plugin unsets the variable at start, so no Bash command and no nested
  `claude -p` gets it.
- `-p` has no nudge and no cards: a late note waits as an aside for the next prompt, and what is left at the end
  (waiting notes, `unreviewed: N updates` records) goes to the dump file
  `~/.claude/watchdog/dumps/<sessionId>-<time>.md` (under `$CLAUDE_CONFIG_DIR` when set).
- `onByDefault` does not apply to `-p`.
- A project `env` setting (`.claude/settings.json` or `.claude/settings.local.json`) is ignored: the run stays off.
  The shell, the user settings, `--settings` and managed settings can set it.
- `total_cost_usd` can leave out the review cost.
- `claude -p "/watchdog on <prompt>"` does not work: the command turns on, but the model never sees the prompt.

## Configure the watchdogs

Without a config file, one watchdog named `default` reviews on `opus` with `medium` effort. A `WATCHDOG.json` file
sets the roster:

```json
{
  "instructions": "Shared guidance for every watchdog.",
  "maxNotesPerReview": 4,
  "watchdogs": [
    { "name": "security", "model": "sonnet", "effort": "high", "tools": ["Read", "Grep", "Glob"] },
    { "name": "tests", "reviewMode": "agent-end", "reviewInterval": 2 }
  ]
}
```

- Files load in this order: `~/.claude/WATCHDOG.json` (or `$CLAUDE_CONFIG_DIR/WATCHDOG.json`), then for each folder
  from the git root down to the working folder, `.claude/WATCHDOG.json` and `WATCHDOG.json`. Outside git, only the
  session root's two files load.
- The roster is the union of all files; an entry with the same name replaces the earlier one. `"watchdogs": []` with
  no other entries gives zero watchdogs. `"enabled": false` pauses a watchdog.
- Entry keys: `name` (required), `enabled`, `model` (`<provider>/<id>[:level]`, only `anthropic`), `effort` (`low`,
  `medium`, `high`, `xhigh`, `max` or `auto` for the session's effort), `tools`, `reviewMode` (`turn` or
  `agent-end`), `reviewInterval`, `maxNotesPerReview` (1 to 32), `instructions`.
- A project file grants only `Read`, `Grep` and `Glob`; the user file also grants other Claude Code tools and
  `mcp__<server>__<tool>` tools. `Bash`, `Edit`, `Write`, `NotebookEdit`, `Agent`, `SendMessage`, `AskUserQuestion`
  and `ToolSearch` are always refused.
- The files are read at `/watchdog on`. After an edit, run `/watchdog off`, then `/watchdog on`. `/watchdog status`
  lists each warning about the files and says "config changed" after an edit.

## Development

`npm install` sets up the tools and the pre-commit hook. `npm run check` runs the 5 checks that pre-commit and CI run.

## License

Apache-2.0
