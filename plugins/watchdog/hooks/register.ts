import { installCommand } from './command/install';
import { installLifecycle } from './lifecycle/install';
import type { Register } from 'claude-code';

export const register: Register = (on) => {
  installCommand(on);
  installLifecycle(on);
};
