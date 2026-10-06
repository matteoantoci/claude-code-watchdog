import { MIN_CLAUDE_CODE_VERSION } from '../constants';
import type { CommandSpec } from 'claude-code';

export const COMMAND: CommandSpec = {
  name: 'watchdog',
  description: 'Watchdog reviews of this session: on, off, status, dump',
  argumentHint: 'on|off|status|dump [raw]',
  immediate: true,
};

export const UNSUPPORTED_REPLY = `needs Claude Code ${MIN_CLAUDE_CODE_VERSION} or later; update the Claude app`;

export const USAGE_REPLY = 'usage: /watchdog [on|off|status|dump [raw]]';
