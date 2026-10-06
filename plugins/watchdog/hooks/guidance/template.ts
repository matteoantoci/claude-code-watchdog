// §8.2: omp fills its prompt fragments with Handlebars; the mod has no npm packages, so it fills the two forms
// the fragments use. A value goes in as written: it is never scanned for a placeholder again.

// Each `{{name}}` with its value; a name with no value stays as written.
export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replaceAll(/\{\{(?<name>\w+)\}\}/gu, (whole, name: string) => values[name] ?? whole);

// The body between a `{{#each <list>}}` line and its `{{/each}}` line, filled once for each item; the two
// lines go, as a standalone Handlebars block's do.
export const fillEach = (
  template: string,
  list: string,
  items: readonly Readonly<Record<string, string>>[]
): string => {
  const open = `{{#each ${list}}}\n`;
  const start = template.indexOf(open);
  const end = template.indexOf('{{/each}}\n', start);
  if (start === -1 || end === -1) {
    return template;
  }
  const body = template.slice(start + open.length, end);
  const filled = items.map((item) => fill(body, item)).join('');
  return `${template.slice(0, start)}${filled}${template.slice(end + '{{/each}}\n'.length)}`;
};
