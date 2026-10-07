import { WATCHDOG_TOOL_NAMES } from '../agents/spec';
import { fill, fillEach } from './template';

// §8.2: the shipped fragments, as `prompts/context-files.md`, `memory-context.md` and `active-repo-watchdog.md`.
export type Fragments = { readonly context: string; readonly memory: string; readonly activeRepo: string };

// §8.2: a memory file of the session's context, with its text.
export type ContextFile = { readonly path: string; readonly type: string; readonly content: string };

// §8.2: `Project`, `User` and `Local` go in `<project-context>`, `AutoMem` in `<memory-context>`; `Managed`
// stays out, because `omitClaudeMd: true` keeps it in the agent's context.
const PROJECT_TYPES: Readonly<Record<string, true>> = { Project: true, User: true, Local: true };
const MEMORY_TYPE = 'AutoMem';

export const isContextType = (type: string): boolean => PROJECT_TYPES[type] === true || type === MEMORY_TYPE;

// §8.2: the sentence goes when the watchdog has no memory tools. Build-session choice "Prompt fragments": a
// memory tool is an `mcp__*` tool other than `note`.
const MEMORY_TOOL_SENTENCE =
  ' Memory tools referenced below are available to you only if they appear in your own tool list.';

// Build-session choice "Prompt fragments": the cwd outside git holds exactly 1 direct child with a `.git`.
export const soleRepoChild = (
  children: readonly { readonly name: string; readonly hasGit: boolean }[]
): string | null => {
  const repos = children.filter((child) => child.hasGit);
  return repos.length === 1 ? (repos[0]?.name ?? null) : null;
};

const projectContext = (template: string, files: readonly ContextFile[]): string => {
  const kept = files.filter((file) => PROJECT_TYPES[file.type] === true);
  return kept.length === 0
    ? ''
    : fillEach(
        template,
        'contextFiles',
        kept.map(({ path, content }) => ({ path, content }))
      ).trim();
};

const memoryContext = (template: string, files: readonly ContextFile[], tools: readonly string[]): string => {
  const texts = files
    .filter((file) => file.type === MEMORY_TYPE)
    .map((file) => file.content.trim())
    .filter((text) => text !== '');
  const hasMemoryTools = tools.some((tool) => tool.startsWith('mcp__') && !WATCHDOG_TOOL_NAMES.includes(tool));
  const kept = hasMemoryTools ? template : template.replace(MEMORY_TOOL_SENTENCE, '');
  return texts.length === 0 ? '' : fill(kept, { memoryInstructions: texts.join('\n\n') }).trim();
};

// §4.4: all `WATCHDOG.md` files in one `<attention>`, a blank line between them; omp puts the active-repo
// block after them, in the same place of the prompt.
const attention = (texts: readonly string[], activeRepo: string): string => {
  const joined = texts
    .map((text) => text.trim())
    .filter((text) => text !== '')
    .join('\n\n');
  const guidance = joined === '' ? '' : `Especially pay attention to:\n<attention>\n${joined}\n</attention>`;
  return [guidance, activeRepo].filter((part) => part !== '').join('\n\n');
};

// What the system prompt is built from: the filled base (§8.1), the parts frozen at `/watchdog on` and the
// context of now.
export type PromptParts = {
  readonly base: string;
  readonly fragments: Fragments;
  readonly contextFiles: readonly ContextFile[];
  readonly tools: readonly string[];
  readonly guidance: readonly string[];
  readonly repoChild: string | null;
  readonly rosterInstructions: string | null;
  readonly instructions: string | null;
};

// §8.1: base, project context, memory context, `WATCHDOG.md`, the roster `instructions`, then the watchdog's
// own; an empty part is left out, and a blank line parts the others.
export const fullPrompt = (parts: PromptParts): string =>
  [
    parts.base,
    projectContext(parts.fragments.context, parts.contextFiles),
    memoryContext(parts.fragments.memory, parts.contextFiles, parts.tools),
    attention(
      parts.guidance,
      parts.repoChild === null ? '' : fill(parts.fragments.activeRepo, { relativeRepoRoot: parts.repoChild }).trim()
    ),
    parts.rosterInstructions?.trim() ?? '',
    parts.instructions?.trim() ?? '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
