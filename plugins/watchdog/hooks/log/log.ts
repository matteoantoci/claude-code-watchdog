import type { PluginState } from 'claude-code';

// §13.4: one record of the review log, `$.state` key `log`.
export type LogRecord = PluginState['watchdog']['log'][number];

// §13.4: the newest records the log keeps.
const MAX_LOG_RECORDS = 100;

// The live review log is module memory, newest last; `$.state` keeps a copy.
const memory: { log: readonly LogRecord[] } = { log: [] };

// `watchdog` is the display name, `time` milliseconds since the epoch.
export const errorRecord = (input: { watchdog: string; time: number; error: string }): LogRecord => ({
  kind: 'error',
  ...input,
});

export const appendLog = (log: readonly LogRecord[], record: LogRecord): readonly LogRecord[] =>
  [...log, record].slice(-MAX_LOG_RECORDS);

export const addLogRecord = (record: LogRecord): void => {
  memory.log = appendLog(memory.log, record);
};

export const currentLog = (): readonly LogRecord[] => memory.log;
