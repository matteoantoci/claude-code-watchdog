import type { LogRecord, ReviewPrompt, ReviewRecord } from '../log/log';

// §13.4: `<config>` is `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`; undefined when neither is set.
export const configDir = (claudeConfigDir: string | undefined, home: string | undefined): string | undefined => {
  if (claudeConfigDir !== undefined && claudeConfigDir !== '') {
    return claudeConfigDir;
  }
  return home === undefined || home === '' ? undefined : `${home}/.claude`;
};

const isoTime = (time: number): string => new Date(time).toISOString().replace(/\.\d+Z$/u, 'Z');

// Build-session choice: `<time>` is `YYYYMMDD-HHmmss` in UTC.
export const dumpPath = (config: string, sessionId: string, time: number): string =>
  `${config}/watchdog/dumps/${sessionId}-${isoTime(time).replace(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)Z$/u, '$1$2$3-$4$5$6')}.md`;

// Quoted text keeps any markdown of an answer or a prompt out of the dump's own structure.
const quote = (text: string): string =>
  text
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');

const notesText = (notes: ReviewRecord['notes']): string[] => [
  `- notes: ${notes.length === 0 ? 'none' : String(notes.length)}`,
  ...notes.map((note) => `  - [${note.severity}] ${note.text} (${note.delivery})`),
];

const usageText = (usage: ReviewRecord['usage']): string =>
  usage === null
    ? 'none'
    : `${usage.input_tokens} input, ${usage.output_tokens} output, ${usage.cache_read_input_tokens} cache read, ${usage.cache_creation_input_tokens} cache write`;

// §11.4: the heading of a review of a subagent also names its type and `agentId`.
const reviewText = (record: ReviewRecord): string[] => [
  [
    `### ${isoTime(record.time)} · ${record.watchdog} · review ${record.agentId}`,
    ...(record.subagent === undefined ? [] : [`subagent ${record.subagent.type} ${record.subagent.agentId}`]),
  ].join(' · '),
  `- model: ${record.model}, effort ${record.effort}`,
  `- end: ${record.reason}, ${record.steps} steps, answer ${record.answerLength} chars`,
  `- usage: ${usageText(record.usage)}`,
  `- cost: ${record.cost === null ? '$?' : `$${record.cost}`}`,
  `- error: ${record.error ?? 'none'}`,
  ...(record.reason === 'refusal' ? [`- refused: ${record.refusal ?? 'no category'}`] : []),
  ...notesText(record.notes),
  record.answer === '' ? '- answer: none' : `- answer:\n\n${quote(record.answer)}`,
];

// §13.4: one record of the review log as one markdown block.
export const recordText = (record: LogRecord): string => {
  if (record.kind === 'review') {
    return reviewText(record).join('\n');
  }
  const head = `### ${isoTime(record.time)} · ${record.watchdog}`;
  return record.kind === 'error'
    ? [`${head} · error`, `- error: ${record.error}`].join('\n')
    : `${head} · unreviewed: ${record.updates} updates`;
};

const promptsText = (prompts: readonly ReviewPrompt[]): string[] => [
  '## Prompts of the last reviews',
  ...(prompts.length === 0
    ? ['None: a reload of the plugin clears them.']
    : prompts.map((prompt) => `### ${prompt.watchdog}\n\n${quote(prompt.prompt)}`)),
];

// §13.4: the dump file. `lines` are the lines other areas add (`dump/sections.ts`); `prompts` is given
// only for `/watchdog dump raw`.
export const dumpText = (input: {
  sessionId: string;
  time: number;
  lines: readonly string[];
  records: readonly LogRecord[];
  prompts?: readonly ReviewPrompt[];
}): string =>
  [
    '# watchdog dump',
    [
      `- session: ${input.sessionId}`,
      `- written: ${isoTime(input.time)}`,
      ...input.lines.map((line) => `- ${line}`),
    ].join('\n'),
    '## Reviews',
    ...(input.records.length === 0 ? ['No review records.'] : input.records.map(recordText)),
    ...(input.prompts === undefined ? [] : promptsText(input.prompts)),
  ].join('\n\n') + '\n';
