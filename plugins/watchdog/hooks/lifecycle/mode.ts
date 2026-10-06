// The session's mode in module memory. `session.start` sets it again after each reload (spec §5.1, §14.6).
// The on flag and the on source go to `$.state` key `on` (§14.1).
export type Mode = 'off' | 'on' | 'unsupported';

// Each `setMode` starts a new period: `/watchdog on` and `/watchdog off` start the feeds again (§5.2).
const memory: { mode: Mode; period: number } = { mode: 'off', period: 0 };

export const currentMode = (): Mode => memory.mode;

export const currentPeriod = (): number => memory.period;

export const setMode = (mode: Mode): void => {
  memory.mode = mode;
  memory.period += 1;
};
