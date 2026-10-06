// What a check's `verify` returns. `evidence` is a list of short lines (log excerpts, counts, file paths).
// - pass / fail: the fact holds or does not.
// - inconclusive: the model did not do the action the check needs (for example the watchdog sent no note), so the
//   fact could not be seen. It does not fail the run; the report lists it for a rerun.
const verdict = (status) => (evidence, details) => ({
  status,
  evidence: (Array.isArray(evidence) ? evidence : [evidence]).filter((line) => line !== undefined && line !== ''),
  details: details ?? null,
});

export const pass = verdict('pass');
export const fail = verdict('fail');
export const inconclusive = verdict('inconclusive');

// pass when every named condition holds, else fail with the ones that do not. `conditions` maps a label to a
// boolean; `evidence` is added either way.
export const expectAll = (conditions, evidence = []) => {
  const failed = Object.entries(conditions)
    .filter(([, holds]) => !holds)
    .map(([label]) => label);
  return failed.length === 0
    ? pass([...Object.keys(conditions).map((label) => `ok: ${label}`), ...evidence])
    : fail([...failed.map((label) => `NOT: ${label}`), ...evidence]);
};

export const clip = (value, max = 300) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && text.length > max ? `${text.slice(0, max)}…` : String(text);
};
