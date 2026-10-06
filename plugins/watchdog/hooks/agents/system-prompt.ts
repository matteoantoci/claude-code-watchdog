import type { Watchdog } from './roster';

// §8.1: fills the shipped base prompt `prompts/system.md`. omp renders it with Handlebars; the mod fills
// it with its own code (§8.2). The tool sentence replaces omp's `Default read-only: …` and lists the
// agent's real tools.
export const systemPrompt = (base: string, watchdog: Watchdog): string => {
  const tools = watchdog.tools.map((tool) => `\`${tool}\``).join(', ');
  return base
    .replaceAll('{{tool_sentence}}', `Granted tools: ${tools === '' ? 'none' : tools}.`)
    .replaceAll('{{max_notes_per_review}}', String(watchdog.maxNotesPerReview));
};
