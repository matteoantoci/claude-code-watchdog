import type { LoadedFile } from '../roster/merge';
import type { Fragments } from './prompt';
import type { AgentSpec } from 'claude-code';

// What `/watchdog on` freezes (§4.5, §8.1): the `WATCHDOG.md` texts it read, then at its register the shipped
// fragments and the active-repo child (build-session choice "Prompt fragments": computed at register time).
export type Frozen = {
  readonly guidance: readonly string[];
  readonly reads?: { readonly fragments: Fragments; readonly repoChild: string | null };
};

const memory: { frozen: Frozen; specs: Map<string, string> } = { frozen: { guidance: [] }, specs: new Map() };

// `/watchdog on`: the text of each `WATCHDOG.md` it read, in load order (§4.4; a missing or unreadable file
// has none). The next register reads the fragments and the repo child again.
export const freezeGuidance = (files: readonly LoadedFile[]): void => {
  memory.frozen = {
    guidance: files.flatMap(({ content }) => (content !== undefined && 'text' in content ? [content.text] : [])),
  };
};

export const frozenGuidance = (): Frozen => memory.frozen;

export const setFrozenReads = (reads: NonNullable<Frozen['reads']>): void => {
  memory.frozen = { ...memory.frozen, reads };
};

// §4.5: the full spec each watchdog type was last registered with, by type name, as JSON.
export const isRegistered = (spec: AgentSpec): boolean => memory.specs.get(spec.name) === JSON.stringify(spec);

export const setRegistered = (spec: AgentSpec): void => {
  memory.specs.set(spec.name, JSON.stringify(spec));
};
