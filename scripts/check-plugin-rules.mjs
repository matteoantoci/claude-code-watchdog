/// <reference path="./node-builtins.d.ts" />
// Fails when plugin hook code reads the wall clock. Time comes only from `$.clock`.
// `new Date(value)` stays allowed: it formats a time that already came from `$.clock`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = 'plugins/watchdog/hooks';
const rules = [
  { pattern: /\bDate\.now\(/u, message: 'Date.now() reads the wall clock; use $.clock' },
  { pattern: /\bnew Date\(\s*\)/u, message: 'new Date() reads the wall clock; use $.clock' },
];

/** @param {string} file @param {string} line @param {number} index */
const lineHits = (file, line, index) =>
  rules.filter((rule) => rule.pattern.test(line)).map((rule) => `${file}:${index + 1}: ${rule.message}`);

/** @param {string} file */
const fileHits = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => lineHits(file, line, index));

const hits = readdirSync(root, { recursive: true })
  .filter((name) => name.endsWith('.ts'))
  .flatMap((name) => fileHits(join(root, name)));

for (const hit of hits) {
  console.error(hit);
}
process.exitCode = hits.length > 0 ? 1 : 0;
