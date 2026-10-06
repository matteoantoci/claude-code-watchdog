// The PluginState contract: one literal `$.state` key for each row of spec §14.1. `claude plugin validate`
// wants this file self-contained and each key named inside `watchdog: { … }`. A hook module names a
// value type as `PluginState['watchdog']['<key>']`. A ticket that adds a key adds one property there.

// §7.6: one feed row in the omp markdown form, with the caps applied.
export type WatchdogFeedRow = {
  readonly uuid: string;
  // The row as a full update shows it.
  readonly text: string;
  // The omp watched-role label (`**user**:` the person, `**agent**:` the primary agent); a row without one
  // is a one-line row and ends a run of one label.
  readonly role?: 'user' | 'agent';
  // §7.6 batch cap: the row in a collapsed update (a tool call's one line, or the person's text); a row
  // without one leaves a collapsed update.
  readonly brief?: string;
  // The id of a tool call, which its result row names.
  readonly call?: string;
};

// §7.5: how a boundary closed an update: mid-turn (`step`), at the end of a turn, or at an Esc.
export type WatchdogUpdateClose = 'step' | 'turn' | 'interrupted';

// §7.1: the primary agent's feed.
export type WatchdogFeed = {
  // Rendered rows, oldest first; rows behind the oldest cursor are dropped.
  readonly rows: readonly WatchdogFeedRow[];
  // §7.2: the last row of each update that a boundary closed, oldest first.
  readonly ends: readonly { readonly uuid: string; readonly close: WatchdogUpdateClose }[];
  // Watchdog slug → the uuid of its last reviewed row; null before the first row.
  readonly cursors: Readonly<Record<string, string | null>>;
  // §7.7 part 2: the person prompts since `/watchdog on`.
  readonly prompts: number;
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
// `unreviewed`: §7.5, the updates of a `-p` run that no review took.
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
      // §12.4: the error of the review's outcome: its synthetic row text, or the reason of a `no_model` compare.
      readonly error: string | null;
      // §12.3 item 10: the `refusal.category` of a refusal; null for another end or no category.
      readonly refusal: string | null;
    }
  | { readonly kind: 'error'; readonly watchdog: string; readonly time: number; readonly error: string }
  | { readonly kind: 'unreviewed'; readonly watchdog: string; readonly time: number; readonly updates: number }
  // §7.8 action 6: a review stopped after its 10 min; `agentId` is null when its id never came.
  | { readonly kind: 'timeout'; readonly watchdog: string; readonly agentId: string | null; readonly time: number };

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

// §12.4: a problem state of one watchdog and its error text. `halted` keeps its failed tries and the time of
// its next try (ms since the epoch).
export type WatchdogProblem =
  | { readonly state: 'no_model' | 'blocked' | 'limited'; readonly reason: string }
  | { readonly state: 'halted'; readonly reason: string; readonly tries: number; readonly nextTryAt: number };

// §12.3: the failure state of one watchdog: its problem (null for none), its failed reviews in a row and its
// refusals in the session.
export type WatchdogHealth = {
  readonly problem: WatchdogProblem | null;
  readonly failures: number;
  readonly refused: number;
};

// §7.8: why the mod stopped a review agent.
export type WatchdogStopReason = 'timeout' | 'off' | 'session' | 'rewind';

// §7.8: one review that runs: its watchdog slug, its agent (null until the id comes) and its spawn time (ms
// since the epoch).
export type WatchdogRunningReview = {
  readonly watchdog: string;
  readonly agentId: string | null;
  readonly spawnedAt: number;
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
      // §12.3, §14.1: the failure state of each watchdog slug, and the last error for the status (§12.4).
      health: { readonly watchdogs: Readonly<Record<string, WatchdogHealth>>; readonly lastError: string | null };
      // §7.8, §14.1: the reviews that run, and the stop map: each agent the mod stopped and why.
      reviews: {
        readonly running: readonly WatchdogRunningReview[];
        readonly stops: readonly { readonly agentId: string; readonly reason: WatchdogStopReason }[];
      };
    };
  }
}
