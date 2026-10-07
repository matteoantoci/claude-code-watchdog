# Coding standards

Judgement rules for a review of the `watchdog` plugin. `npm run check` enforces format, lint, types, `validate` and the tests; these rules cover what no check sees. Apply every rule to every changed file. How the code is built: `docs/plugin-dev.md`.

## Contract rules

1. **Recorded engine input.** An L2 input that the engine produces (a `session.append` row, a `prompt.submit` origin, a `CommandOutput` reply, a model reject) comes from a recorded engine fixture in `plugins/watchdog/tests/fixtures/engine/`. A hand-typed shape tests the mod against a guess. Four live bugs passed hand-typed tests: the `-p` prompt origin `unclassified`, the engine's echo of the mod's own `$.ui.log` row, the plugin-name prefix on a command reply, and an alias reject under `availableModels`.
2. **One concept, one constant.** Each set, table, label list or limit has one definition. A second copy elsewhere is a defect, even when the values agree today. Import the first one (examples: the person-prompt origins in `hooks/person.ts`, the delivery states in `note/notes.ts`, the numbers in `hooks/constants.ts`).
3. **Restore at load.** Module memory that mirrors a `$.state` key is read back at load, in a `session.start` hook. A hot reload resets module variables and keeps `$.state`; without the restore, the status and the hooks see zeros after a `/config` change.
4. **Time from `$.clock`.** Hook code reads the time only from `$.clock`. `scripts/check-plugin-rules.mjs` fails on `Date.now()` and `new Date()` in `hooks/`. Check also that a time compared with another time came from the same clock, and that a test of a time rule drives `mock.clock`.

## State

- **Bounded.** Each value in `$.state`, `$.store` and module memory has a cap, or a reset at a named event. A map that grows for the whole session and carries over `/clear` and `/branch` is a defect.
- **Every session change named.** For each piece of module memory and each `$.state` key, the code states what happens at a hot reload, at `/clear`, `/resume`, `/branch`, and at `/watchdog off`: carried, reset, or restored.
- **Caps keep what counts.** A capped list keeps the records the person reads. Noise records (a run of errors, a cap hit) do not push them out.
- **Counters stay in range.** A budget or counter is clamped at its bounds on every path, the failure paths too. A status that shows `nudge -1/1` is a defect.

## Hooks and modules

- **`$` stays in `install.ts`.** Pure modules take data and return data. Logic that does not need `$` moves out of the install file.
- **One path for each outcome.** A note dropped, a review stopped, a backlog moved: each has one function that does it. Two paths drift apart.
- **The mod's own output.** A hook that reads engine rows or events handles the mod's own echoes: its spawns, its tool calls, its `$.ui.log` rows, its prompts. The watchdog never reviews itself.
- **Rejects have a stated outcome.** Each `.catch` matches the spec: a reject the spec shows (last error, a log row) shows there. A silent `.catch(() => undefined)` needs a spec rule that the failure changes nothing.
- **Gating hooks fail closed only for the mod.** A `.catch` on a guard or a check denies only the watchdog's own calls (`next.origin.plugin`, a watchdog `agentId`), and passes every other call on with `next(e)`. A failed watchdog hook never blocks the person's work.
- **Spec references.** A comment on a rule cites its spec § (or the build-session choice). A rule with no § is a question for the person.
- **Names.** Use the terms of `GLOSSARY.md`. Name a function by its contract, not by its caller.

## Tests

- **A fix brings its test.** A behavior fix adds a test that fails when the fix is reverted. Revert the fix and run the test to confirm it.
- **Assert on effects.** A test asserts on what the mod returned, wrote, logged or spawned. The kit skips a hook with no stub and says so only when a test fails, so "nothing threw" proves nothing.
- **Each layer tests its own part.** L1 covers the pure rules in full. L2 covers one path through each hook, with the fixtures of `tests/fixtures/`.
- **Every branch the spec names.** A spec section with several cases (a session change, a failure class, a surface) has a test for each case the code branches on.

## Lint

- **No escape hatch.** No `oxlint-disable` comment and no override in `.oxlintrc.json` (spec §2). A file at `max-lines` splits by the ways in `docs/plugin-dev.md`.
