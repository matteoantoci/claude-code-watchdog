# Claude Code Watchdog

A Claude Code mod that attaches a second model to a session. The second model reviews the work and sends advice back to the session.

## Language

**Primary agent**:
The Claude session that the person talks to.
_Avoid_: main agent, doer

**Person prompt**:
A prompt that the person sends to the primary agent, typed or relayed from their own device. A task notification, a schedule, another session or a plugin does not send one.
_Avoid_: user prompt, composer prompt

**Subagent**:
An agent that the primary agent, or another subagent, spawns with the `Agent` tool. A watchdog's own agent is not a subagent. An engine fork (for example a summary or a compaction) is not a subagent.

**Watched agent**:
The primary agent, or a subagent whose type the roster opts in to review.

**Watchdog**:
The reviewer model that watches the watched agents and pushes notes to them, without a request.
_Avoid_: advisor (Claude Code's builtin advisor is a different thing: a tool that the primary agent calls to ask a stronger model)

**Roster**:
The set of watchdogs for a session, from the `watchdogs` lists of all `WATCHDOG.json` files. When no file has a `watchdogs` list, there is one default watchdog.

**On**:
The state of a session in which its watchdogs review. The person turns a session on or off. A watchdog that its roster entry pauses does not review, even when the session is on.
_Avoid_: enabled, active (the roster uses "enabled" for one watchdog, not for the session)

**Headless run**:
A session with no person at a prompt box, for example `claude -p` or an SDK session. The person turns it on before it starts, not with a command.
_Avoid_: print mode, batch run

**Guidance**:
Text from `WATCHDOG.md` that tells every watchdog what to look for.

**Update**:
The part of a watched agent's transcript that is new since the last review of that agent.

**Review**:
One pass of a watchdog over one or more updates of one watched agent.

**Boundary**:
The point where an update of a watched agent closes: the end of a tool round, or the end of a turn.

**Backlog**:
The updates of one watched agent that wait for a watchdog's next review of that agent. A watchdog has one backlog for each agent that it watches, and it reviews one backlog at a time. The next review of that agent takes all of its updates.
_Avoid_: queue, pending

**Note**:
One piece of advice from a watchdog. It has one severity: `nit`, `concern`, or `blocker`.

**Emission guard**:
The check that drops a note before delivery when the note is empty, says nothing, repeats an earlier note, or is over the note budget of its review.
_Avoid_: filter, dedupe

**Read scope**:
The files that a watchdog may read: the working directory, plus the reads that the primary agent or any subagent already made with the person's permission. A read outside it is refused.

**Delivery**:
How a note gets to a watched agent. It is an **aside**, a **steer**, or a **nudge**. A subagent gets only steers.

**Aside**:
A delivery that the primary agent reads with the next prompt from the person.

**Steer**:
A delivery that a watched agent reads at its next model request in the same turn, after a tool result. It does not stop the work.

**Late note**:
A note that is not delivered before the watched agent's turn ends. It becomes a steer in the next turn, a nudge, or an aside. A late note on a subagent goes to the primary agent.

**Nudge**:
A delivery that starts a new turn after the primary agent stopped, so that it checks a late note.

**Task notification**:
The engine's prompt that reports a finished background subagent to the primary agent. It starts a main turn, or it goes into a turn that runs. It is not a prompt from the person.

**Halt**:
The state of a watchdog after repeated failed reviews. It makes no reviews and tries again by itself after a wait.
_Avoid_: error, paused
