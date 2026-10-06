# Only the person decides if reviews run; the project decides which reviews run

A setting goes in plugin `userConfig` if it decides whether reviews run (`onByDefault`), or if it sets the nudge cooldown (`immuneTurns`). Only user settings or managed settings can set `userConfig`, so a cloned repo cannot start paid reviews or add main turns through nudges. A setting that shapes the reviews goes in `WATCHDOG.json`, and a project can set it: the watchdogs and their models, `subagents`, `instructions` and `maxNotesPerReview`. The roster is project knowledge, and omp reads it from project files too.

## Consequences

- The guarantee is small. When the person turns a session on, a project file can add watchdogs, choose their models, and opt in subagents. Each of these changes adds cost. To show this risk, `/watchdog status` shows the cost of each watchdog and the file that added it.
- A project cannot make the watchdog on by default. A team that wants this must use managed settings.
- A project `env` setting cannot turn on a headless run. The mod ignores `CLAUDE_WATCHDOG` when project or local settings set it ([How does a headless `-p` run turn the watchdog on?](../../.scratch/claude-code-watchdog/issues/30-headless-route.md), [Which prompt origins count as a prompt from the person?](../../.scratch/claude-code-watchdog/issues/33-person-prompt-origins.md)).
- A project can grant a watchdog only `Read`, `Grep` and `Glob`. Each other tool, for example `WebFetch` or an `mcp__*` tool, comes only from the user file, because a call from a hidden watchdog agent shows in no transcript row ([What may a project `WATCHDOG.json` grant?](../../.scratch/claude-code-watchdog/issues/34-project-roster-trust.md)).
- A `userConfig` change reloads the mod, so a runtime toggle (`/watchdog on|off`) must never write `userConfig`.

## Considered Options

- All settings in `WATCHDOG.json`: rejected, because a project could turn on reviews for each person who clones it.
- All settings in `userConfig`: rejected, because a project could not have a roster, and `userConfig` cannot hold a list of objects.
