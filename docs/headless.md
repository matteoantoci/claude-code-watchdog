# Headless runs

A headless run has no person at the prompt box: `claude -p` or an Agent SDK session. Turn it on before it starts:

```
CLAUDE_WATCHDOG=on claude -p "…"
```

Three words from interactive sessions, used below:

- A **nudge** is a new turn that the plugin starts after the agent stopped, so that the agent reads a note that came
  after its reply.
- The **cards** are the notes that the plugin draws in the band above the prompt box.
- An **aside** is a note that waits and reaches the agent with your next prompt.

The rules of a headless run:

- Set `CLAUDE_WATCHDOG` for one run, not in a shell profile. `on` and `1` turn the run on; another value leaves it off
  with a warning in the dump. The plugin unsets the variable at start, so no Bash command and no nested `claude -p`
  gets it.
- `-p` has no nudge and no cards: a late note waits as an aside for the next prompt, and what is left at the end
  (waiting notes, `unreviewed: N updates` records) goes to the dump file `~/.claude/watchdog/dumps/<sessionId>-<time>.md`
  (under `$CLAUDE_CONFIG_DIR` when set).
- `onByDefault` does not apply to `-p`.
- A project `env` setting (`.claude/settings.json` or `.claude/settings.local.json`) is ignored: the run stays off. The
  shell, the user settings, `--settings` and managed settings can set it.
- `total_cost_usd` can leave out the review cost.
- `claude -p "/watchdog on <prompt>"` does not work: `/watchdog` takes no prompt, so the run replies with the usage line
  and stays off. Use `CLAUDE_WATCHDOG=on` instead.
