// Release-probe mod (spec §16.5 late subagent notes; research/smoke-subagent-delivery.md:142,225): it appends one
// note into a subagent while its `sleep` Bash call runs, one after the agent's final answer (its last turn.step,
// after next) and one at its turn.complete; once the main turn after that run ends, it resumes the finished agent
// with $.session.send, as the SendMessage tool resumes one (d.ts SessionSendAddress).
const FILE = '__LOG__/rd-sub.jsonl';
const SLEEP = /sleep\s+\d/u;
const INFLIGHT =
  '<watchdog-notes>\n<note watchdog="probe" severity="concern">Code word RDINFLIGHT. Use it as WORD in your next ' +
  'Bash call.</note>\n</watchdog-notes>';
const LATE =
  '<watchdog-notes>\n<note watchdog="probe" severity="concern">Late code word RDLATE.</note>\n</watchdog-notes>';
const RESUME =
  'RDRESUME. No earlier task is pending. Reply with exactly NOTES=<each code word that a watchdog note gave you, ' +
  'comma-separated> or NOTES=NONE. Do not use tools.';
const RESUME_DELAY_MS = 1500;
const lines = [];
let writing = null;
let isDirty = false;
let agentId = null;
let runs = 0;
let isLateStepDone = false;
let isLateCompleteDone = false;
let isResumeSent = false;

// Rewrites the whole log file; a write asked while one runs is folded into one more pass (as the observer does).
const flush = ($) => {
  if (writing) {
    isDirty = true;
    return writing;
  }
  writing = (async () => {
    do {
      isDirty = false;
      await $.fs.write(FILE, `${lines.join('\n')}\n`);
    } while (isDirty);
  })()
    .catch(() => undefined)
    .finally(() => {
      writing = null;
    });
  return writing;
};

const record = ($, data) => {
  lines.push(JSON.stringify({ t: Date.now(), ...data }));
  return flush($);
};

const errorText = (error) => String(error?.message ?? error).slice(0, 180);

// The append the spec rules out for a subagent (§11.3): `$.session.append({ agentId })`. A `{ deny }` or a
// rejection (research: "no running loop is <id>") is the outcome.
const append = async ($, text) => {
  try {
    const appended = await $.session.append({ agentId, message: { type: 'user', content: [{ type: 'text', text }] } });
    return appended && typeof appended === 'object' && 'deny' in appended ? `deny ${appended.deny}` : 'ok';
  } catch (error) {
    return `throw ${errorText(error)}`;
  }
};

// §16.5: the resume of a finished agent from its JSONL, forced, so it does not wait on the model's choice.
const resume = async ($) => {
  try {
    const sent = await $.session.send({ to: { agentId }, text: RESUME });
    await record($, { kind: 'resume', agentId, outcome: sent?.isDelivered ? 'delivered' : `refused ${sent?.reason}` });
  } catch (error) {
    await record($, { kind: 'resume', agentId, outcome: `throw ${errorText(error)}` });
  }
};

export const register = (on) => {
  // smoke-subagent-delivery.md:225: the first note goes in while the agent's first `sleep` Bash call runs.
  on('tool.call', async ($, e, next) => {
    if (!e.agentId || e.tool !== 'Bash' || agentId !== null || !SLEEP.test(String(e.command ?? ''))) {
      return next(e);
    }
    agentId = e.agentId;
    const pending = next(e);
    pending.catch(() => undefined);
    const outcome = await append($, INFLIGHT);
    await record($, { kind: 'inflight', agentId, outcome });
    return pending;
  });
  // smoke-subagent-delivery.md:225: after the model's final answer (a step with no tool use) the append still
  // lands in the JSONL, and the claim is that no request follows it.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    if (agentId === null || e.agentId !== agentId) {
      return result;
    }
    const tools = result?.toolUses?.length ?? 0;
    const answer = String(result?.answer ?? '').slice(0, 200);
    await record($, { kind: 'step', run: runs + 1, index: e.index, tools, answer });
    if (tools === 0 && runs === 0 && !isLateStepDone) {
      isLateStepDone = true;
      await record($, { kind: 'late-step', agentId, outcome: await append($, LATE) });
    }
    return result;
  });
  on('turn.complete', async ($, e, next) => {
    if (agentId !== null && e.agentId === agentId) {
      // research 3B/3C: by the agent's turn.complete its loop is gone, so this append is refused.
      if (runs === 0 && !isLateCompleteDone) {
        isLateCompleteDone = true;
        await record($, { kind: 'late-complete', agentId, outcome: await append($, `${LATE}\nRDLATE-COMPLETE`) });
      }
      const result = await next(e);
      runs += 1;
      const answer = String(e.answer ?? '').slice(0, 300);
      await record($, { kind: 'complete', agentId, run: runs, reason: e.reason ?? null, answer });
      return result;
    }
    const result = await next(e);
    if (!e.agentId && agentId !== null && runs >= 1 && !isResumeSent) {
      isResumeSent = true;
      $.clock.after(RESUME_DELAY_MS, () => resume($));
    }
    return result;
  });
};
