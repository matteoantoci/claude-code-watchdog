import { MIN_CLAUDE_CODE_VERSION } from '../constants';

const RELEASE_CORE = /^(\d+)\.(\d+)\.(\d+)/u;

const parseCore = (version: string): readonly number[] | undefined => RELEASE_CORE.exec(version)?.slice(1).map(Number);

const compareCores = (left: readonly number[], right: readonly number[]): number =>
  left.map((part, index) => part - (right[index] ?? 0)).find((difference) => difference !== 0) ?? 0;

// §5.1: compare the numeric major.minor.patch core of `base`; a suffix such as `-dev` is ignored.
export const isSupportedVersion = (base: string | undefined): boolean => {
  const core = base === undefined ? undefined : parseCore(base);
  const minimum = parseCore(MIN_CLAUDE_CODE_VERSION) ?? [];
  return core === undefined || compareCores(core, minimum) >= 0;
};
