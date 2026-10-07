// §14.4: rewind detection. Pure: the rewind area's hooks read the conversation, the stop area stops the reviews.
import { MESSAGES_READ_CAP } from '../constants';
import { fnv1a } from '../hash';
import type { Feed } from '../feed/feed';
import type { SessionMessage } from 'claude-code';

// §14.4: the line the next update starts with after a rewind.
export const REWIND_MARKER = '[user rewound the conversation]';

// §14.4: the message the last boundary saw last: its index in `$.session.messages()`, the hash of its text and
// tool-use ids (32-bit FNV-1a), and whether the list stood at the read cap.
export type Mark = { readonly index: number; readonly hash: string; readonly isCapped: boolean };

const hashOf = (message: SessionMessage): string =>
  fnv1a([message.role, message.text, ...message.toolUses.map((use) => use.tool_use_id)].join('\n')).toString();

export const markOf = (messages: readonly SessionMessage[]): Mark | undefined => {
  const last = messages.at(-1);
  return last === undefined
    ? undefined
    : { index: messages.length - 1, hash: hashOf(last), isCapped: messages.length >= MESSAGES_READ_CAP };
};

// §14.4: the message at the mark changed. At the read cap the newest 4096 slide as the conversation grows, so the
// marked message counts while any message has its hash.
export const isRewound = (mark: Mark | undefined, messages: readonly SessionMessage[]): boolean => {
  if (mark === undefined) {
    return false;
  }
  if (mark.isCapped || messages.length >= MESSAGES_READ_CAP) {
    return !messages.some((message) => hashOf(message) === mark.hash);
  }
  const at = messages[mark.index];
  return at === undefined || hashOf(at) !== mark.hash;
};

// §14.4, §14.3: the backlog resets. A restore came while no turn ran, so the rows after the last closed update
// came after it: they stay, after the marker, and the next update of each watchdog starts there.
export const rewindFeed = (feed: Feed, uuid: string): Feed => {
  const end = feed.ends.at(-1)?.uuid;
  const start = feed.rows.findIndex((row) => row.uuid === end) + 1;
  return {
    ...feed,
    rows: [{ uuid, text: REWIND_MARKER }, ...feed.rows.slice(start)],
    ends: [],
    cursors: Object.fromEntries(Object.keys(feed.cursors).map((slug) => [slug, null])),
  };
};

// §14.4, §14.5: the mark and the `turn.step` `messageCount` of the last boundary, whether a compaction came
// since, the rewinds so far (each marker row gets its own uuid), and a rewind whose reviews still run.
const memory: {
  mark: Mark | undefined;
  count: number | undefined;
  isCompacted: boolean;
  rewinds: number;
  isStopDue: boolean;
} = { mark: undefined, count: undefined, isCompacted: false, rewinds: 0, isStopDue: false };

// §14.5: a compaction keeps the session id but rewrites the conversation: the next boundary only marks it again.
export const noteCompaction = (): void => {
  memory.isCompacted = true;
};

// While off, and after a session change, there is nothing to compare: the next boundary marks the conversation.
export const forgetMark = (): void => {
  Object.assign(memory, { mark: undefined, count: undefined, isCompacted: false });
};

// §14.4: a smaller `turn.step` `messageCount` than at the last boundary is the cheap first check; it needs no read.
export const isCountDropped = (count: number | undefined): boolean =>
  !memory.isCompacted && count !== undefined && memory.count !== undefined && count < memory.count;

// §14.4: one boundary: the conversation now (none after a cheap find), and whether it is a rewind. Returns the
// marker row's uuid of a rewind, else undefined; the stop area stops the reviews with reason `rewind`. After a
// rewind the count of before no longer compares.
export const passBoundary = (
  count: number | undefined,
  messages: readonly SessionMessage[] | undefined
): string | undefined => {
  const isFound = !memory.isCompacted && (messages === undefined || isRewound(memory.mark, messages));
  Object.assign(memory, {
    mark: messages === undefined ? undefined : markOf(messages),
    count: isFound ? count : (count ?? memory.count),
    isCompacted: false,
  });
  if (!isFound) {
    return undefined;
  }
  memory.rewinds += 1;
  memory.isStopDue = true;
  return `rewind:${memory.rewinds}`;
};

// §14.4: the stop area takes a rewind at the same boundary, before the review area spawns.
export const takeRewindStop = (): boolean => {
  const isDue = memory.isStopDue;
  memory.isStopDue = false;
  return isDue;
};
