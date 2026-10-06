// Files Claude Code and the plugin write outside the run folder: session transcripts under ~/.claude/projects/
// and the plugin's dump files under ~/.claude/watchdog/dumps/ (§13.4).
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from './env.mjs';
import { readJsonLines } from './run.mjs';

const PROJECTS = path.join(CLAUDE_HOME, 'projects');
export const DUMPS_DIR = path.join(CLAUDE_HOME, 'watchdog', 'dumps');

const projectDirs = () =>
  fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).map((name) => path.join(PROJECTS, name)) : [];

// The main transcript of a session: ~/.claude/projects/<encoded cwd>/<sessionId>.jsonl, parsed.
export const transcriptFile = (sessionId) =>
  projectDirs()
    .map((dir) => path.join(dir, `${sessionId}.jsonl`))
    .find((file) => fs.existsSync(file)) ?? null;

export const readTranscript = (sessionId) => {
  const file = transcriptFile(sessionId);
  return file ? readJsonLines(file) : [];
};

// The subagent transcripts of a session: <project>/<sessionId>/subagents/agent-<id>.jsonl, by agent id.
export const subagentTranscripts = (sessionId) => {
  const file = transcriptFile(sessionId);
  const dir = file ? path.join(path.dirname(file), sessionId, 'subagents') : null;
  if (!dir || !fs.existsSync(dir)) {
    return {};
  }
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((name) => /^agent-.+\.jsonl$/u.test(name))
      .map((name) => [name.replace(/^agent-|\.jsonl$/gu, ''), readJsonLines(path.join(dir, name))])
  );
};

// The text of a transcript row's message content.
export const rowText = (row) => {
  const content = row?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  return (Array.isArray(content) ? content : [])
    .map((block) =>
      block.type === 'text'
        ? block.text
        : block.type === 'tool_result'
          ? typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)
          : block.type === 'tool_use'
            ? `[tool_use ${block.name} ${JSON.stringify(block.input)}]`
            : ''
    )
    .join('\n');
};

// Moves the dump files of these sessions out of ~/.claude/watchdog/dumps/ into <run>/logs/dumps/ (the probe made
// them). Resolves [{ file, sessionId, text }], oldest first.
export const collectDumps = (run, sessionIds) => {
  if (!fs.existsSync(DUMPS_DIR)) {
    return [];
  }
  const target = path.join(run.logs, 'dumps');
  const ids = [...sessionIds].filter(Boolean);
  const names = fs
    .readdirSync(DUMPS_DIR)
    .filter((name) => ids.some((id) => name.startsWith(`${id}-`)))
    .sort();
  if (names.length > 0) {
    fs.mkdirSync(target, { recursive: true });
  }
  return names.map((name) => {
    const file = path.join(target, name);
    fs.copyFileSync(path.join(DUMPS_DIR, name), file);
    fs.rmSync(path.join(DUMPS_DIR, name));
    return { file, sessionId: ids.find((id) => name.startsWith(`${id}-`)), text: fs.readFileSync(file, 'utf8') };
  });
};

// Moves each dump whose session id (the first 36 characters of its name) shows in a log file of the run: a probe
// session wrote it. probe.mjs calls it after each scenario, so no probe dump stays in the person's dumps folder.
export const sweepDumps = (run) => {
  if (!fs.existsSync(DUMPS_DIR) || !fs.existsSync(run.logs)) {
    return [];
  }
  const logs = fs
    .readdirSync(run.logs, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => fs.readFileSync(path.join(run.logs, entry.name), 'utf8'));
  const ids = fs
    .readdirSync(DUMPS_DIR)
    .map((name) => name.slice(0, 36))
    .filter((id) => logs.some((text) => text.includes(id)));
  return collectDumps(run, new Set(ids));
};

// Copies a dump that a `/watchdog dump` reply named into the run, then removes the original.
export const takeDump = (run, file) => {
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  const target = path.join(run.logs, 'dumps', path.basename(file));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  fs.rmSync(file);
  return { file: target, text: fs.readFileSync(target, 'utf8') };
};

// The review records of a dump (§13.4): `### <time> · <watchdog> · review <agentId>` blocks.
export const dumpReviews = (text) =>
  text
    .split(/^### /mu)
    .slice(1)
    .filter((block) => / · review /u.test(block.split('\n')[0]))
    .map((block) => {
      const head = block.split('\n')[0];
      const field = (name) => block.match(new RegExp(`^- ${name}: (.*)$`, 'mu'))?.[1] ?? null;
      return {
        head,
        watchdog: head.split(' · ')[1] ?? null,
        agentId: head.match(/ · review (\S+)/u)?.[1] ?? null,
        model: field('model'),
        end: field('end'),
        usage: field('usage'),
        cost: field('cost'),
        error: field('error'),
        notes: field('notes'),
        text: block,
      };
    });
