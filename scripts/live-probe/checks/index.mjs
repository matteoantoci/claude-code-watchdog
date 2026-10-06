// The catalogue: every scenario and every check, in run order. A check names the scenario whose observations it
// reads; a scenario runs once for all its checks.
import * as firstChecks from './first-checks.mjs';
import * as l3 from './l3.mjs';
import * as manual from './manual.mjs';
import * as releaseDelivery from './release-delivery.mjs';
import * as releaseFailure from './release-failure.mjs';
import * as releaseRuntime from './release-runtime.mjs';
import * as shared from './shared.mjs';

// §16.3 scenarios: the 11 first checks (§16.4), the L3 column of §16.1, the release-probe items (§16.5), and the
// manual Desktop checklist.
const GROUPS = [shared, firstChecks, l3, releaseDelivery, releaseFailure, releaseRuntime, manual];

const ALL_SCENARIOS = GROUPS.flatMap((group) => group.scenarios);

export const SCENARIOS = new Map(ALL_SCENARIOS.map((scenario) => [scenario.id, scenario]));

if (SCENARIOS.size !== ALL_SCENARIOS.length) {
  const ids = ALL_SCENARIOS.map((scenario) => scenario.id);
  throw new Error(`duplicate scenario ids: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
}

export const CHECKS = GROUPS.flatMap((group) => group.checks);

const ids = new Set();
for (const check of CHECKS) {
  if (ids.has(check.id)) {
    throw new Error(`duplicate check id ${check.id}`);
  }
  ids.add(check.id);
  if (check.kind !== 'manual' && !SCENARIOS.has(check.scenario)) {
    throw new Error(`check ${check.id} names an unknown scenario ${check.scenario}`);
  }
  if (!['deterministic', 'advisory', 'manual'].includes(check.kind)) {
    throw new Error(`check ${check.id} has kind ${check.kind}`);
  }
}
