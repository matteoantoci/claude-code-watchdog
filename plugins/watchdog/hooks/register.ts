import { installAgents } from './agents/install';
import { installCommand } from './command/install';
import { installDelivery } from './delivery/install';
import { installFeed } from './feed/install';
import { installLifecycle } from './lifecycle/install';
import { installLog } from './log/install';
import { installNote } from './note/install';
import { installReview } from './review/install';
import { installTools } from './tools/install';
import type { Register } from 'claude-code';

export const register: Register = (on, options) => {
  installCommand(on, options);
  installLifecycle(on);
  installAgents(on);
  installFeed(on);
  installReview(on);
  installLog(on);
  installNote(on);
  installDelivery(on);
  installTools(on);
};
