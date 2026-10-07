// The engine's reject of the mod's preflight `$.model.complete` (spec §5.2 step 2) under an `availableModels`
// allowlist. Recorded by the live probe on 2.1.290: run full-1, scenario rf-allow-settings, `claude -p` with
// CLAUDE_WATCHDOG=on, `--settings '{"availableModels":["haiku","claude-sonnet-4-6"]}'` and a roster watchdog
// `probe` on `sonnet`. Source: the observer's `ui.log` record of the mod's no_model row, which quotes the reject:
// `watchdog: probe no_model: <the message>`. The run is from before the mod left an alias reject to the
// review-time compare.

// The model that the call named.
export const ALLOWLIST_REJECT_MODEL = 'sonnet';

// The reject's message, as the mod's `errorText` read it.
export const ALLOWLIST_REJECT = `watchdog: $.model.complete: model "sonnet" is not in this organization's allowlist`;
