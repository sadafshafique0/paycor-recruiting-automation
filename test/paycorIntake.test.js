const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planIntake, paycorDateToIso } = require('../src/intake/paycorIntake');
const { newCandidateRecord } = require('../src/state/schema');

// Paycor's stage list: status codes in candidate lists are the status "number" (confirmed 2026-10-19).
const STAGES = [
  { number: 1, title: 'Job Seeker', statuses: [{ number: 1, title: 'Site Applicant' }, { number: 3, title: 'Posting Response' }] },
  {
    number: 108,
    title: 'Compatibility Evaluation',
    statuses: [
      { number: 0, title: 'Resume Quick Screen' },
      { number: 2, title: 'Preliminary Screen Attempt 1' },
      { number: 8, title: 'Attention to Detail Review' },
      { number: 5, title: 'Fluency / Typing Evaluation 1' },
      { number: 4, title: 'Candidate Query' },
    ],
  },
];
const PIPELINE = {
  key: 'seo-190',
  jobId: '190',
  targetStatuses: { resumeScreened: 'Resume Quick Screen', firstContact: 'Preliminary Screen Attempt 1', attentionToDetail1: 'Attention to Detail Review', attentionToDetail2: 'Attention to Detail Review', fluencyEvaluation: 'Fluency / Typing Evaluation 1' },
};
const NOW = '2026-10-19T12:00:00.000Z';
const id = (n) => `8a7887a19fd3ba90019fdd408ef00${String(n).padStart(3, '0')}`;
const row = (n, stage, status, lastUpdated) => ({ candidateId: id(n), name: `Candidate ${n}`, stage, status, lastUpdated });

test('each Paycor status becomes the matching outreach step, timed from Last Updated', () => {
  const rows = [row(1, 108, 0, '10/18/2026'), row(2, 108, 2, '10/14/2026'), row(3, 108, 8, '10/10/2026'), row(4, 108, 5, '10/01/2026'), row(5, 108, 4, '10/18/2026'), row(6, 1, 3, '10/18/2026')];
  const plan = planIntake([{ pipeline: PIPELINE, rows }], STAGES, {}, NOW);
  const byId = Object.fromEntries(plan.add.map((r) => [r.id, r]));
  assert.equal(byId[id(1)].track, 'NEW');
  assert.equal(byId[id(1)].awaitingReplySince, null); // first contact is due now
  assert.equal(byId[id(2)].track, 'FIRST_CONTACT');
  assert.equal(byId[id(2)].awaitingReplySince, paycorDateToIso('10/14/2026'));
  assert.equal(byId[id(3)].track, 'ATTENTION_1'); // both re-checks share the status → the 1st
  assert.equal(byId[id(3)].attempt, 1);
  assert.equal(byId[id(4)].track, 'FLUENCY');
  assert.equal(byId[id(5)], undefined); // "Candidate Query" isn't a step — left to a person
  assert.equal(byId[id(6)], undefined); // still a Job Seeker — screening's job, not outreach's
});

test('only recently updated candidates are picked up, and new ones up to the per-run limit (newest first)', () => {
  const rows = [row(1, 108, 0, '10/18/2026'), row(2, 108, 0, '10/17/2026'), row(3, 108, 0, '10/16/2026'), row(4, 108, 2, '10/10/2026'), row(5, 108, 0, '06/13/2024'), row(6, 108, 2, '01/02/2025')];
  const plan = planIntake([{ pipeline: PIPELINE, rows }], STAGES, {}, NOW, { pickUpWithinDays: 30, maxNew: 2 });
  assert.deepEqual(plan.add.map((r) => r.id).sort(), [id(1), id(2), id(4)].sort());
  assert.equal(plan.tooOld, 2);
  assert.equal(plan.overNewLimit, 1);
});

test('already-tracked candidates keep their record; one moved elsewhere in Paycor is stopped', () => {
  const tracked = { [id(1)]: { ...newCandidateRecord({ id: id(1), name: 'A', pipelineKey: 'seo-190' }, NOW), track: 'FIRST_CONTACT' }, [id(2)]: newCandidateRecord({ id: id(2), name: 'B', pipelineKey: 'seo-190' }, NOW) };
  const rows = [row(1, 108, 2, '10/18/2026'), row(2, 108, 4, '10/18/2026')]; // 2 was moved to "Candidate Query" by a person
  const plan = planIntake([{ pipeline: PIPELINE, rows }], STAGES, tracked, NOW);
  assert.equal(plan.add.length, 0);
  assert.deepEqual(plan.stop.map((s) => s.id), [id(2)]);
  // A job that couldn't be read never stops anyone.
  assert.equal(planIntake([{ pipeline: PIPELINE, rows: null }], STAGES, tracked, NOW).stop.length, 0);
});
