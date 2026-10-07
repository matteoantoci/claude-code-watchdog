import type { ToolSpec } from 'claude-code';

export type Severity = 'nit' | 'concern' | 'blocker';

const SEVERITIES: readonly Severity[] = ['nit', 'concern', 'blocker'];

// §9.2: `nit` < `concern` < `blocker`.
export const severityRank = (severity: Severity): number => SEVERITIES.indexOf(severity);

// §8.3: the description is omp `advise-tool.md`, the `note` text omp `advise-tool.ts:18` (build-session choice).
export const NOTE_TOOL: ToolSpec = {
  name: 'note',
  description: [
    'Watched agent: send 1 concrete, terse advice.',
    'Use sparingly; stay silent when nothing matters.',
    'Call to avert likely-wrong or materially wasteful work.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description: 'One concrete piece of advice for the agent you are watching. Terse, specific, actionable.',
      },
      severity: {
        enum: SEVERITIES,
        description: 'How strongly to weigh this. Use `nit` for non-urgent cleanup.',
      },
    },
    required: ['note', 'severity'],
  },
};

// §10.8: a review agent retracts one of its open notes (build-session choice: a tool of its own, so the `note`
// schema stays omp's and a retraction never meets the emission guard).
export const RESOLVE_TOOL: ToolSpec = {
  name: 'resolve',
  description: [
    'Retract one of your open notes that no longer holds.',
    "It leaves the person's band; a note not yet delivered never reaches the agent.",
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of an open note, as your notes so far list it.' },
      reason: { type: 'string', description: 'Why the note no longer holds, in one short sentence.' },
    },
    required: ['id', 'reason'],
  },
};

// §8.3, §10.8: the tools of the mod, registered together.
export const WATCHDOG_TOOLS: readonly ToolSpec[] = [NOTE_TOOL, RESOLVE_TOOL];

export const isSeverity = (value: unknown): value is Severity => SEVERITIES.some((severity) => severity === value);

// The arguments of one `note` call, or undefined when they do not fit the schema.
export const parseNote = (input: {
  readonly note?: unknown;
  readonly severity?: unknown;
  readonly [argument: string]: unknown;
}): { text: string; severity: Severity } | undefined =>
  typeof input.note === 'string' && isSeverity(input.severity)
    ? { text: input.note, severity: input.severity }
    : undefined;

// §10.8: the arguments of one `resolve` call, or undefined when they do not fit the schema.
export const parseResolve = (input: {
  readonly id?: unknown;
  readonly reason?: unknown;
  readonly [argument: string]: unknown;
}): { id: string; reason: string } | undefined =>
  typeof input.id === 'string' && typeof input.reason === 'string' ? { id: input.id, reason: input.reason } : undefined;
