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
  // §10.8: the file path of an `Edit`, `Write`, `MultiEdit` or `NotebookEdit` call, which the outdated mark of a
  // note counts.
  readonly edit?: string;
};

// §7.5: how a boundary closed an update: mid-turn (`step`), at the end of a turn, or at an Esc.
export type WatchdogUpdateClose = 'step' | 'turn' | 'interrupted';

// §7.1: the primary agent's feed.
export type WatchdogFeed = {
  // Rendered rows, oldest first; rows behind the oldest cursor are dropped.
  readonly rows: readonly WatchdogFeedRow[];
  // §7.2: the last row of each update that a boundary closed, oldest first, with the main-loop turn counter
  // (§10.7) when it closed: the turn of a review's batch (§10.8).
  readonly ends: readonly { readonly uuid: string; readonly close: WatchdogUpdateClose; readonly turn: number }[];
  // Watchdog slug → the uuid of its last reviewed row; null before the first row.
  readonly cursors: Readonly<Record<string, string | null>>;
  // §7.7 part 2: the person prompts since `/watchdog on`.
  readonly prompts: number;
};

// §11.1: the watched subagent a note or a review is about: its `agentId` and its `agent.spawn` `subagentType`.
export type WatchdogSubagentRef = { readonly agentId: string; readonly type: string };

// §11.1, §11.2: one watched subagent: its type, the spawn `prompt` (its task), the watchdog slugs that review it,
// its own feed (one backlog and cursor for each of those watchdogs), and whether its loop still runs (§11.3).
export type WatchdogSubagent = {
  readonly type: string;
  readonly task: string;
  readonly watchdogs: readonly string[];
  readonly feed: WatchdogFeed;
  readonly isRunning: boolean;
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
      // §11.4: a review of a subagent; absent for a review of the primary agent.
      readonly subagent?: WatchdogSubagentRef;
    }
  | { readonly kind: 'error'; readonly watchdog: string; readonly time: number; readonly error: string }
  | { readonly kind: 'unreviewed'; readonly watchdog: string; readonly time: number; readonly updates: number }
  // §7.8 action 6: a review stopped after its 10 min; `agentId` is null when its id never came.
  | { readonly kind: 'timeout'; readonly watchdog: string; readonly agentId: string | null; readonly time: number };

// §10.3: a late note of the nudge that waits, as the note hook admitted it: the watchdog slug, the review
// agent, the last row of its review's batch (null when none was known) and the main-loop turn of that batch,
// else of its arrival (§10.7, §10.8).
export type WatchdogNudgeNote = {
  readonly watchdog: string;
  readonly agentId: string;
  readonly severity: 'nit' | 'concern' | 'blocker';
  readonly text: string;
  readonly batchEnd: string | null;
  readonly turn: number;
  // §10.7: the subagent of a late note on a subagent.
  readonly subagent?: WatchdogSubagentRef;
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
// since the epoch). §14.6: a reload rebuilds its slot from the rest: the last row of its batch, the subagent
// whose backlog it took (§11.2), the problem a try started from and a compact retry (§12.3).
export type WatchdogRunningReview = {
  readonly watchdog: string;
  readonly agentId: string | null;
  readonly spawnedAt: number;
  readonly batchEnd: string;
  readonly subagent?: string;
  readonly from?: WatchdogProblem;
  readonly isCompact?: boolean;
};

// §13.1: one band card: an admitted note since the last person prompt. `key` is the watchdog slug and the
// normalized text (§9.1), `seq` the order of admission (newest highest), `name` the watchdog's display name,
// `turn` the main-loop turn of the note's batch (§10.7), `subagent` the type of a watched subagent (§11.3).
// §10.8: `watchdog` is the slug, `batchEnd` the last row of the note's batch (null when none was known),
// `subagentId` the `agentId` of a watched subagent, `edits` the edits since the batch that the note names.
export type WatchdogCard = {
  readonly key: string;
  readonly seq: number;
  readonly name: string;
  readonly severity: 'nit' | 'concern' | 'blocker';
  readonly text: string;
  readonly turn: number;
  readonly delivery: string;
  readonly subagent?: string;
  readonly watchdog: string;
  readonly batchEnd: string | null;
  readonly subagentId?: string;
  readonly edits: number;
};

// §13.1: the cards, the session totals of the count line, the turn counter the card ages count from (0 with
// no card), the last `seq` given, and the `key` of the one card whose whole body shows (null when none).
export type WatchdogBand = {
  readonly cards: readonly WatchdogCard[];
  readonly totals: { readonly blocker: number; readonly concern: number; readonly nit: number };
  readonly turn: number;
  readonly seq: number;
  readonly expanded: string | null;
};

// §13.3, §15: what the finished reviews of one watchdog, or of the session, add up to: reviews, admitted notes by
// severity, tokens of all four classes, cost (the USD of the priced reviews, and whether any review had a price or
// ran a model that is not in the price table), and the model that ran last (null before any usage).
export type WatchdogTally = {
  readonly reviews: number;
  readonly notes: { readonly blocker: number; readonly concern: number; readonly nit: number };
  readonly tokens: number;
  readonly cost: { readonly usd: number; readonly hasPrice: boolean; readonly hasUnpriced: boolean };
  readonly model: string | null;
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
      // §11.2, build-session choice "`$.state` key names": each watched subagent, by its `agentId`; null for one
      // that the mod forgot (§5.2, §14.4), as `$.state` has no delete.
      subagents: StateFamily<WatchdogSubagent | null>;
      // §12.3, §14.1: the failure state of each watchdog slug, and the last error for the status (§12.4).
      health: { readonly watchdogs: Readonly<Record<string, WatchdogHealth>>; readonly lastError: string | null };
      // §7.8, §14.1: the reviews that run, and the stop map: each agent the mod stopped and why.
      reviews: {
        readonly running: readonly WatchdogRunningReview[];
        readonly stops: readonly { readonly agentId: string; readonly reason: WatchdogStopReason }[];
      };
      // §13.1: the band cards; the band hook reads it, so each write draws the band again.
      band: WatchdogBand;
      // §13.3, §15: the cost ledger: the tally of each watchdog slug and of the session, and the reviews of each
      // subagent type (§11.4). A reload must not zero the status totals, and the 100-record `log` cannot rebuild it.
      ledger: {
        readonly watchdogs: Readonly<Record<string, WatchdogTally>>;
        readonly session: WatchdogTally;
        readonly subagents: Readonly<Record<string, number>>;
      };
    };
  }
}
