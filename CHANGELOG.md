# Changelog

## Unreleased

- The plugin moved to the `matteoantoci-plugins` marketplace (`matteoantoci/claude-plugins`). The `matteoantoci`
  marketplace in this repo is gone. To move: `/plugin marketplace remove matteoantoci`, then
  `/plugin marketplace add matteoantoci/claude-plugins` and `/plugin install watchdog@matteoantoci-plugins`. Plugin
  options are stored per plugin id, so set `onByDefault` and `immuneTurns` again in `/plugin` (or pass
  `--config onByDefault=true` to `claude plugin install`).

## 0.2.0 - 2026-10-08

- Compact band: each card is one row with the note's first sentence and a dim status that shows only what waits. Click
  a card's `▸`, or press ctrl+x tab and its letter, to open the whole note. Esc gives the focus back to the prompt.
- Outdated mark: when Claude edited files after a review, the card says `outdated? N edits` and Claude reads the same
  mark with the note.
- Retraction: the next review of the same watchdog retracts a note that no longer holds. The card goes, and a note that
  waits never reaches Claude.
- Blocker nudges: blockers get 2 nudges of their own after each of your prompts, beside the 1 for concerns.
  `/watchdog status` shows both counts. A late blocker that may be outdated waits as `held` for the next review.
- Auto mode: the plugin allows its own review spawn when Claude Code would ask, so the Auto-mode classifier never sees
  it. If the classifier still refuses a spawn, the state is `blocked · auto mode`, with a hint and no failure count.
- CI runs on pull requests, plus a weekly check on the latest Claude Code.

## 0.1.0

- First release: watchdog agents review each update of the agent you work with and push `nit`, `concern` and
  `blocker` notes to it. Commands `/watchdog on`, `off`, `status` and `dump`, and a `WATCHDOG.json` to set the
  watchdogs.
