import { FNV_OFFSET_BASIS, FNV_PRIME } from './constants';

// §14.4, §10.8: the 32-bit FNV-1a hash of a text, for the rewind mark of a message and the id of an open note.
export const fnv1a = (text: string): number =>
  Array.from(text).reduce(
    (hash, char) => Math.imul(hash ^ (char.codePointAt(0) ?? 0), FNV_PRIME) >>> 0,
    FNV_OFFSET_BASIS
  );
