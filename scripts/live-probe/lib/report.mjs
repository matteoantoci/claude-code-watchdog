// The probe report: report.md (summary table, then each check with its evidence) and report.json, in the out
// folder. Written again after each scenario, so a crash keeps the results so far.
import fs from 'node:fs';
import path from 'node:path';

const STATUSES = ['pass', 'fail', 'error', 'inconclusive', 'skipped', 'manual'];

export const tally = (results) => {
  const count = (kind) =>
    Object.fromEntries(
      STATUSES.map((status) => [
        status,
        results.filter((result) => result.kind === kind && result.status === status).length,
      ])
    );
  return { deterministic: count('deterministic'), advisory: count('advisory'), manual: count('manual') };
};

// The run fails when a deterministic check fails or errors.
export const isFailedRun = (results) =>
  results.some((result) => result.kind === 'deterministic' && (result.status === 'fail' || result.status === 'error'));

const line = (counts) =>
  STATUSES.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(', ') || 'none';

export const summaryText = (results) => {
  const t = tally(results);
  return [
    `deterministic: ${line(t.deterministic)}`,
    `advisory: ${line(t.advisory)}`,
    `manual: ${line(t.manual)}`,
    `run: ${isFailedRun(results) ? 'FAILED' : 'passed'}`,
  ].join('\n');
};

const cell = (text) =>
  String(text ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');

const resultBlock = (result) =>
  [
    `### ${result.id}: ${result.status.toUpperCase()}`,
    '',
    `${result.title}`,
    '',
    `- kind: ${result.kind}; source: ${result.source}; scenario: ${result.scenario ?? 'none'}`,
    ...(result.reason ? [`- reason: ${result.reason}`] : []),
    ...(result.runs?.length ? [`- runs: ${result.runs.join(', ')}`] : []),
    ...(result.evidence?.length ? ['', '```', ...result.evidence.map((item) => String(item)), '```'] : []),
    ...(result.details ? ['', result.details] : []),
    '',
  ].join('\n');

export const writeReport = (ctx, results) => {
  const order = { fail: 0, error: 1, inconclusive: 2, pass: 3, skipped: 4, manual: 5 };
  const md = [
    '# watchdog live probe report',
    '',
    `- started: ${new Date(ctx.started).toISOString()}${ctx.finished ? `; finished: ${new Date(ctx.finished).toISOString()}` : ' (running)'}`,
    `- claude: ${ctx.bin} (${ctx.versionText})`,
    `- plugin: ${ctx.pluginDir} at ${ctx.commit}`,
    `- options: ${ctx.argvText}`,
    `- runs: ${path.join(ctx.outDir, 'runs')}`,
    '',
    '## Summary',
    '',
    '```',
    summaryText(results),
    '```',
    '',
    '| Check | Kind | Status | Source | First evidence |',
    '| --- | --- | --- | --- | --- |',
    ...[...results]
      .sort((a, b) => order[a.status] - order[b.status])
      .map(
        (result) =>
          `| ${cell(result.id)} | ${result.kind} | ${result.status} | ${cell(result.source)} | ${cell((result.reason ?? result.evidence?.[0] ?? '').slice(0, 160))} |`
      ),
    '',
    '## Checks',
    '',
    ...results.map(resultBlock),
  ].join('\n');
  fs.writeFileSync(path.join(ctx.outDir, 'report.md'), md);
  fs.writeFileSync(
    path.join(ctx.outDir, 'report.json'),
    JSON.stringify(
      {
        started: ctx.started,
        finished: ctx.finished ?? null,
        bin: ctx.bin,
        version: ctx.versionText,
        commit: ctx.commit,
        tally: tally(results),
        failed: isFailedRun(results),
        results,
      },
      null,
      2
    )
  );
  return path.join(ctx.outDir, 'report.md');
};
