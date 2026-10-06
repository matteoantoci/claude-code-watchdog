// §12.6: omp's "destructive shell command" regex (`advisor/runtime.ts:131-132`), verbatim.
const DESTRUCTIVE_SHELL = /\brm\s+(?=(?:-[a-z]+\s*)*-[a-z]*r[a-z]*)(?=(?:-[a-z]+\s*)*-[a-z]*f[a-z]*)(?:-[a-z]+\s*)+/i;

// §12.6: the row of a dropped note.
export const UNSAFE_ROW = 'watchdog: dropped a note with a destructive command';

// §12.6: a note is unsafe when it has the pattern and the batch text that the mod gave its review does not.
export const isUnsafeNote = (note: string, batch: string): boolean =>
  DESTRUCTIVE_SHELL.test(note) && !DESTRUCTIVE_SHELL.test(batch);
