import { describe, expect, test } from 'claude-code/testing';
import { PERSON_PROMPT, TASK_NOTIFICATION, sendNote, startReview, stubDelivery, wrapped } from './fixtures/delivery';
import type { DeliveryStubs } from './fixtures/delivery';

const NIT = 'parseDate drops the timezone';

describe('aside', () => {
  test('a nit goes into the context of the next person prompt on the way down, once', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await sendNote($, 'nit', NIT);
    expect(seen.logs.at(-1)).toBe(`[nit] default: ${NIT} (aside on next prompt)`);

    await $.prompt.submit({ ...PERSON_PROMPT, context: ['the IDE selection'] });
    expect(seen.prompts.at(-1)?.context).toEqual(['the IDE selection', wrapped(`<note severity="nit">${NIT}</note>`)]);

    await $.prompt.submit(PERSON_PROMPT);
    expect(seen.prompts.at(-1)?.context).toBeUndefined();
  });

  test('a task notification and a plugin prompt carry no aside; the nit waits for the person prompt', async ($, on: DeliveryStubs) => {
    const seen = stubDelivery(on);
    await startReview($);
    await sendNote($, 'nit', NIT);

    await $.prompt.submit(TASK_NOTIFICATION);
    await $.prompt.submit({ text: 'Lint the repo.', wait: false, origin: { kind: 'plugin', name: 'linter' } });
    expect(seen.prompts.map((prompt) => prompt.context)).toEqual([undefined, undefined]);

    await $.prompt.submit({ ...PERSON_PROMPT, origin: { kind: 'bridge' } });
    expect(seen.prompts.at(-1)?.context).toEqual([wrapped(`<note severity="nit">${NIT}</note>`)]);
  });
});
