# When a review fails

The plugin adds no retries of its own; Claude Code already retries an overloaded API. A failed review that sent no note
goes back to the front of the backlog (the updates that wait for the watchdog's next review) and joins the next review.
`/watchdog status` shows `fail 1/3` after a failure, a `refused` count, and the last error; the dump (`/watchdog dump`)
keeps each error.

- `halted`: after 3 failed reviews in a row, or at once when the credit balance is too low. The backlog is dropped. The
  watchdog tries one review at your first prompt after 5 min, then after 15 min, then after each 60 min.
- `limited`: the subscription limit is reached. The backlog stays, and the watchdog tries one review at your next
  prompt.
- `no_model`: the model does not exist or Claude Code ran another one. Neither this state nor `blocked` retries by
  itself.
- `blocked`: a permission rule denies `Agent`. In Auto permission mode, the plugin allows its own review spawn before
  the auto-mode classifier sees it; if the classifier still refuses a spawn, the state is `blocked` with the reason
  `auto mode`. That counts no failure. The status and the band line say to switch the permission mode, or to run
  `/watchdog on` to retry.

One log row shows when a watchdog enters one of these states, and `watchdog: <name> is back` when it leaves.
`/watchdog on` tries every watchdog again at once.
