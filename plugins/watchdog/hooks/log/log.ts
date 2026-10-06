import { LOG_RECORD_CAP, RAW_PROMPT_CAP } from '../constants';
import type { Watchdog } from '../agents/roster';
import type { HeldNote } from '../note/notes';
import type { PluginState, TurnCompleteInput } from 'claude-code';

// §13.4: one record of the review log (its shape is the `log` key of the state contract).
export type LogRecord = PluginState['watchdog']['log'][number];

export type ReviewRecord = Extract<LogRecord, { kind: 'review' }>;

type LogNote = ReviewRecord['notes'][number];

// What the mod saw of one review agent while it ran: its `turn.step` count (§12.1), its admitted notes and the
// error of its outcome (§12.4).
export type ReviewTrace = { readonly steps: number; readonly notes: readonly LogNote[]; readonly error: string | null };

// §13.4: the full prompt of one review, for `/watchdog dump raw`.
export type ReviewPrompt = { readonly watchdog: string; readonly prompt: string };

// §13.4: the newest records stay.
export const appendLog = (log: readonly LogRecord[], record: LogRecord): readonly LogRecord[] =>
  [...log, record].slice(-LOG_RECORD_CAP);

export const errorRecord = (input: { watchdog: string; time: number; error: string }): LogRecord => ({
  kind: 'error',
  ...input,
});

// §7.5: the updates of one watchdog's backlog that a `-p` run left unreviewed.
export const unreviewedRecord = (input: { watchdog: string; time: number; updates: number }): LogRecord => ({
  kind: 'unreviewed',
  ...input,
});

// §7.8 action 6: a review that timed out.
export const timeoutRecord = (input: { watchdog: string; agentId: string | null; time: number }): LogRecord => ({
  kind: 'timeout',
  ...input,
});

// §13.4: one finished review. §12.2: the model that ran is `usage.model`, else the roster's. §12.3 item 10: a
// refusal keeps its category.
export const reviewRecord = (input: {
  watchdog: Watchdog;
  agentId: string;
  time: number;
  end: TurnCompleteInput;
  trace: ReviewTrace;
  subagent?: ReviewRecord['subagent'];
}): ReviewRecord => {
  const { watchdog, end, trace } = input;
  const usage = end.usage;
  return {
    kind: 'review',
    watchdog: watchdog.name,
    agentId: input.agentId,
    time: input.time,
    model: usage?.model ?? watchdog.model,
    effort: watchdog.effort,
    reason: end.reason,
    steps: trace.steps,
    answerLength: end.answer.length,
    answer: end.answer,
    usage:
      usage === undefined
        ? null
        : {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens,
            cache_creation_input_tokens: usage.cache_creation_input_tokens,
            model: usage.model,
          },
    cost: null,
    notes: trace.notes,
    error: trace.error,
    refusal: end.reason === 'refusal' ? end.refusal.category : null,
    ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
  };
};

const EMPTY_TRACE: ReviewTrace = { steps: 0, notes: [], error: null };

// The live log and the last prompts are module memory; `$.state` key `log` keeps a copy of the log
// (§14.1). A reload loses the prompts (§13.4).
const memory: { log: readonly LogRecord[]; prompts: readonly ReviewPrompt[] } = { log: [], prompts: [] };
const traces = new Map<string, ReviewTrace>();

export const currentLog = (): readonly LogRecord[] => memory.log;

export const addLogRecord = (record: LogRecord): void => {
  memory.log = appendLog(memory.log, record);
};

export const recentPrompts = (): readonly ReviewPrompt[] => memory.prompts;

export const rememberPrompt = (prompt: ReviewPrompt): void => {
  memory.prompts = [...memory.prompts, prompt].slice(-RAW_PROMPT_CAP);
};

export const traceOf = (agentId: string): ReviewTrace => traces.get(agentId) ?? EMPTY_TRACE;

export const countStep = (agentId: string): void => {
  const trace = traceOf(agentId);
  traces.set(agentId, { ...trace, steps: trace.steps + 1 });
};

export const traceNote = (note: HeldNote): void => {
  const trace = traceOf(note.agentId);
  const logged = { severity: note.severity, text: note.text, delivery: note.delivery };
  traces.set(note.agentId, { ...trace, notes: [...trace.notes, logged] });
};

// §12.4: the error of a review's outcome goes to its record.
export const traceError = (agentId: string, error: string): void => {
  traces.set(agentId, { ...traceOf(agentId), error });
};

// A review's end takes its trace; the agent never runs again.
export const takeTrace = (agentId: string): ReviewTrace => {
  const trace = traceOf(agentId);
  traces.delete(agentId);
  return trace;
};
