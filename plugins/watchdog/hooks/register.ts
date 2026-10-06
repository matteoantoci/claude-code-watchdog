import { installAgents } from './agents/install';
import { installCommand } from './command/install';
import { installDelivery } from './delivery/install';
import { installDump } from './dump/install';
import { installFeed } from './feed/install';
import { installLifecycle } from './lifecycle/install';
import { installLog } from './log/install';
import { installNote } from './note/install';
import { installReview } from './review/install';
import { installRoster } from './roster/install';
import { installTools } from './tools/install';
import type { Register } from 'claude-code';

export const register: Register = (on, options) => {
  installRoster(on);
  installCommand(on, options);
  installDump(on);
  installLifecycle(on);
  installAgents(on);
  installFeed(on);
  installReview(on);
  installLog(on);
  installNote(on);
  installDelivery(on);
  installTools(on);
};
