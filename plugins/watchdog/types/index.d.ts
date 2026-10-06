// The PluginState contract: one literal `$.state` key for each row of spec §14.1. `claude plugin validate`
// wants this file self-contained and each key named inside `watchdog: { … }`. A hook module names a
// value type as `PluginState['watchdog']['<key>']`. A ticket that adds a key adds one property there.

// §7.1: the primary agent's feed.
export type WatchdogFeed = {
  // Rendered rows, oldest first; rows behind the oldest cursor are dropped.
  readonly rows: readonly { readonly uuid: string; readonly text: string }[];
  // §7.2: the last row of each update that a boundary closed, oldest first.
  readonly ends: readonly string[];
  // Watchdog slug → the uuid of its last reviewed row; null before the first row.
  readonly cursors: Readonly<Record<string, string | null>>;
};

// §13.4: one note of a review, as the dump shows it.
export type WatchdogLogNote = { readonly severity: string; readonly text: string; readonly delivery: string };

// §13.4: the token counts of a review's `turn.complete` usage, and the model that ran.
export type WatchdogLogUsage = {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly model: string;
};

// §13.4: one record of the review log. `watchdog` is the display name, `time` ms since the epoch.
// `review`: one finished review, with its `turn.complete` `reason`, step count and answer length.
// `error`: an error of the mod that belongs to a watchdog (for example a refused steer append).
export type WatchdogLogRecord =
  | {
      readonly kind: 'review';
      readonly watchdog: string;
      readonly agentId: string;
      readonly time: number;
      readonly model: string;
      readonly effort: string;
      readonly reason: 'answer' | 'aborted' | 'refusal' | 'error';
      readonly steps: number;
      readonly answerLength: number;
      readonly answer: string;
      readonly usage: WatchdogLogUsage | null;
      // §15: null while no price is known for the model.
      readonly cost: number | null;
      readonly notes: readonly WatchdogLogNote[];
      readonly error: string | null;
    }
  | { readonly kind: 'error'; readonly watchdog: string; readonly time: number; readonly error: string };

// §10.3: a late note of the nudge that waits, as the note hook admitted it: the watchdog slug, the review
// agent, and the main-loop turn when it came (§10.7).
export type WatchdogNudgeNote = {
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: 'nit' | 'concern' | 'blocker';
  readonly text: string;
  readonly turn: number;
};

// §10.3, §10.4: the nudge budget of the current person prompt, the cooldown start and the nudge that waits.
export type WatchdogNudge = {
  // Nudges sent since the last person prompt.
  readonly nudges: number;
  // The `turns` counter at the last nudge turn, where the cooldown starts; null before the first nudge.
  readonly nudgeTurn: number | null;
  // When the 2 s wait of the nudge that waits ends, ms since the epoch; null when no nudge waits.
  readonly dueAt: number | null;
  // The late notes of the nudge that waits: a reload loses the held list, and sets the wait again from here.
  readonly notes: readonly WatchdogNudgeNote[];
};

declare module 'claude-code' {
  interface PluginState {
    watchdog: {
      // §5.2, §5.4, §14.1: the on flag and the on source.
      on:
        | { readonly isOn: true; readonly source: '/watchdog on' | 'onByDefault' | 'CLAUDE_WATCHDOG' }
        | { readonly isOn: false };
      // §7.3: the id set as an array (a Set becomes `{}` in JSON): each review agent and its watchdog slug.
      ids: readonly { readonly agentId: string; readonly watchdog: string }[];
      feed: WatchdogFeed;
      // §13.4: the review log, newest last; no render hook reads it, so a write draws nothing.
      log: readonly WatchdogLogRecord[];
      // §10.7: the main-loop `turn.start` counter of `turns_ago`.
      turns: number;
      // §6.5, §14.1: the read-scope allow set: the match key of each recorded call, oldest first, cap 500.
      allow: readonly string[];
      // §6.5 item 8: the read-scope denies of each watchdog slug.
      denies: Readonly<Record<string, number>>;
      // §10.3, §10.4, §14.1: the nudge budget, the cooldown and the nudge that waits.
      nudge: WatchdogNudge;
    };
  }
}
