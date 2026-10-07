// The person prompt of a `claude -p` run, as the engine raised it (spec §5.3, §10). Recorded by the live probe on
// 2.1.290: run verify-fixes, scenario headless-review (check l3-headless-prompt), `claude -p` with
// CLAUDE_WATCHDOG=on. Source: the observer records `prompt.submit` and `session.append` in
// logs/observer-*.jsonl; `role` comes from the session transcript. Scrubbed: the row uuid.
import type { PromptSubmitInput, SessionAppendInput } from 'claude-code';

const TEXT =
  'Use the Read tool to read math.js, then read a.txt, one tool call at a time. Then tell me in one line what add(2, 3) returns.';

// The submit of the prompt. The observer does not log `wait`: false is the d.ts value for a prompt that the
// person did not queue. It logs no `context` (the d.ts: absent as the engine raises it).
export const HEADLESS_SUBMIT = { text: TEXT, wait: false, origin: { kind: 'sdk' } } satisfies PromptSubmitInput;

// The row of the prompt, which the engine appends while the submit runs. Its origin is `unclassified`, though the
// submit's origin is `sdk`.
export const HEADLESS_PROMPT_ROW = {
  uuid: 'd0000000-0000-4000-8000-000000000001',
  door: 'prompt',
  origin: { kind: 'unclassified' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] },
} satisfies SessionAppendInput;
