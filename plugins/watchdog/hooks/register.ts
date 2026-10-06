import { installAgents } from './agents/install';
import { installCommand } from './command/install';
import { installFeed } from './feed/install';
import { installLifecycle } from './lifecycle/install';
import { installNote } from './note/install';
import { installReview } from './review/install';
import type { Register } from 'claude-code';

export const register: Register = (on) => {
  installCommand(on);
  installLifecycle(on);
  installAgents(on);
  installFeed(on);
  installReview(on);
  installNote(on);
};
