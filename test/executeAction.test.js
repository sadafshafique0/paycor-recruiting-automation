const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../src/paycor-actions');
const fluencyScorer = require('../src/fluency/runFluencyScorer');
const { executeAction } = require('../src/engine/executeAction');
const { ACTION } = require('../src/engine/constants');
const { fakePage } = require('./fakePage');

const PIPELINE = {
  templates: { firstContactReminder: 'T1R', firstContact: 'T1' },
  targetStatuses: { firstContact: 'Preliminary Screen Attempt 1' },
  passReasons: { noResponse: 'No response from the candidate', otherQualified: 'x' },
  managerEmail: 'm@x.com',
};

const originals = { ...actions, runAnalyze: fluencyScorer.runAnalyze };
afterEach(() => {
  Object.assign(actions, originals);
  fluencyScorer.runAnalyze = originals.runAnalyze;
});

test('regression: a reminder is sent from the target candidate\'s own profile, not the last one visited', async () => {
  const page = fakePage();
  page.current = 'https://recruitingbypaycor.com/candidate/someoneElse';
  let urlWhenSent = null;
  actions.sendEmailAndAdvance = async (p) => {
    urlWhenSent = p.url();
    return { ok: true };
  };

  await executeAction(page, { action: ACTION.SEND_FIRST_CONTACT_REMINDER, pipeline: PIPELINE, candidateId: 'target123' });
  assert.equal(urlWhenSent, 'https://recruitingbypaycor.com/candidate/target123');
});

test('regression: a no-response Pass is applied on the target candidate\'s own profile', async () => {
  const page = fakePage();
  page.current = 'https://recruitingbypaycor.com/candidate/someoneElse';
  let urlWhenPassed = null;
  actions.passCandidate = async (p) => {
    urlWhenPassed = p.url();
    return { ok: true };
  };

  await executeAction(page, { action: ACTION.PASS_NO_RESPONSE, pipeline: PIPELINE, candidateId: 'target123' });
  assert.equal(urlWhenPassed, 'https://recruitingbypaycor.com/candidate/target123');
});

test('an expired login aborts the action before anything is clicked', async () => {
  const page = fakePage({ redirect: () => 'https://recruitingbypaycor.com/login' });
  let sent = false;
  actions.sendEmailAndAdvance = async () => {
    sent = true;
    return { ok: true };
  };
  await assert.rejects(executeAction(page, { action: ACTION.SEND_FIRST_CONTACT, pipeline: PIPELINE, candidateId: 'abc' }), (err) => actions.isLoginRequired(err));
  assert.equal(sent, false);
});

test('AUTO_SCORE_FLUENCY never submits an incomplete scorecard — routes to manual review with the computed scores', async () => {
  const page = fakePage();
  actions.getFluencySubmission = async () => ({ vocarooLink: 'https://voca.ro/abc', typingPdfPath: null, typingPdfNote: 'no attachments on file' });
  fluencyScorer.runAnalyze = async () => ({
    speech: { word_count: 60, speaking_rate_wpm: 130, unclear_words_percent: 4, duration_sec: 60, pauses_over_1_5s: 0, longest_pause_sec: 1 },
    suggested_stars: { confident_delivery: 4, accent: 4, fluency: 4 },
    typing: { wpm: 0, accuracy: null },
  });
  actions.fillFluencyScorecard = async () => ({ incomplete: true, missing: [], notSettable: ['Confident Delivery'] });

  const result = await executeAction(page, { action: ACTION.AUTO_SCORE_FLUENCY, pipeline: PIPELINE, candidateId: 'abc' });
  assert.equal(result.ok, true);
  assert.equal(result.needsManual, true);
  assert.match(result.reason, /Enter this scorecard by hand/);
  assert.match(result.reason, /final 3\.6/);
  assert.match(result.reason, /no attachments on file/);
});

test('AUTO_SCORE_FLUENCY leaves an existing scorecard alone', async () => {
  const page = fakePage();
  actions.getFluencySubmission = async () => ({ vocarooLink: 'https://voca.ro/abc', typingPdfPath: null });
  fluencyScorer.runAnalyze = async () => ({
    speech: { word_count: 60, speaking_rate_wpm: 130, unclear_words_percent: 4, duration_sec: 60, pauses_over_1_5s: 0, longest_pause_sec: 1 },
    typing: { wpm: 0 },
  });
  actions.fillFluencyScorecard = async () => ({ alreadyScored: true });

  const result = await executeAction(page, { action: ACTION.AUTO_SCORE_FLUENCY, pipeline: PIPELINE, candidateId: 'abc' });
  assert.equal(result.needsManual, true);
  assert.match(result.reason, /already exists/);
});

test('AUTO_SCORE_FLUENCY passes the reply HTML through so the Vocaroo link comes from the reply', async () => {
  const page = fakePage();
  let seenReplyHtml = null;
  actions.getFluencySubmission = async (p, id, dir, opts) => {
    seenReplyHtml = opts.replyHtml;
    return { vocarooLink: null };
  };
  await executeAction(page, { action: ACTION.AUTO_SCORE_FLUENCY, pipeline: PIPELINE, candidateId: 'abc', context: { replyHtml: '<a href="https://voca.ro/x">x</a>' } });
  assert.equal(seenReplyHtml, '<a href="https://voca.ro/x">x</a>');
});

test("a reminder moves the candidate to its own status when one is chosen, otherwise keeps the email's status", async () => {
  const withOwn = { ...PIPELINE, targetStatuses: { ...PIPELINE.targetStatuses, firstContactReminder: 'Reminder E-Mail 1' } };
  const own = await executeAction(null, { action: ACTION.SEND_FIRST_CONTACT_REMINDER, pipeline: withOwn, candidateId: 'a1' }, { dryRun: true });
  assert.equal(own.statusText, 'Reminder E-Mail 1');
  const fallback = await executeAction(null, { action: ACTION.SEND_FIRST_CONTACT_REMINDER, pipeline: PIPELINE, candidateId: 'a1' }, { dryRun: true });
  assert.equal(fallback.statusText, 'Preliminary Screen Attempt 1');
});
