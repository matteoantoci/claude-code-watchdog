// The person prompt typed in the terminal, as the engine raised it (spec §10). Recorded by the live probe on
// 2.1.290: run verify-fixes, scenario tui-review. Source: the observer records `prompt.submit` and
// `session.append` in logs/observer-*.jsonl; `role` comes from the session transcript. Scrubbed: the row uuid.
import type { PromptSubmitInput, SessionAppendInput } from 'claude-code';

const TEXT =
  'Use the Read tool to read math.js, then read a.txt, one tool call at a time. Then tell me in one line what add(2, 3) returns.';

// The submit of the prompt. The observer does not log `wait`: false is the d.ts value for a plain Enter. It logs
// no `context` (the d.ts: absent as the engine raises it).
export const COMPOSER_SUBMIT = { text: TEXT, wait: false, origin: { kind: 'composer' } } satisfies PromptSubmitInput;

// The row of the prompt, which the engine appends while the submit runs.
export const COMPOSER_PROMPT_ROW = {
  uuid: 'c0000000-0000-4000-8000-000000000001',
  door: 'prompt',
  origin: { kind: 'composer' },
  message: { type: 'user', role: 'user', content: [{ type: 'text', text: TEXT }] },
} satisfies SessionAppendInput;
