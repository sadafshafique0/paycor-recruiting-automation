const { test } = require('node:test');
const assert = require('node:assert/strict');
const actions = require('../src/paycor-actions');
const { fakePage } = require('./fakePage');

const ID = '8a7887a19fd3ba90019fdd408ef0063e';

test('openCandidateProfile lands on and verifies the requested candidate', async () => {
  const page = fakePage();
  await actions.openCandidateProfile(page, ID);
  assert.equal(page.url(), `https://recruitingbypaycor.com/candidate/${ID}`);
});

test('a /login redirect throws LoginRequiredError instead of carrying on', async () => {
  const page = fakePage({ redirect: () => 'https://recruitingbypaycor.com/login?next=x' });
  await assert.rejects(actions.openCandidateProfile(page, ID), (err) => actions.isLoginRequired(err));
});

test('landing on a different page than the requested candidate refuses to continue', async () => {
  const page = fakePage({ redirect: () => 'https://recruitingbypaycor.com/home' });
  await assert.rejects(actions.openCandidateProfile(page, ID), /refusing to act on an unverified page/);
});

test('an invalid candidate id is rejected before any navigation', async () => {
  const page = fakePage();
  await assert.rejects(actions.openCandidateProfile(page, '../admin'), /invalid candidate id/);
  assert.equal(page.visited.length, 0);
});

test('readLatestReply throws when the history list cannot be read — never "no reply"', async () => {
  const page = fakePage({ evaluate: async () => null });
  page.current = `https://recruitingbypaycor.com/candidate/${ID}`;
  await assert.rejects(actions.readLatestReply(page, '2026-01-01T00:00:00Z'), /not treating this as "no reply"/);
});

test('readLatestReply keeps line breaks so the quoted thread can be stripped', async () => {
  const html = 'Thanks, looking forward to it!<br><br>From: Alex &lt;x@echo.newtonsoftware.com&gt;<br>Sent: Monday<br>Please reply with your favorite color.';
  const page = fakePage({
    evaluate: async () => [{ id: 'm1', timestamp: Date.parse('2026-01-05'), fromAddress: 'jane@example.com', isEmail: true, html }],
  });
  page.current = `https://recruitingbypaycor.com/candidate/${ID}`;
  const reply = await actions.readLatestReply(page, '2026-01-01T00:00:00Z');
  assert.match(reply.text, /\nFrom: Alex/);
  assert.equal(reply.messageId, 'm1');
  assert.equal(reply.html, html);
});

test('parseDisplayPreviewArg: strict JSON form', () => {
  const r = actions.parseDisplayPreviewArg(`displayPreview({"candidateName":"Jane Doe","candidateId":"${ID}","clientId":"x"})`);
  assert.deepEqual(r, { candidateId: ID, candidateName: 'Jane Doe' });
});

test('parseDisplayPreviewArg: single-quoted form with an apostrophe in the name', () => {
  const r = actions.parseDisplayPreviewArg(`displayPreview({candidateName: "Sean O'Brien", candidateId: '${ID}'})`);
  assert.deepEqual(r, { candidateId: ID, candidateName: "Sean O'Brien" });
});

test('parseDisplayPreviewArg: unparseable input returns null rather than a guess', () => {
  assert.equal(actions.parseDisplayPreviewArg('displayPreview(row)'), null);
  assert.equal(actions.parseDisplayPreviewArg('somethingElse()'), null);
});

test('singleCandidateIdFromHref handles hex IDs and ignores search URLs', () => {
  assert.equal(actions.singleCandidateIdFromHref(`/candidate/${ID}`), ID);
  assert.equal(actions.singleCandidateIdFromHref('/candidate/search?q=abc'), null);
});

test('isJobSeekerStage accepts every new applicant in the Job Seeker stage, whatever the source', () => {
  // Real stage-bar text from Paycor: the Job Seeker stage's icon name + the status.
  assert.equal(actions.isJobSeekerStage('directions_runSite Applicant'), true);
  assert.equal(actions.isJobSeekerStage('Site Applicant directions_runSite Applicant'), true);
  assert.equal(actions.isJobSeekerStage('directions_runPosting Response'), true);
  assert.equal(actions.isJobSeekerStage('Posting Response'), true);
  assert.equal(actions.isJobSeekerStage('Internal Referral'), true);
  // Moved on: another stage's icon and status.
  assert.equal(actions.isJobSeekerStage('assignmentResume Quick Screen'), false);
  assert.equal(actions.isJobSeekerStage('Resume Quick Screen'), false);
  assert.equal(actions.isJobSeekerStage('Other'), false); // also a Passive Candidate status — never assumed
  assert.equal(actions.isJobSeekerStage(null), false);
});
