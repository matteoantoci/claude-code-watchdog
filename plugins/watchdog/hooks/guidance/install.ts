import { currentRosterConfig, watchdogBySlug } from '../agents/roster';
import { agentType } from '../agents/spec';
import { frozenGuidance, isRegistered, setFrozenReads, setRegistered } from './memory';
import { fullPrompt, isContextType, soleRepoChild } from './prompt';
import type { OnEvents } from '../on';
import type { Frozen } from './memory';
import type { ContextFile, Fragments } from './prompt';
import type { EngineInterface, Hook } from 'claude-code';

// §8.2: the shipped fragments, read at the register of `/watchdog on` (§8.1).
const readFragments = async ($: EngineInterface): Promise<Fragments> => {
  const read = async (name: string): Promise<string> => $.fs.read(`${$.plugin.root}/prompts/${name}`);
  const [context, memory, activeRepo] = await Promise.all([
    read('context-files.md'),
    read('memory-context.md'),
    read('active-repo-watchdog.md'),
  ]);
  return { context, memory, activeRepo };
};

// Build-session choice "Prompt fragments": outside git, the one direct child of the cwd that has a `.git`.
const readRepoChild = async ($: EngineInterface): Promise<string | null> => {
  if ((await $.session.repo()) !== null) {
    return null;
  }
  const cwd = await $.session.cwd();
  const entries = await $.fs.list(cwd).catch(() => []);
  const children = await Promise.all(
    entries
      .filter((entry) => entry.kind === 'dir')
      .map(async ({ name }) => ({ name, hasGit: await $.fs.exists(`${cwd}/${name}/.git`).catch(() => false) }))
  );
  return soleRepoChild(children);
};

// §4.5: what `/watchdog on` froze; its first register reads the fragments and the repo child.
const readFrozen = async ($: EngineInterface): Promise<Required<Frozen>> => {
  const frozen = frozenGuidance();
  if (frozen.reads !== undefined) {
    return { guidance: frozen.guidance, reads: frozen.reads };
  }
  const [fragments, repoChild] = await Promise.all([readFragments($), readRepoChild($)]);
  setFrozenReads({ fragments, repoChild });
  return { guidance: frozen.guidance, reads: { fragments, repoChild } };
};

// §8.2: the session's memory files of now, each read with `$.fs.read`; a file that does not read is left out.
const readContext = async ($: EngineInterface): Promise<ContextFile[]> => {
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined);
  const files = (usage?.context.breakdown?.memoryFiles ?? []).filter((file) => isContextType(file.type));
  const read = await Promise.all(
    files.map(async ({ path, type }) =>
      $.fs.read(path).then(
        (content) => [{ path, type, content }],
        () => []
      )
    )
  );
  return read.flat();
};

// §4.5, §8.1: each register of a watchdog type by the mod (at `/watchdog on` and before each spawn) gets the
// full system prompt: the parts after the base the caller filled, the context of now among them. Only a spec
// that differs from the last one registered reaches the engine; an unchanged spec is a no-op.
const onRegister: Hook<'agent.register'> = async ($, e, next) => {
  const watchdog = watchdogBySlug(e.name);
  if (next.origin.plugin !== 'watchdog' || watchdog === undefined) {
    return next(e);
  }
  const [frozen, contextFiles] = await Promise.all([readFrozen($), readContext($)]);
  const spec = {
    ...e,
    prompt: fullPrompt({
      base: e.prompt,
      fragments: frozen.reads.fragments,
      contextFiles,
      tools: watchdog.tools,
      guidance: frozen.guidance,
      repoChild: frozen.reads.repoChild,
      rosterInstructions: currentRosterConfig().instructions,
      instructions: watchdog.instructions,
    }),
  };
  if (isRegistered(spec)) {
    return { value: { agent: agentType(e.name) } };
  }
  const result = await next(spec);
  if (!('deny' in result)) {
    setRegistered(spec);
  }
  return result;
};

export const installGuidance = (on: OnEvents<'agent.register'>): void => {
  on('agent.register', onRegister);
};
