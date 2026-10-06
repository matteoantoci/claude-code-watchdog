import type { EventName, Hook, MatchedHook, MatcherFor, Registration } from 'claude-code';

// `On` narrowed to the events one file hooks or stubs. Type each `installX(on)` and each test's `on` with it:
// a call on the full `On` costs `typescript/no-misused-promises` about 26 s per file, this type well under 1 s.
// `register.ts` passes the full `On`, which tsc checks against this type. The Registration carries `.catch`.
export type OnEvents<E extends EventName> = {
  <P extends E>(pattern: P, hook: NoInfer<Hook<P>>): Registration<Hook<P>>;
  <P extends E, const M extends MatcherFor<P>>(
    pattern: P,
    matcher: M,
    hook: NoInfer<MatchedHook<P, M>>
  ): Registration<MatchedHook<P, M>>;
};
