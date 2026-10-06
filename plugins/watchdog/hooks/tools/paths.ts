// §6.5 item 3: the read scope compares paths as strings, because the mod cannot resolve a symlink.

const ROOT = '/';

// One segment onto the segments so far; undefined once an absolute path went above `/`.
const addSegment = (segments: readonly string[] | undefined, segment: string, isAbsolute: boolean) => {
  if (segments === undefined || segment === '' || segment === '.') {
    return segments;
  }
  if (segment !== '..') {
    return [...segments, segment];
  }
  if (segments.length > 0 && segments.at(-1) !== '..') {
    return segments.slice(0, -1);
  }
  return isAbsolute ? undefined : [...segments, segment];
};

// `.` and `..` resolved, repeated and trailing slashes dropped. A relative path keeps its leading `..`.
// Undefined for an absolute path that goes above `/` at any point.
export const normalizePath = (path: string): string | undefined => {
  const isAbsolute = path.startsWith(ROOT);
  const segments = path
    .split(ROOT)
    .reduce<readonly string[] | undefined>((kept, segment) => addSegment(kept, segment, isAbsolute), []);
  if (segments === undefined) {
    return undefined;
  }
  const joined = segments.join(ROOT);
  if (isAbsolute) {
    return `${ROOT}${joined}`;
  }
  return joined === '' ? '.' : joined;
};
