// Starts ../proxy.mjs for one run: its folder is <run>/proxy (proxy-mode.json, proxy.log, req/), its port free.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROBE_DIR, sleep } from './env.mjs';

// The text of prompts/system.md that marks a watchdog agent's request (the real system prompt carries no probe
// marker; prototypes/failure-probe used `WDFAIL-AGENT-SYSTEM`).
export const WATCHDOG_MARK = 'peer-shadow primary agent';

const parseLine = (line) => {
  const space = line.indexOf(' ');
  try {
    return { time: line.slice(0, space), ...JSON.parse(line.slice(space + 1)) };
  } catch {
    return null;
  }
};

export const startProxy = async (run, mode = {}) => {
  const dir = path.join(run.dir, 'proxy');
  fs.mkdirSync(dir, { recursive: true });
  const setMode = (next) => fs.writeFileSync(path.join(dir, 'proxy-mode.json'), JSON.stringify(next));
  setMode({ agentMark: WATCHDOG_MARK, ...mode });
  const child = spawn(process.execPath, [path.join(PROBE_DIR, 'proxy.mjs')], {
    env: { ...process.env, PROXY_DIR: dir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.ctx.children.add(child);
  child.stderr.pipe(fs.createWriteStream(path.join(dir, 'proxy.err')));
  const portFile = path.join(dir, 'proxy-port');
  for (let waited = 0; !fs.existsSync(portFile); waited += 100) {
    if (waited > 10_000 || child.exitCode !== null) {
      throw new Error(`the proxy did not start: ${fs.readFileSync(path.join(dir, 'proxy.err'), 'utf8')}`);
    }
    await sleep(100);
  }
  const port = Number(fs.readFileSync(portFile, 'utf8'));
  return {
    dir,
    port,
    // §16.3: a proxy run sets ENABLE_TOOL_SEARCH=true, else a non-first-party base URL sends every tool's schema.
    env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ENABLE_TOOL_SEARCH: 'true' },
    setMode: (next) => setMode({ agentMark: WATCHDOG_MARK, ...next }),
    log: () =>
      (fs.existsSync(path.join(dir, 'proxy.log')) ? fs.readFileSync(path.join(dir, 'proxy.log'), 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map(parseLine)
        .filter(Boolean),
    bodies: () => {
      const req = path.join(dir, 'req');
      return fs.existsSync(req)
        ? fs
            .readdirSync(req)
            .sort()
            .map((name) => ({
              id: Number(name.slice(0, -'.json'.length)),
              body: JSON.parse(fs.readFileSync(path.join(req, name), 'utf8')),
            }))
        : [];
    },
    stop: () => {
      child.kill('SIGTERM');
      run.ctx.children.delete(child);
    },
  };
};
