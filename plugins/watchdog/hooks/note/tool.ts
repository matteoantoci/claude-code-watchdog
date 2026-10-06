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
