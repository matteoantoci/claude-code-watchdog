// The session's mode in module memory. `session.start` sets it again after each reload (spec §5.1, §14.6).
// The on flag and the on source go to `$.state` key `on` (§14.1).
export type Mode = 'off' | 'on' | 'unsupported';

const memory: { mode: Mode } = { mode: 'off' };

export const currentMode = (): Mode => memory.mode;

export const setMode = (mode: Mode): void => {
  memory.mode = mode;
};
