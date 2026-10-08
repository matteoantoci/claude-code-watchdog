# Plugin development

How the `watchdog` mod in `plugins/watchdog/` is built and tested. The rules come from the spec (`.scratch/claude-code-watchdog/spec.md`, §2 code rules, §16 testing). The facts were checked on Claude Code 2.1.290.

## The hooks module

- `hooks/register.ts` calls one `installX(on)` for each area, and does nothing else.
- The install order is the hook order. Of two `on()` of one event, the one registered first runs first, and its `next(e)` reaches the later one.
- `hooks/<area>/install.ts` holds the area's hooks and every `$` call of the area. The other files of the area are pure: data in, data out, no `$`.
- `$` goes only to a function in the same file. `claude plugin validate` refuses `$` passed to an imported function. It also wants the parameter spelled `$`.
- A helper that takes `$` types it as `EngineInterface` from `claude-code`. A hook is a typed const: `const onX: Hook<'session.start'> = async ($, e, next) => …`.
- A `turn.step` hook is an `async function*`. It relays with `yield* next(e)`.
- Each event has at most one `on()` with no matcher in the whole module. Every other `on()` of that event needs a matcher. `{ turnId: /^/u }` matches every event that has the field. Two areas may use the same matcher.
- Write each event name, each `$.state` key and each `$.env` name as a literal.
- Each number goes in `hooks/constants.ts`, with the spec § that uses it in a comment.
- Time comes only from `$.clock`. `npm run rules` (`scripts/check-plugin-rules.mjs`) fails on `Date.now()` and `new Date()` in `hooks/`.
- `.claude-plugin/types/` is written by the engine each time it loads the mod from this folder (for example `claude --plugin-dir plugins/watchdog`). It holds its own `*` `.gitignore`, so commit it with `git add -f` after a Claude Code bump.

## Add an area

1. Write `hooks/<area>/install.ts`:

   ```ts
   export const installX = (on: OnEvents<'turn.step' | 'turn.complete'>): void => {
     on('turn.complete', { turnId: /^/u }, onComplete);
   };
   ```

   `OnEvents` comes from `hooks/on.ts`. List exactly the events the file hooks.

2. Add one import and one `installX(on)` call to `register.ts`. Place the call where its hooks must run in the chain.
3. Hook an event that another area already hooks with a matcher.

An area plugs into another area's work through the registries, called once in its `installX(on)`. They run in install order:

| Registry                        | File                | What it adds                                                                                                   |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `addStatusHead(parts)`          | `command/status.ts` | parts of the first `/watchdog status` line (`watchdog on · nudge 1/1 · blocker 0/2`)                           |
| `addStatusLines(lines, place?)` | `command/status.ts` | status lines; `place` is `line` (default), `watchdogs` or `error`                                              |
| `addDumpLines(lines)`           | `dump/sections.ts`  | lines of `/watchdog dump`                                                                                      |
| `addNoteGuard(guard)`           | `note/notes.ts`     | a note check after the destructive check, before the emission guard; the first ack it returns drops the note   |
| `addDeliveryRoute(route)`       | `note/notes.ts`     | a delivery state for an admitted note; the first route that claims it wins, else `held`                        |
| `addNoteBinding(binding)`       | `note/notes.ts`     | marks a held note that waits for a subagent's own tool result                                                  |
| `watchHeldNotes(watcher)`       | `note/notes.ts`     | sees each note that the held list gets or changes, and each note a delivery takes, in the state it goes out in |

## Add a status line

Call `addStatusLines(() => [...lines])` in the area's `installX(on)`. Return `[]` for no line. The callback reads the area's module memory, so the hooks of the area must keep that memory current. Lines placed at `watchdogs` are the text form of rows that the status table (`status/`) draws itself.

## Add a tool of the review agents

1. Add its `ToolSpec` to `WATCHDOG_TOOLS` in `note/tool.ts`. `lifecycle/install.ts` registers the list at `session.start`, and `command/install.ts` again at `/watchdog on`. `WATCHDOG_TOOL_NAMES` (`agents/spec.ts`) derives each `mcp__watchdog__<name>`: each watchdog's agent gets them, the tool guard lets them through, and the roster leaves them out of a `tools` list.
2. Serve the tool with a `tool.call` hook whose matcher names it as a literal, as `note/install.ts` does for `mcp__watchdog__note` and `mcp__watchdog__resolve`. The hook answers `{ result }` or `{ deny }` without `next(e)`, catches every error, and chains the same `.catch`.
3. Add a line about it to `prompts/system.md`, and update the tool list of the tests that register it (`on-off`, `command`, `roster`).

## Add a `$.state` key

1. Add one property inside `interface PluginState { watchdog: { … } }` in `types/index.d.ts`. `validate` sees only keys written there, not keys reached through an alias.
2. Put the value type in the same file as an exported top-level type. The file has no import.
3. A hook module names the type as `PluginState['watchdog']['<key>']`.
4. Write the key as a literal at each `$.state.get` and `$.state.set` call.

Facts about the value:

- It is JSON. Never `undefined`. A `Set` turns into `{}`: store an array.
- `$.state` has no delete. Write `null` for a gone entry.
- A value over 4,194,304 characters of JSON makes `$.state.set` reject. Give each growing value a cap.
- One entry for each agent: a `StateFamily<T>` key, read and written with `id`.
- `$.state.set` is refused inside `ui.render`. A `$.state.get` there subscribes the render to the key.
- `$.state` survives a hot reload; module variables do not. Module memory that mirrors a key comes back in a `session.start` hook (`session/install.ts`, `tools/install.ts`).
- `/clear`, `/resume` and `/branch` start an empty `$.state`. `session/change.ts` decides what carries over.

## L1 tests

`tests/<topic>.test.ts` imports a pure module by an extensionless relative path (`../hooks/feed/feed`) and `{ describe, expect, test }` from `claude-code/testing`.

## L2 tests

Start from a fixture in `tests/fixtures/`. Each one stubs a whole slice of the engine and returns what it saw:

| Fixture                                                  | Stubs                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `stubSession` (`session.ts`)                             | every `$` call and engine event of a watched session                                               |
| `stubDelivery` (`delivery.ts`)                           | `stubSession`, plus `mock.clock` at `NOW`, `prompt.submit` and `turn.start`                        |
| `stubState`, `stubOnState` (`on-state.ts`)               | `$.state`, with a seed for a reload                                                                |
| `stubRender` (`status.ts`), `stubEngineBand` (`band.ts`) | `ui.render` and the engine's own tree                                                              |
| `stubSwitch` (`switch.ts`)                               | the engine beneath `/clear`, `/resume` and `/branch`: `session.end` on the old id, then the new id |

Rules:

- Type the body: `test(name, async ($, on: Stubs) => …)` with `type Stubs = OnEvents<…every event the test stubs…>`. A helper that stubs takes a typed `on` too.
- Register every stub before the first `$` call. The mod loads at that call.
- Each `$` call the mod makes needs a stub that returns `{ value }` or `{ deny }`. Each event the test fires needs a stub that returns the event's result. Without one, the kit skips the mod's hook.
- A skipped hook shows only when a test fails. Assert on what the mod returned, wrote or logged. A test that only checks that nothing threw proves nothing.
- The kit does not fire `session.start`. Call `$.session.start(START)` (`startReview` in `delivery.ts` does it).
- `$.command.run` takes the whole `CommandRunInput`. Use `typed(args)` from `fixtures/session.ts`. The runner does not type-check, so only `tsc` catches a missing `origin` or `presentation`.
- `$.turn.step` returns a stream. Drain it with `for await`, then `await stream.result`.
- An input that the engine produces comes from a recorded engine fixture: `import { HEADLESS_SUBMIT } from './fixtures/engine/headless-prompt'`. Each file's header names its probe run. `fixtures/recorded.ts` re-keys a recorded row. To record a new one, run the live probe and copy the observer record from `runs/<scenario>/logs/observer-*.jsonl`. Swap personal paths and ids for the `fixtures/session.ts` values.
- To test a reload, seed `$.state` through `stubState(on, { values })` and fire `$.session.start`.
- Tests may pass `$` to imported helpers (type `Engine` from `claude-code/testing`). Only the hooks module is held to the same-file rule.

### Stubs of one event

- Each event takes one stub with no matcher. The fixtures already hold it. A second one fails the load: `on("ui.log") registered twice`.
- A test's own stub of that event carries a matcher and calls `next(e)`.
- Register it before the fixture call. Stubs run in registration order, and a stub that answers without `next(e)` hides every stub after it.

### Kit limits (spec §16.2)

- The mod's own `$.agent.spawn` resolves with no `agentId`, and the mod's `agent.spawn` hook sees the Agent tool shape (`subagent_type`). Teach the id by firing the whole `AgentSpawnInput` (`REVIEW_SPAWN` in `delivery.ts`).
- A fake `turn.complete` sets `usage.model` to the roster model (`USAGE` in `session.ts`). Else §12.2 puts the review in `no_model`.
- The kit's `$.session.append` changed between releases: 2.1.290 rejects every call (the mod's own and a test's, after the mod's hooks saw the row); 2.1.293 accepts it. Catch a test's append. A test that needs a refused append stubs `session.append` to return `{ deny }` (see `tests/steer.test.ts`).
- The kit stamps no `origin` and no `wait` on `prompt.submit`. Give both.
- A `ui.render` stub returns a tree element, not a string: `$.ui.resolve(e).Text({ children: '…' })`.
- `find({ key })` works only on an element that takes `key`: put `key` on a `Box`. Find a `Text` by its text.
- The kit draws `AbovePrompt` on `vscode` and `mobile` too. Mount it only on `terminal` and `desktop` (`BAND_SURFACES`).
- A test has 5000 ms unless it sets `timeoutMs`. It has no fs, network, process or model.

## Lint traps

- **Slow lint.** A call through the full `On` type costs `typescript/no-misused-promises` about 26 s of CPU per file. Call `on(...)` only through an `OnEvents<E>` type. A test body's `on` defaults to `On`, so type it. When lint takes more than a few seconds, look for an untyped `on`.
- **`max-lines` 250.** It counts every non-blank line, comments too. Tests and `.d.ts` files are exempt. The large install files sit near the cap. When one hits it, split it:
  - Move `$`-free logic into a pure file of the area (`review/status.ts`, `review/slots.ts`).
  - Give the work its own `on()` in the area that owns it. `dump/` and `status/` answer their `/watchdog` subcommands in their own `command.run` hooks, and pass the rest on with `next(e)`.
  - Plug into a registry (see "Add an area") instead of growing the owner's install file.
  - Start a new area when the work has its own hooks and state.
- **No escape hatch.** Fix the code: no `oxlint-disable` comment, and no override in `.oxlintrc.json` (spec §2).
- `max-depth` 1 and `complexity` 10 want early returns and small helpers.
