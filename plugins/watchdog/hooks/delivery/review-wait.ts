// §10.8: a late blocker with the outdated mark waits for a review of its watchdog before it nudges. Pure: the delivery
// hooks call it at the end of the 2 s wait and at the end of each review.
import { watchdogOf } from '../agents/ids';
import { changeHeldNotes, takeNotes } from '../note/notes';
import { batchedOf, editsSince } from '../note/outdated';
import { isReviewComing } from '../review/backlogs';
import { subagentOfReview } from '../subagents/watch';
import { isNudgePending, routeNow } from './nudge';
import type { HeldNote } from '../note/notes';

// §10.8: at the end of the 2 s wait, a late blocker with the outdated mark stays out of the nudge while a review of its
// watchdog runs, or is due on its watched agent: it waits as `held`, its card with the mark. A blocker whose wait ended
// never waits again.
const holdForReview = (note: HeldNote): HeldNote =>
  isNudgePending(note) &&
  note.severity === 'blocker' &&
  note.reviewWait === undefined &&
  editsSince(batchedOf(note)) > 0 &&
  isReviewComing(note.watchdog, note.subagent?.agentId)
    ? { ...note, delivery: 'held', reviewWait: 'waiting' }
    : note;

// §10.3, §10.8: the notes of the nudge that goes out now: each late note that waits for it, less the outdated blockers
// that wait for a review; they go out as `nudged`.
export const takeNudgeNotes = (): HeldNote[] => {
  changeHeldNotes(holdForReview);
  return takeNotes(['nudge pending'], 'nudged');
};

// §10.8: the end of the review `reviewAgentId` of the watchdog `slug` ends the wait of the watchdog's blocker that the
// review saw: on the same watched agent, by any review but the one that sent it, since each later one lists it in its
// recap (§7.7). It ends the wait too once no review of the watchdog runs or is due there. A review that retracted the
// blocker dropped it already; any other takes its route of now: a nudge while the blocker budget lasts (§10.4).
const endWait =
  (slug: string, reviewAgentId: string) =>
  (note: HeldNote): HeldNote => {
    if (note.reviewWait !== 'waiting' || note.watchdog !== slug) {
      return note;
    }
    const watched = note.subagent?.agentId;
    const isSeen = reviewAgentId !== note.agentId && subagentOfReview(reviewAgentId)?.agentId === watched;
    return isSeen || !isReviewComing(slug, watched) ? { ...note, delivery: routeNow(note), reviewWait: 'done' } : note;
  };

// §10.8: a `turn.complete` of a review agent of the mod (`agentId`); any other agent's ends no wait.
export const endReviewWaits = (agentId: string | undefined): void => {
  const slug = watchdogOf(agentId);
  if (slug !== undefined && agentId !== undefined) {
    changeHeldNotes(endWait(slug, agentId));
  }
};
