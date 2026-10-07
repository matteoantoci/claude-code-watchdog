// §14.3: the feed replay of `/resume` and `/branch`. Pure: the session area's hook reads the conversation.
import { currentTurn } from '../delivery/turns';
import { closeUpdate, recordRow } from '../feed/feed';
import { textOf } from '../feed/text';
import { personPrompts } from '../review/recap';
import type { Feed } from '../feed/feed';
import type { ApiContentBlock, ApiMessage, SessionAppendInput } from 'claude-code';

// §14.3: the line before the replayed rows.
export const REPLAY_MARKER = '[earlier history, before the watchdog started]';

type RowHead = Pick<SessionAppendInput, 'uuid' | 'door' | 'origin'>;

const userRow = (head: RowHead, content: ApiContentBlock[]): SessionAppendInput => ({
  ...head,
  message: { type: 'user', role: 'user', content },
});

// The tool of each call in the conversation, by the call's id: a tool result names only the id.
const toolNames = (messages: readonly ApiMessage[]): ReadonlyMap<string, string> =>
  new Map(
    messages.flatMap((message) =>
      message.content.flatMap((block) => (block.type === 'tool_use' ? [[textOf(block.id), textOf(block.name)]] : []))
    )
  );

// §7.3: the watchdog's own notes (a steer, an aside, a nudge) never enter a feed; neither does an empty text.
const isReplayed = (block: ApiContentBlock): boolean =>
  block.type !== 'tool_result' &&
  (block.type !== 'text' || (textOf(block.text).trim() !== '' && !textOf(block.text).includes('<watchdog-notes>')));

// One message after the prompt as the `session.append` rows the live feed got: a response; each tool result with
// its tool; the rest of a user message as one line, whose origin the API form does not keep.
const rowsOf = (message: ApiMessage, uuid: string, tools: ReadonlyMap<string, string>): SessionAppendInput[] => {
  if (message.role === 'assistant') {
    const response: SessionAppendInput['message'] = {
      type: 'assistant',
      role: 'assistant',
      content: [...message.content],
    };
    return [{ uuid, door: 'response', origin: { kind: 'model', model: 'replay' }, message: response }];
  }
  const results = message.content.filter((block) => block.type === 'tool_result');
  const rest = message.content.filter(isReplayed);
  return [
    ...results.map((block, n) => {
      const tool = tools.get(textOf(block.tool_use_id)) ?? 'unknown';
      return userRow({ uuid: `${uuid}:${n}`, door: 'tool-result', origin: { kind: 'tool', tool } }, [block]);
    }),
    ...(rest.length === 0
      ? []
      : [userRow({ uuid: `${uuid}:rest`, door: 'prompt', origin: { kind: 'unclassified' } }, rest)]),
  ];
};

// §14.3, §7.6: the new session's conversation from its last person prompt to the end enters the feed as one
// closed update, after the marker, rendered and capped as live rows; the next review takes it. `prefix` keeps
// the uuids apart from the live rows. No person prompt, no replay.
export const replayFeed = (feed: Feed, messages: readonly ApiMessage[], prefix: string): Feed => {
  const prompt = personPrompts(messages).at(-1);
  if (prompt === undefined) {
    return feed;
  }
  const tools = toolNames(messages);
  const rows = [
    userRow({ uuid: `${prefix}:${prompt.index}`, door: 'prompt', origin: { kind: 'composer' } }, [
      { type: 'text', text: prompt.text },
    ]),
    ...messages
      .slice(prompt.index + 1)
      .flatMap((message, n) => rowsOf(message, `${prefix}:${prompt.index + 1 + n}`, tools)),
  ];
  const marked: Feed = { ...feed, rows: [...feed.rows, { uuid: `${prefix}:marker`, text: REPLAY_MARKER }] };
  return closeUpdate(rows.reduce(recordRow, marked), 'turn', currentTurn());
};
