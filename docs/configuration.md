# Configure the watchdogs

Without a config file, one watchdog named `default` reviews on `opus` with `medium` effort, with the tools `Read`, `Grep`
and `Glob`. A `WATCHDOG.json` file sets the roster, the list of watchdogs of a session:

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

## Where the files load from

- Files load in this order: `~/.claude/WATCHDOG.json` (or `$CLAUDE_CONFIG_DIR/WATCHDOG.json`), then for each folder
  from the git root down to the working folder, `.claude/WATCHDOG.json` and `WATCHDOG.json`. Outside git, only the
  session root's two files load.
- `WATCHDOG.md` files load from the same places, in the same order. Their text, joined, tells every watchdog what to
  look for.
- The files are read at `/watchdog on`. After an edit, run `/watchdog off`, then `/watchdog on`. `/watchdog status`
  lists each warning about the files and says "config changed" after an edit.

## Top-level keys

- `instructions`: guidance for every watchdog. The values of all files are joined.
- `maxNotesPerReview`: 1 to 32, default `4`. The last valid value wins.
- `watchdogs`: the entries. The roster is the union of all files; an entry with the same name replaces the earlier
  one. While no file has a `watchdogs` key, the `default` watchdog stays. `"watchdogs": []` with no other entries gives
  zero watchdogs.
- `subagents`: the subagents that get reviews, by subagent type. `true` sends them to every watchdog, a list of
  watchdog slugs to the listed ones only, and `false` removes a type that an earlier file set. For example
  `"subagents": { "Explore": true }`. A subagent reads its notes after a tool result, in the same turn.

## Entry keys

- `name` (required). The slug is the name in lowercase, with each run of other characters as `-`.
- `enabled`: `false` pauses the watchdog.
- `model`: an alias (`opus`, `sonnet`, `haiku`, `fable`), a full model id, or `inherit` for the session's model.
  `anthropic/` may come before it and `:<effort>` after it. Only `anthropic` works. Default `opus`.
- `effort`: `low`, `medium`, `high`, `xhigh`, `max` or `auto` for the session's effort. Default `medium`. It overrides
  the `:<effort>` of `model`.
- `tools`: see [Tool grants](#tool-grants). `[]` leaves only the watchdog's own `note` and `resolve` tools.
- `reviewMode`: `turn` (default) reviews at the end of each tool round and of each turn; `agent-end` only at the end of
  each turn.
- `reviewInterval`: review every Nth update that the review mode counts. Default `1`. The skipped updates join the
  next review.
- `maxNotesPerReview`: 1 to 32. Default: the top-level value.
- `instructions`: guidance for this watchdog only.

## Tool grants

- A project file grants only `Read`, `Grep` and `Glob`; the user file also grants other Claude Code tools and
  `mcp__<server>__<tool>` tools.
- `Bash`, `Edit`, `Write`, `NotebookEdit`, `Agent`, `SendMessage`, `AskUserQuestion` and `ToolSearch` are always
  refused.
- A watchdog never asks you for permission. A read that Claude Code would ask you about is refused, unless the agent
  you work with already read that file.
