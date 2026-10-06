// State contract of the first-check 11 reload probe (prototypes/first-checks/reload/mod/types).
export type FcReloadMark = { inst: string; at: number };
declare module 'claude-code' {
  interface PluginState {
    fcreload: { mark: FcReloadMark };
  }
}
