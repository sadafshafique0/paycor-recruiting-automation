const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextAction } = require('../src/engine/trackMachine');
const { TRACK, ACTION } = require('../src/engine/constants');

test('NEW candidate -> First Contact', () => {
  const decision = nextAction({ track: TRACK.NEW, attempt: 0 }, { type: 'NEW_CANDIDATE' });
  assert.equal(decision.action, ACTION.SEND_FIRST_CONTACT);
  assert.equal(decision.nextTrack, TRACK.FIRST_CONTACT);
});

test('NEW_CANDIDATE event on a non-NEW track is rejected, not silently applied', () => {
  const decision = nextAction({ track: TRACK.FIRST_CONTACT, attempt: 0 }, { type: 'NEW_CANDIDATE' });
  assert.equal(decision.action, ACTION.NONE);
  assert.match(decision.error, /non-NEW track/);
});

test('First Contact reply pass -> Fluency', () => {
  const decision = nextAction({ track: TRACK.FIRST_CONTACT, attempt: 0 }, { type: 'REPLY_RECEIVED', outcome: 'pass' });
  assert.equal(decision.action, ACTION.SEND_FLUENCY);
  assert.equal(decision.nextTrack, TRACK.FLUENCY);
});

test('First Contact reply fail -> Attention to Detail attempt 1', () => {
  const decision = nextAction({ track: TRACK.FIRST_CONTACT, attempt: 0 }, { type: 'REPLY_RECEIVED', outcome: 'fail' });
  assert.equal(decision.action, ACTION.SEND_ATTENTION_1);
  assert.equal(decision.nextTrack, TRACK.ATTENTION_1);
});

test('any reply with outcome=query is flagged for manual review regardless of track', () => {
  for (const track of [TRACK.FIRST_CONTACT, TRACK.ATTENTION_2, TRACK.FLUENCY_REMINDED]) {
    const decision = nextAction({ track, attempt: 0 }, { type: 'REPLY_RECEIVED', outcome: 'query' });
    assert.equal(decision.action, ACTION.FLAG_MANUAL_REVIEW);
    assert.equal(decision.nextTrack, TRACK.MANUAL_REVIEW);
  }
});

test('Attention-to-Detail attempt 2 reply still failing -> Pass (other candidates more qualified)', () => {
  const decision = nextAction({ track: TRACK.ATTENTION_2, attempt: 2 }, { type: 'REPLY_RECEIVED', outcome: 'fail' });
  assert.equal(decision.action, ACTION.PASS_OTHER_QUALIFIED);
  assert.equal(decision.nextTrack, TRACK.PASSED);
});

test('Fluency submission -> AUTO_SCORE_FLUENCY, terminal track SCORECARD_SUBMITTED (not a human handoff)', () => {
  const decision = nextAction({ track: TRACK.FLUENCY, attempt: 0 }, { type: 'REPLY_RECEIVED', outcome: 'submitted' });
  assert.equal(decision.action, ACTION.AUTO_SCORE_FLUENCY);
  assert.equal(decision.nextTrack, TRACK.SCORECARD_SUBMITTED);
});

test('Fluency track reply that is not a real submission -> manual review, not silently dropped', () => {
  const decision = nextAction({ track: TRACK.FLUENCY, attempt: 0 }, { type: 'REPLY_RECEIVED', outcome: 'query' });
  assert.equal(decision.action, ACTION.FLAG_MANUAL_REVIEW);
});

test('TIMER_DUE_TIMEOUT on a track with no reminder yet is rejected, not treated as a pass', () => {
  const decision = nextAction({ track: TRACK.FIRST_CONTACT, attempt: 0 }, { type: 'TIMER_DUE_TIMEOUT' });
  assert.equal(decision.action, ACTION.NONE);
  assert.match(decision.error, /unexpected track/);
});

test('unknown event type is rejected with an error, not treated as a no-op success', () => {
  const decision = nextAction({ track: TRACK.NEW, attempt: 0 }, { type: 'BOGUS' });
  assert.equal(decision.action, ACTION.NONE);
  assert.match(decision.error, /unknown event type/);
});
