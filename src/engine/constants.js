// Org-wide doctrine: track names, actions, timer windows. Shared by every colleague's install.
// Per-pipeline specifics (template names, target statuses, manager contact) live in
// pipelines.js (personal config), never here.
//
// Extends Paycor-Outreach-Toolkit/src/engine/constants.js with one change: fluency submission
// no longer hands off to a human scorer (ACTION.REQUEST_SCORECARD, track AWAITING_MANAGER_REVIEW
// in the original toolkit). It now goes straight to ACTION.AUTO_SCORE_FLUENCY, which runs the
// free offline Whisper scorer from Paycor-fluency and fills+submits the scorecard itself — see
// src/fluency/. REQUEST_SCORECARD is kept only as the dashboard's manual-fallback action for
// when auto-scoring can't rate a candidate (no usable recording) — never chosen automatically.

const TRACK = Object.freeze({
  NEW: 'NEW',
  FIRST_CONTACT: 'FIRST_CONTACT',
  FIRST_CONTACT_REMINDED: 'FIRST_CONTACT_REMINDED',
  ATTENTION_1: 'ATTENTION_1',
  ATTENTION_1_REMINDED: 'ATTENTION_1_REMINDED',
  ATTENTION_2: 'ATTENTION_2',
  ATTENTION_2_REMINDED: 'ATTENTION_2_REMINDED',
  FLUENCY: 'FLUENCY',
  FLUENCY_REMINDED: 'FLUENCY_REMINDED',
  SCORECARD_SUBMITTED: 'SCORECARD_SUBMITTED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  PASSED: 'PASSED',
  ERROR: 'ERROR',
});

// Tracks where the candidate has been sent something and we are waiting on a first reply
// (i.e. no reminder sent yet for the current attempt).
const AWAITING_FIRST_REPLY_TRACKS = Object.freeze([
  TRACK.FIRST_CONTACT,
  TRACK.ATTENTION_1,
  TRACK.ATTENTION_2,
  TRACK.FLUENCY,
]);

// Tracks where a reminder has already gone out and we are waiting on the timeout window.
const AWAITING_AFTER_REMINDER_TRACKS = Object.freeze([
  TRACK.FIRST_CONTACT_REMINDED,
  TRACK.ATTENTION_1_REMINDED,
  TRACK.ATTENTION_2_REMINDED,
  TRACK.FLUENCY_REMINDED,
]);

// Terminal tracks — the engine takes no further timer/reply action once a candidate is here.
const TERMINAL_TRACKS = Object.freeze([
  TRACK.SCORECARD_SUBMITTED,
  TRACK.MANUAL_REVIEW,
  TRACK.PASSED,
]);

const ACTION = Object.freeze({
  SEND_FIRST_CONTACT: 'SEND_FIRST_CONTACT',
  SEND_FIRST_CONTACT_REMINDER: 'SEND_FIRST_CONTACT_REMINDER',
  SEND_ATTENTION_1: 'SEND_ATTENTION_1',
  SEND_ATTENTION_1_REMINDER: 'SEND_ATTENTION_1_REMINDER',
  SEND_ATTENTION_2: 'SEND_ATTENTION_2',
  SEND_ATTENTION_2_REMINDER: 'SEND_ATTENTION_2_REMINDER',
  SEND_FLUENCY: 'SEND_FLUENCY',
  SEND_FLUENCY_REMINDER: 'SEND_FLUENCY_REMINDER',
  PASS_NO_RESPONSE: 'PASS_NO_RESPONSE',
  PASS_OTHER_QUALIFIED: 'PASS_OTHER_QUALIFIED',
  AUTO_SCORE_FLUENCY: 'AUTO_SCORE_FLUENCY',
  REQUEST_SCORECARD: 'REQUEST_SCORECARD', // manual-fallback only — never chosen by trackMachine
  FLAG_MANUAL_REVIEW: 'FLAG_MANUAL_REVIEW',
  NONE: 'NONE',
});

const PASS_REASON = Object.freeze({
  NO_RESPONSE: 'noResponse',
  OTHER_QUALIFIED: 'otherQualified',
});

// Default timer windows in calendar days — confirm against real Paycor timelines before
// trusting this live (see docs/LIVE-VERIFICATION-CHECKLIST.md). Calendar days, not business
// days, same assumption Paycor-Outreach-Toolkit shipped with.
const DEFAULT_TIMER_CONFIG = Object.freeze({
  reminderAfterDays: 3,
  timeoutAfterReminderDays: 3,
});

// Resume-screening verdicts (src/screening/) — separate from the outreach TRACK/ACTION above
// because screening happens before a candidate ever enters this engine's state store.
const SCREENING_VERDICT = Object.freeze({
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  UNCERTAIN: 'UNCERTAIN', // routed to manual review, never guessed
});

const SCREENING_PASS_REASONS = Object.freeze([
  'Experience / Skills are not a match',
  'Job hopper',
  'Not located in our geo region (no relo)',
  'Poor Resume',
]);

// Paycor candidate IDs are hex strings (e.g. 8a7887a19fd3ba90019fdd408ef0063e). Anything else is
// a typo or a pasted name, and IDs get interpolated into Paycor URLs.
const CANDIDATE_ID_RE = /^[A-Za-z0-9]{1,64}$/;

module.exports = {
  CANDIDATE_ID_RE,
  TRACK,
  AWAITING_FIRST_REPLY_TRACKS,
  AWAITING_AFTER_REMINDER_TRACKS,
  TERMINAL_TRACKS,
  ACTION,
  PASS_REASON,
  DEFAULT_TIMER_CONFIG,
  SCREENING_VERDICT,
  SCREENING_PASS_REASONS,
};
