// Test inputs made from the recorded engine inputs in ./engine/. Each keeps the recorded shape and changes only what
// a test needs: a row's uuid and text, the reply after the plugin names, the model in a reject. Spec §2 allows no
// `.json` import, so each recording is a typed const.
import { LOGGED_TEXT, LOG_NOTICE_ROW } from './engine/log-notice';
import { ALLOWLIST_REJECT, ALLOWLIST_REJECT_MODEL } from './engine/preflight-reject';
import { ALONE_REPLY, ALONE_TEXT, STATUS_OUTPUT, STATUS_REPLY } from './engine/status-output';
import type { SessionAppendInput } from 'claude-code';

// The part of a recorded text before its recorded tail.
const leadOf = (text: string, tail: string): string => {
  if (!text.endsWith(tail)) {
    throw new Error(`a recorded text does not end with ${tail}`);
  }
  return text.slice(0, text.length - tail.length);
};

// The part of a recorded text after its recorded lead.
const tailOf = (text: string, lead: string): string => {
  if (!text.startsWith(lead)) {
    throw new Error(`a recorded text does not start with ${lead}`);
  }
  return text.slice(lead.length);
};

// A recorded row with another uuid and one text block.
export const withText = (row: SessionAppendInput, uuid: string, text: string): SessionAppendInput => ({
  ...row,
  uuid,
  message: { ...row.message, content: [{ type: 'text', text }] },
});

// What the engine draws before a hook's reply in a `CommandOutput` row: `watchdog: ` with the mod alone, and
// `wdprobe+watchdog: ` with the probe's observer beside it.
export const ALONE = leadOf(ALONE_TEXT, ALONE_REPLY);

export const BESIDE = leadOf(STATUS_OUTPUT.text, STATUS_REPLY);

const NOTICE_LEAD = leadOf(LOG_NOTICE_ROW.message.content.map((block) => block.text).join(''), LOGGED_TEXT);

// The engine's notice echo of the mod's `$.ui.log` row `logged`.
export const noticeRow = (uuid: string, logged: string): SessionAppendInput =>
  withText(LOG_NOTICE_ROW, uuid, `${NOTICE_LEAD}${logged}`);

// The engine and the test kit both lead the reject of a `$` call with the plugin and the call.
const REJECT_LEAD = 'watchdog: $.model.complete: ';

const REJECT_REASON = tailOf(ALLOWLIST_REJECT, REJECT_LEAD);

// The reason of the allowlist reject of `model`, for the `preflightDeny` stub. Only the reject of an alias was
// recorded: for a full id the tests assume the same text.
export const allowlistDeny = (model: string): string =>
  REJECT_REASON.replace(`"${ALLOWLIST_REJECT_MODEL}"`, `"${model}"`);

// The message of that reject, as the mod reads it.
export const allowlistReject = (model: string): string => `${REJECT_LEAD}${allowlistDeny(model)}`;
