import { RECAP_PROMPTS_CAP, RECAP_UPDATES_CAP } from '../constants';
import { contentText, primaryArg, resultStatus, textOf } from '../feed/text';
import type { ApiContentBlock, ApiMessage } from 'claude-code';

// §7.7: parts 2 and 3 come from the main conversation in Messages API form (`$.session.messages({ as: "api" })`,
// newest 4096 messages), because the feed drops reviewed rows. `prompts` is the count of person prompts
// since `/watchdog on`; `skip` holds the tool calls of the new updates, which part 4 shows.
export type RecapSource = {
  readonly messages: readonly ApiMessage[];
  readonly prompts: number;
  readonly skip: ReadonlySet<string>;
};

const SEPARATOR = '\n\n';

// §7.7 part 2: a user text block that the engine or a plugin wrote, not the person: a tag block
// (`<system-reminder>`, `<task-notification>`, `<watchdog-notes>`, `<command-name>`, `<bash-input>`, …),
// an Esc line, the local-command caveat, a plugin's prompt frame, a compaction summary. [INFERENCE] The API
// form keeps no origin, so the text tells them apart.
const NOT_TYPED: readonly RegExp[] = [
  /^<[a-z][\w-]*[\s>]/u,
  /^\[Request interrupted by user/u,
  /^Caveat: /u,
  /^The \S+ plugin sent a message:/u,
  /^This session is being continued from a previous conversation/u,
];

const typedTexts = (message: ApiMessage): string[] =>
  message.role === 'user'
    ? message.content.flatMap((block) => {
        const text = block.type === 'text' ? textOf(block.text) : '';
        return text.trim() === '' || NOT_TYPED.some((pattern) => pattern.test(text.trimStart())) ? [] : [text];
      })
    : [];

type Prompt = { readonly index: number; readonly text: string };

const personPrompts = (messages: readonly ApiMessage[]): Prompt[] =>
  messages.flatMap((message, index) => {
    const texts = typedTexts(message);
    return texts.length === 0 ? [] : [{ index, text: texts.join('\n') }];
  });

// The person prompts since the watchdog started, and the message index where that is: the oldest of them,
// else the turn that runs (the watchdog started after its prompt).
const sinceStart = (source: RecapSource): { readonly prompts: readonly Prompt[]; readonly start: number } => {
  const all = personPrompts(source.messages);
  const prompts = all.slice(Math.max(all.length - source.prompts, 0));
  return { prompts, start: prompts[0]?.index ?? (all.at(-1)?.index ?? -1) + 1 };
};

// §7.7: entries newest first while they fit the cap (the newest one always), then the count of the rest.
const fitNewest = (entries: readonly string[], cap: number, noun: string): string => {
  const newest = entries.toReversed();
  const ends = newest.reduce<number[]>((totals, entry) => {
    totals.push((totals.at(-1) ?? -SEPARATOR.length) + SEPARATOR.length + entry.length);
    return totals;
  }, []);
  const over = ends.findIndex((end, index) => index > 0 && end > cap);
  const kept = over === -1 ? newest : newest.slice(0, over);
  const omitted = entries.length - kept.length;
  return [...kept, ...(omitted > 0 ? [`[${omitted} earlier ${noun} omitted]`] : [])].join(SEPARATOR);
};

// §7.7 part 2: the person's prompts since the watchdog started, in full, up to 20,000 chars.
export const recapPrompts = (source: RecapSource): string =>
  fitNewest(
    sinceStart(source).prompts.map((prompt) => `**user**:\n${prompt.text}`),
    RECAP_PROMPTS_CAP,
    'prompts'
  );

const resultsById = (messages: readonly ApiMessage[]): ReadonlyMap<string, ApiContentBlock> =>
  new Map(
    messages.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === 'tool_result' ? [[textOf(block.tool_use_id), block] as const] : []
      )
    )
  );

// omp's one-line tool call: `→ name(primary argument) ⇒ status`; a server tool call has no status.
const callLine = (block: ApiContentBlock, results: ReadonlyMap<string, ApiContentBlock>): string => {
  const name = textOf(block.name);
  const result = results.get(textOf(block.id));
  const head = `→ ${name}(${primaryArg(name, block.input)})`;
  if (block.type === 'server_tool_use') {
    return head;
  }
  return result === undefined
    ? `${head} ⇒ pending`
    : `${head} ⇒ ${resultStatus(contentText(result.content), result.is_error === true)}`;
};

const isCall = (block: ApiContentBlock, skip: ReadonlySet<string>): boolean =>
  (block.type === 'tool_use' || block.type === 'server_tool_use') && !skip.has(textOf(block.id));

// §7.7 part 3: the older updates since the watchdog started, one line for each tool call, one entry for
// each model response, up to 30,000 chars.
export const recapUpdates = (source: RecapSource): string => {
  const results = resultsById(source.messages);
  const entries = source.messages.slice(sinceStart(source).start).flatMap((message) => {
    const calls = message.role === 'assistant' ? message.content.filter((block) => isCall(block, source.skip)) : [];
    return calls.length === 0 ? [] : [calls.map((block) => callLine(block, results)).join('\n')];
  });
  return fitNewest(entries, RECAP_UPDATES_CAP, 'updates');
};
