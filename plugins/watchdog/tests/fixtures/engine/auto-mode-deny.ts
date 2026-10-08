// The engine's deny of a review spawn in Auto permission mode (spec §12.2). Recorded on Claude Code 2.1.293 in the
// Desktop app (entrypoint `claude-desktop`, `permissionMode` `auto`, main model claude-opus-5-5), where the review
// spawn went to the server-side classifier. Source: the session transcript's `/watchdog status` reply, which quotes
// the spawn's deny as `last error: default: <the text>` (status `default idle · fail 2/3`, before the fix).
export const AUTO_MODE_DENY =
  "The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.";
