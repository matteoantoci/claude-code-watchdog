// The repo installs no @types/node. These are the few Node APIs the scripts use.
declare module 'node:fs' {
  export function readdirSync(path: string, options: { recursive: true }): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
}

declare module 'node:path' {
  export function join(...paths: string[]): string;
}

declare const process: { exitCode: number | undefined };
declare const console: { error: (message: string) => void };
