// The Desktop checks (spec §16.5 "Desktop, once Claude.app bundles 2.1.290 or later", plus the Desktop rows of
// §16.1). The probe cannot drive the desktop app, so each one is a manual step of the checklist in ../README.md.
const manual = (id, title, source, steps) => ({
  id,
  title,
  source,
  kind: 'manual',
  needs: ['desktop'],
  manual: steps,
});

export const scenarios = [];

export const checks = [
  manual('desktop-version', 'The bundled engine is 2.1.290 or later: /watchdog is not unsupported', '§16.3: Desktop', [
    'Type /watchdog: it draws the status table, not unsupported.',
  ]),
  manual('desktop-attach', 'The session.attach desktop event drops a CLAUDE_WATCHDOG on state', '§16.5: Desktop', [
    'Quit Claude.app, start it with `open --env CLAUDE_WATCHDOG=on -a Claude` and open a session.',
    '/watchdog shows it off, and /watchdog dump lists "CLAUDE_WATCHDOG on state dropped at the Desktop attach".',
  ]),
  manual(
    'desktop-on-by-default',
    'A late onByDefault registration turns a Desktop session on without /watchdog on',
    '§16.5: Desktop',
    [
      'Turn onByDefault on in /config and open a new Desktop session.',
      'It is on before the first prompt, and the first prompt gets a review.',
    ]
  ),
  manual('desktop-command', '/watchdog on, /watchdog off and /watchdog status work on Desktop', '§16.5: Desktop', [
    'Type /watchdog on, /watchdog off, then /watchdog status.',
    'The status table shows each watchdog: name, state, source file, tokens, cost.',
  ]),
  manual(
    'desktop-review',
    'A full review runs on Desktop: note, card, nudge, subagent delivery',
    '§16.1 L3: band cards',
    [
      'Do real work that a watchdog reviews, with "subagents": { "Explore": true } in WATCHDOG.json.',
      'A note lands as a band card and a log row; a note after the reply nudges; an Explore subagent gets its note in its tool result.',
    ]
  ),
  manual(
    'desktop-paint',
    'The band paints on Desktop and the ctrl+o transcript shows the review rows',
    '§16.5: Desktop paint',
    ['Check the band paint and open the ctrl+o transcript view.']
  ),
  manual(
    'desktop-dump',
    '/watchdog dump writes the file; Desktop has no clipboard path',
    '§16.1 L3: /watchdog commands',
    ['Type /watchdog dump and open the file the reply names. There is no copy button on Desktop.']
  ),
  manual(
    'desktop-caps',
    'A stop from the Desktop tasks UI, the spawn caps and maxTurns act as in the terminal',
    '§16.5: review stop and spawn caps',
    ['Stop a running review from the Desktop tasks UI: its dump record shows "- end: aborted".']
  ),
  manual(
    'desktop-surfaces',
    '$.ui.log rows, toasts and the status render on Desktop',
    '§16.5: the desktop draws $.ui.log, toast and status',
    ['Check that a log row, a toast and the status table render on Desktop.']
  ),
  manual('desktop-l3', 'The deterministic checks of one probe report hold on Desktop too', '§16.5: Desktop', [
    'Repeat by hand the steps of the deterministic checks that the probe drives in the terminal.',
  ]),
];
