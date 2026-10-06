import { configDir } from '../dump/dump';

// §4.3: where the mod looks for `WATCHDOG.json` (and `WATCHDOG.md`, the same places), from what `$` gives.
export type Where = {
  // `CLAUDE_CONFIG_DIR` and `HOME`, unset as undefined.
  readonly configDir: string | undefined;
  readonly home: string | undefined;
  // `$.session.repo()?.root`: null outside git.
  readonly gitRoot: string | null;
  readonly cwd: string;
  // `$.session.root()`.
  readonly root: string;
};

export type SearchPath = { readonly path: string; readonly isUser: boolean };

// The mod cannot resolve a symlink, so paths compare as normalized strings: no empty or `.` segment, each
// `..` folded, no trailing slash.
export const normalizePath = (path: string): string => {
  const parts = path.split('/').reduce<string[]>((kept, part) => {
    if (part === '' || part === '.') {
      return kept;
    }
    return part === '..' ? kept.slice(0, -1) : kept.concat(part);
  }, []);
  return `${path.startsWith('/') ? '/' : ''}${parts.join('/')}`;
};

const join = (dir: string, name: string): string => normalizePath(`${dir}/${name}`);

// The part of `path` below `dir`, or undefined when `path` is not below it.
const below = (path: string, dir: string): string | undefined => {
  const prefix = dir.endsWith('/') ? dir : `${dir}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
};

// Each directory from `top` down to `bottom`, `top` first.
const dirsDown = (top: string, bottom: string): string[] =>
  (below(bottom, top) ?? '')
    .split('/')
    .filter((part) => part !== '')
    .reduce<string[]>((dirs, part) => dirs.concat(join(dirs.at(-1) ?? top, part)), [top]);

// §4.3: from the git root down to the cwd; outside git only the session root. A cwd outside the git root
// (`repo().root` is the main working tree's, also for a worktree elsewhere) counts as outside git.
const projectDirs = (where: Where): string[] => {
  const cwd = normalizePath(where.cwd);
  const gitRoot = where.gitRoot === null ? undefined : normalizePath(where.gitRoot);
  const isInGit = gitRoot !== undefined && (cwd === gitRoot || below(cwd, gitRoot) !== undefined);
  return isInGit ? dirsDown(gitRoot, cwd) : [normalizePath(where.root)];
};

// §4.3: the user file first, then for each project directory `.claude/<name>` and `<name>`. The walk skips
// the user file, so it loads once, as the user file. `<config>` follows the dump's rule (§13.4).
export const searchPaths = (where: Where, name: string): SearchPath[] => {
  const config = configDir(where.configDir, where.home);
  const userPath = config === undefined ? undefined : join(config, name);
  const project = projectDirs(where)
    .flatMap((dir) => [join(dir, `.claude/${name}`), join(dir, name)])
    .filter((path) => path !== userPath)
    .map((path) => ({ path, isUser: false }));
  return userPath === undefined ? project : [{ path: userPath, isUser: true }, ...project];
};

// §13.3: how the status and the warnings name a file: `./…` under the cwd, `~/…` under `$HOME`, else in full.
export const displayPath = (path: string, where: Where): string => {
  const inCwd = below(path, normalizePath(where.cwd));
  if (inCwd !== undefined) {
    return `./${inCwd}`;
  }
  const inHome = where.home === undefined || where.home === '' ? undefined : below(path, normalizePath(where.home));
  return inHome === undefined ? path : `~/${inHome}`;
};
