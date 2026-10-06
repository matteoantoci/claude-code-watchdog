// The PluginState contract: one literal `$.state` key for each row of spec §14.1.
// No key yet. The ticket that writes the first key replaces `Record<string, never>` with an object type;
// each later key is one more property of it.
export type WatchdogState = Record<string, never>;

declare module 'claude-code' {
  interface PluginState {
    watchdog: WatchdogState;
  }
}
