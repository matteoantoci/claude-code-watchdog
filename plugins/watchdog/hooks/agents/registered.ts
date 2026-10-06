import type { AgentSpec } from 'claude-code';

// §4.5, §6.1: the spec each watchdog type was last registered with, by type name, in module memory, as its
// caller built it (the guidance area's `agent.register` hook completes the prompt). Before a spawn the mod
// registers it again with the effort of now.
const specs = new Map<string, AgentSpec>();

export const registeredSpec = (name: string): AgentSpec | undefined => specs.get(name);

export const setRegisteredSpec = (spec: AgentSpec): void => {
  specs.set(spec.name, spec);
};
