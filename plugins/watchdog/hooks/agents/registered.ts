import type { AgentSpec } from 'claude-code';

// §4.5, §6.1: the spec each watchdog type was last registered with, by type name, in module memory. The mod
// registers again before a spawn only when the spec it builds differs.
const specs = new Map<string, AgentSpec>();

export const registeredSpec = (name: string): AgentSpec | undefined => specs.get(name);

export const setRegisteredSpec = (spec: AgentSpec): void => {
  specs.set(spec.name, spec);
};
