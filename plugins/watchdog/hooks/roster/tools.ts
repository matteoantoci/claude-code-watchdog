import { WATCHDOG_TOOL_NAMES } from '../agents/spec';

// §6.3: the default tools, and the only tools a project file grants.
const READ_ONLY_TOOLS: Readonly<Record<string, true>> = { Read: true, Grep: true, Glob: true };

// §6.3: never in a watchdog's tools, also from the user file.
const REFUSED_TOOLS: Readonly<Record<string, true>> = {
  ToolSearch: true,
  Agent: true,
  SendMessage: true,
  AskUserQuestion: true,
  Bash: true,
  Edit: true,
  Write: true,
  NotebookEdit: true,
};

// The built-in tools of Claude Code 2.1.290 (its `claude-code-tools` types), plus `Grep` and `Glob`: the main
// loop has neither, but an agent that lists them gets them (§6.3).
const BUILTIN_TOOLS = [
  'Agent',
  'AppifactRepl',
  'Artifact',
  'ArtifactCheck',
  'ArtifactComments',
  'ArtifactData',
  'AskUserQuestion',
  'Bash',
  'ClaudeDesign',
  'CronCreate',
  'CronDelete',
  'CronList',
  'DesignSync',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'FetchInboxMessage',
  'GetTask',
  'Glob',
  'Grep',
  'ListAgents',
  'ListConnectors',
  'ListMcpResourcesTool',
  'ListPlugins',
  'ListSkills',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'OfferChromeSetup',
  'Poll',
  'Projects',
  'ProposeGoal',
  'PushNotification',
  'Read',
  'ReadMcpResourceDirTool',
  'ReadMcpResourceTool',
  'ReadNotifications',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SearchMcpRegistry',
  'SearchPlugins',
  'SearchSkills',
  'SendFeedback',
  'SendFile',
  'SendMessage',
  'SendUserFile',
  'SendUserMessage',
  'ShareOnboardingGuide',
  'ShowOnboardingRolePicker',
  'Skill',
  'SuggestConnectors',
  'SuggestPluginInstall',
  'SuggestSkills',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
];

const BUILTIN_BY_LOWERCASE = new Map(BUILTIN_TOOLS.map((tool) => [tool.toLowerCase(), tool]));

const MCP_TOOL = /^mcp__.+__.+$/u;

// §6.3: a lowercase built-in name counts as the tool name (`read` is `Read`).
const toolName = (name: string): string =>
  name === name.toLowerCase() ? (BUILTIN_BY_LOWERCASE.get(name) ?? name) : name;

// §4.6, §6.3: why a tool is dropped, or undefined when the file may grant it.
const toolProblem = (tool: string, isUser: boolean): string | undefined => {
  if (Object.hasOwn(REFUSED_TOOLS, tool)) {
    return `tool "${tool}" is refused; tool dropped`;
  }
  if (BUILTIN_BY_LOWERCASE.get(tool.toLowerCase()) !== tool && !MCP_TOOL.test(tool)) {
    return `unknown tool "${tool}"; tool dropped`;
  }
  if (!isUser && !Object.hasOwn(READ_ONLY_TOOLS, tool)) {
    return `a project file grants only Read, Grep and Glob; tool "${tool}" dropped`;
  }
  return undefined;
};

// §6.3: the tools an entry gets from the file that holds it, and a warning for each tool it drops. The mod
// always adds its `note` and `resolve` tools, so a listed one is left out here.
export const checkTools = (
  names: readonly string[],
  isUser: boolean
): { tools: readonly string[]; problems: readonly string[] } => {
  const named = names.map(toolName).filter((tool) => !WATCHDOG_TOOL_NAMES.includes(tool));
  const problems = named.map((tool) => toolProblem(tool, isUser));
  return {
    tools: [...new Set(named.filter((_tool, index) => problems[index] === undefined))],
    problems: problems.filter((problem) => problem !== undefined),
  };
};
