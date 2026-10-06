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
    };
  }
}
