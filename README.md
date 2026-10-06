# watchdog

A Claude Code plugin with a hooks module. Watchdog agents review each update of the agent you work with, each on its own
model, and push short notes to it: `nit`, `concern` or `blocker`.

## Requirements

Claude Code 2.1.290 or later. The npm `stable` channel (2.1.285 on 2026-10-06) has no mods. Below 2.1.290 the plugin
shows `unsupported`. Desktop support starts when Claude.app bundles Claude Code 2.1.290 or later.

## Install

```
/plugin marketplace add matteoantoci/claude-code-watchdog
/plugin install watchdog@matteoantoci
```

## Use

- `/watchdog` or `/watchdog status`: a short status.
- `/watchdog on` and `/watchdog off`: turn reviews on or off for this session.
- `/watchdog dump` and `/watchdog dump raw`: write the review log to a file.

## Development

`npm install` sets up the tools and the pre-commit hook. `npm run check` runs the 5 checks that pre-commit and CI run.

## License

Apache-2.0
