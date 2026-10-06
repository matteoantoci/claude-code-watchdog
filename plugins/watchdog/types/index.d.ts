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

// §13.4: one review log record; an error of a delivery or a review.
export type WatchdogLogRecord = {
  readonly kind: 'error';
  readonly watchdog: string;
  readonly time: number;
  readonly error: string;
};

declare module 'claude-code' {
  interface PluginState {
    watchdog: {
      // §5.2, §14.1: the on flag and the on source.
      on: { readonly isOn: true; readonly source: '/watchdog on' } | { readonly isOn: false };
      // §7.3: the id set as an array (a Set becomes `{}` in JSON): each review agent and its watchdog slug.
      ids: readonly { readonly agentId: string; readonly watchdog: string }[];
      feed: WatchdogFeed;
      // §13.4: the review log, newest last; no render hook reads it, so a write draws nothing.
      log: readonly WatchdogLogRecord[];
      // §10.7: the main-loop `turn.start` counter of `turns_ago`.
      turns: number;
    };
  }
}
