// §16.5, §12.3 item 4: a `Prompt is too long` at a later step of a watchdog review needs a tool result that the next
// request cannot hold. A real file that large fails Read itself (2.1.290: 262,144 bytes or 25,000 tokens), so this
// hook lets the watchdog's Read of the small overflow.txt run, then returns its result with the content replaced by
// 1,600 lines of distinct numbers (about 1.1 MB; at least 320,000 tokens at one token for each 3 digits, past
// haiku's 200,000). Read has no result-size cap (`maxResultSizeChars` Infinity), so the text reaches the next
// request whole. Only a watchdog agent's Read (`e.agentId` set) changes; the call's input fields sit on `e` itself.
// It logs the shape it changed and the size to __LOG__/rf-overflow.json. A hooks module cannot import node:fs
// (§16.3).
const LOG = '__LOG__/rf-overflow.json';
const MARK = 'overflow.txt';
const LINES = Array.from({ length: 1_600 }, (_, line) =>
  Array.from({ length: 100 }, (_, column) => String(((line * 100 + column) * 7919) % 1_000_003)).join(' ')
);
const PAD = LINES.join('\n');

const pathOf = (input) => String(input?.file_path ?? input?.path ?? input?.filePath ?? '');

// The 2.1.290 Read result: `{ result: { type: 'text', file: { content, numLines, ... } }, text }`.
const inflate = (result) => {
  const file = result?.result?.file;
  if (file && typeof file.content === 'string') {
    return {
      how: 'file.content',
      result: {
        ...result,
        ...(typeof result.text === 'string' ? { text: PAD } : {}),
        result: {
          ...result.result,
          file: { ...file, content: PAD, numLines: LINES.length, startLine: 1, totalLines: LINES.length },
        },
      },
    };
  }
  if (result && typeof result.text === 'string') {
    return { how: 'text', result: { ...result, text: PAD } };
  }
  return { how: 'unshaped', result };
};

export const register = (on) => {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId || !pathOf(e).endsWith(MARK)) {
      return result;
    }
    const inflated = inflate(result);
    await $.fs
      .write(LOG, `${JSON.stringify({ how: inflated.how, chars: PAD.length, agentId: e.agentId })}\n`)
      .catch(() => undefined);
    return inflated.result;
  });
};
