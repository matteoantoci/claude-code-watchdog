const SUBCOMMANDS = ['on', 'off', 'status', 'dump', 'dump raw'] as const;

export type Subcommand = (typeof SUBCOMMANDS)[number] | 'unknown';

const isSubcommand = (text: string): text is (typeof SUBCOMMANDS)[number] =>
  SUBCOMMANDS.some((subcommand) => subcommand === text);

// §5.1: a bare `/watchdog` shows the status.
export const parseSubcommand = (args: string): Subcommand => {
  const text = args.trim().split(/\s+/u).join(' ').toLowerCase();
  if (text === '') {
    return 'status';
  }
  return isSubcommand(text) ? text : 'unknown';
};
