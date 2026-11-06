// Pure decision table: given a candidate's current track/attempt and an event, decide the
// next action and next track. No I/O, no dates, no Paycor knowledge — fully unit-testable.
// scheduler.js turns this decision into a real action; timers.js decides which events are due.
//
// Adapted from Paycor-Outreach-Toolkit/src/engine/trackMachine.js — the only change is the
// FLUENCY track's 'submitted' outcome, which now goes to ACTION.AUTO_SCORE_FLUENCY /
// TRACK.SCORECARD_SUBMITTED instead of ACTION.REQUEST_SCORECARD /
// TRACK.AWAITING_MANAGER_REVIEW. Whether the recording was actually ratable (and therefore
// whether the scorecard gets submitted or the candidate still ends up in manual review) is an
// execution-time fact the scheduler layers on top of this decision — see scheduler.js's
// handling of executeAction's `needsManual` result. This file stays pure.

const { TRACK, ACTION, PASS_REASON } = require('./constants');

/**
 * @param {{track: string, attempt: number}} candidate
 * @param {{type: 'NEW_CANDIDATE'} | {type: 'REPLY_RECEIVED', outcome: 'pass'|'fail'|'query'|'submitted'} | {type: 'TIMER_DUE_REMINDER'} | {type: 'TIMER_DUE_TIMEOUT'}} event
 * @returns {{action: string, nextTrack: string, attempt?: number, passReason?: string, error?: string}}
 */
function nextAction(candidate, event) {
  switch (event.type) {
    case 'NEW_CANDIDATE':
      return handleNewCandidate(candidate);
    case 'REPLY_RECEIVED':
      return handleReplyReceived(candidate, event.outcome);
    case 'TIMER_DUE_REMINDER':
      return handleTimerDueReminder(candidate);
    case 'TIMER_DUE_TIMEOUT':
      return handleTimerDueTimeout(candidate);
    default:
      return { action: ACTION.NONE, nextTrack: candidate.track, error: `unknown event type: ${event.type}` };
  }
}

function handleNewCandidate(candidate) {
  if (candidate.track !== TRACK.NEW) {
    return { action: ACTION.NONE, nextTrack: candidate.track, error: `NEW_CANDIDATE event on non-NEW track: ${candidate.track}` };
  }
  return { action: ACTION.SEND_FIRST_CONTACT, nextTrack: TRACK.FIRST_CONTACT, attempt: 0 };
}

function handleReplyReceived(candidate, outcome) {
  // A question mark / ambiguous reply on any classification-bearing track always goes to a
  // human — never auto-acted, regardless of which track produced it.
  if (outcome === 'query') {
    return { action: ACTION.FLAG_MANUAL_REVIEW, nextTrack: TRACK.MANUAL_REVIEW };
  }

  switch (candidate.track) {
    case TRACK.FIRST_CONTACT:
    case TRACK.FIRST_CONTACT_REMINDED:
      if (outcome === 'pass') {
        return { action: ACTION.SEND_FLUENCY, nextTrack: TRACK.FLUENCY, attempt: 0 };
      }
      return { action: ACTION.SEND_ATTENTION_1, nextTrack: TRACK.ATTENTION_1, attempt: 1 };

    case TRACK.ATTENTION_1:
    case TRACK.ATTENTION_1_REMINDED:
      if (outcome === 'pass') {
        return { action: ACTION.SEND_FLUENCY, nextTrack: TRACK.FLUENCY, attempt: 0 };
      }
      return { action: ACTION.SEND_ATTENTION_2, nextTrack: TRACK.ATTENTION_2, attempt: 2 };

    case TRACK.ATTENTION_2:
    case TRACK.ATTENTION_2_REMINDED:
      if (outcome === 'pass') {
        return { action: ACTION.SEND_FLUENCY, nextTrack: TRACK.FLUENCY, attempt: 0 };
      }
      return { action: ACTION.PASS_OTHER_QUALIFIED, nextTrack: TRACK.PASSED, passReason: PASS_REASON.OTHER_QUALIFIED };

    case TRACK.FLUENCY:
    case TRACK.FLUENCY_REMINDED:
      // Fluency track doesn't use pass/fail content classification — any actual submission
      // (classifier outcome 'submitted') hands off to the free offline scorer.
      if (outcome === 'submitted') {
        return { action: ACTION.AUTO_SCORE_FLUENCY, nextTrack: TRACK.SCORECARD_SUBMITTED };
      }
      return { action: ACTION.FLAG_MANUAL_REVIEW, nextTrack: TRACK.MANUAL_REVIEW };

    default:
      return { action: ACTION.NONE, nextTrack: candidate.track, error: `REPLY_RECEIVED on unexpected track: ${candidate.track}` };
  }
}

function handleTimerDueReminder(candidate) {
  switch (candidate.track) {
    case TRACK.FIRST_CONTACT:
      return { action: ACTION.SEND_FIRST_CONTACT_REMINDER, nextTrack: TRACK.FIRST_CONTACT_REMINDED };
    case TRACK.ATTENTION_1:
      return { action: ACTION.SEND_ATTENTION_1_REMINDER, nextTrack: TRACK.ATTENTION_1_REMINDED };
    case TRACK.ATTENTION_2:
      return { action: ACTION.SEND_ATTENTION_2_REMINDER, nextTrack: TRACK.ATTENTION_2_REMINDED };
    case TRACK.FLUENCY:
      return { action: ACTION.SEND_FLUENCY_REMINDER, nextTrack: TRACK.FLUENCY_REMINDED };
    default:
      return { action: ACTION.NONE, nextTrack: candidate.track, error: `TIMER_DUE_REMINDER on unexpected track: ${candidate.track}` };
  }
}

function handleTimerDueTimeout(candidate) {
  switch (candidate.track) {
    case TRACK.FIRST_CONTACT_REMINDED:
    case TRACK.ATTENTION_1_REMINDED:
    case TRACK.ATTENTION_2_REMINDED:
    case TRACK.FLUENCY_REMINDED:
      return { action: ACTION.PASS_NO_RESPONSE, nextTrack: TRACK.PASSED, passReason: PASS_REASON.NO_RESPONSE };
    default:
      return { action: ACTION.NONE, nextTrack: candidate.track, error: `TIMER_DUE_TIMEOUT on unexpected track: ${candidate.track}` };
  }
}

module.exports = { nextAction };
