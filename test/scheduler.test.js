const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDailyCycle } = require('../src/engine/scheduler');
const { writeState, loadState } = require('../src/state/store');
const { loadManualReview } = require('../src/state/manualReview');
const { newCandidateRecord } = require('../src/state/schema');
const { TRACK, ACTION } = require('../src/engine/constants');

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-sched-'));
  return { stateFile: path.join(dir, 'state.json'), manualReviewFile: path.join(dir, 'manualReview.json') };
}

const CONFIG = {
  name: 'Test',
  pipelines: [
    {
      key: 'p1',
      jobId: '1',
      templates: {
        firstContact: 'T1', firstContactReminder: 'T1R', attentionToDetail1: 'T2', attentionToDetail1Reminder: 'T2R',
        attentionToDetail2: 'T3', attentionToDetail2Reminder: 'T3R', fluencyEvaluation: 'T4', fluencyReminder: 'T4R',
      },
      targetStatuses: { firstContact: 'S1', attentionToDetail1: 'S2', attentionToDetail2: 'S3', fluencyEvaluation: 'S4' },
      managerEmail: 'm@x.com',
    },
  ],
};

test('new candidate intake sends First Contact and records awaitingReplySince', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-01T00:00:00.000Z';
  writeState(stateFile, { c1: newCandidateRecord({ id: 'c1', name: 'Jane', pipelineKey: 'p1' }, now) });

  const executeAction = async (page, { action }) => ({ ok: true, action, templateName: 'T1' });

  await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply: async () => null, executeAction, dryRun: false });

  const state = loadState(stateFile);
  assert.equal(state.c1.track, TRACK.FIRST_CONTACT);
  assert.equal(state.c1.awaitingReplySince, now);
});

test('regression: a dry run reports what it would do but changes no state and queues nothing', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-10T00:00:00.000Z';
  const before = {
    c1: newCandidateRecord({ id: 'c1', name: 'Jane', pipelineKey: 'p1' }, now),
    s1: { ...newCandidateRecord({ id: 's1', name: 'Sam', pipelineKey: 'p1' }, '2026-01-01T00:00:00.000Z'), track: TRACK.FIRST_CONTACT_REMINDED, awaitingReplySince: '2026-01-01T00:00:00.000Z', reminderSentAt: '2026-01-02T00:00:00.000Z' },
  };
  writeState(stateFile, before);

  const executeAction = async (page, { action }) => ({ ok: true, dryRun: true, action });
  const summary = await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply: async () => null, executeAction, dryRun: true });

  assert.deepEqual(loadState(stateFile), before);
  assert.deepEqual(loadManualReview(manualReviewFile), []);
  assert.deepEqual(summary.planned.map((p) => p.action).sort(), [ACTION.PASS_NO_RESPONSE, ACTION.SEND_FIRST_CONTACT].sort());
});

test('AUTO_SCORE_FLUENCY success -> SCORECARD_SUBMITTED, terminal, fluencyScore recorded', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-05T00:00:00.000Z';
  const candidate = { ...newCandidateRecord({ id: 'c2', name: 'Joe', pipelineKey: 'p1' }, now), track: TRACK.FLUENCY, awaitingReplySince: now, processedMessageIds: [] };
  writeState(stateFile, { c2: candidate });

  const executeAction = async (page, { action }) => {
    assert.equal(action, ACTION.AUTO_SCORE_FLUENCY);
    return { ok: true, action, scoreData: { finalScore: 4.2 } };
  };
  const fetchReply = async () => ({ text: 'https://voca.ro/abc', messageId: 'm1' });

  await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply, executeAction, dryRun: false });

  const state = loadState(stateFile);
  assert.equal(state.c2.track, TRACK.SCORECARD_SUBMITTED);
  assert.equal(state.c2.status, 'terminal');
  assert.equal(state.c2.fluencyScore, 4.2);
});

test('AUTO_SCORE_FLUENCY needsManual -> rerouted to MANUAL_REVIEW even though trackMachine expected success', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-05T00:00:00.000Z';
  const candidate = { ...newCandidateRecord({ id: 'c3', name: 'Alex', pipelineKey: 'p1' }, now), track: TRACK.FLUENCY, awaitingReplySince: now, processedMessageIds: [] };
  writeState(stateFile, { c3: candidate });

  const executeAction = async () => ({ ok: true, action: ACTION.AUTO_SCORE_FLUENCY, needsManual: true, reason: 'no usable recording' });
  const fetchReply = async () => ({ text: 'reply with nothing useful', messageId: 'm2' });

  const summary = await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply, executeAction, dryRun: false });

  const state = loadState(stateFile);
  assert.equal(state.c3.track, TRACK.MANUAL_REVIEW);
  assert.equal(state.c3.status, 'terminal');
  assert.equal(summary.manualReviewAdded, 1);

  const reviews = loadManualReview(manualReviewFile);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].reason, 'no usable recording');
});

test('executeAction failure keeps the candidate active for retry next run, never advances track', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-05T00:00:00.000Z';
  writeState(stateFile, { c4: newCandidateRecord({ id: 'c4', name: 'Pat', pipelineKey: 'p1' }, now) });

  const executeAction = async () => ({ ok: false, action: ACTION.SEND_FIRST_CONTACT, error: 'Paycor timed out' });

  await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply: async () => null, executeAction, dryRun: false });

  const state = loadState(stateFile);
  assert.equal(state.c4.track, TRACK.NEW); // unchanged
  assert.ok(state.c4.errorState);
});

function staleRemindedCandidate(id) {
  return {
    ...newCandidateRecord({ id, name: id, pipelineKey: 'p1' }, '2026-01-01T00:00:00.000Z'),
    track: TRACK.FIRST_CONTACT_REMINDED,
    awaitingReplySince: '2026-01-01T00:00:00.000Z',
    reminderSentAt: '2026-01-02T00:00:00.000Z',
  };
}

test('regression: a candidate whose replies could not be checked is never timed out and Passed', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  writeState(stateFile, { s1: staleRemindedCandidate('s1') });

  let passed = false;
  const executeAction = async () => {
    passed = true;
    return { ok: true, action: ACTION.PASS_NO_RESPONSE };
  };
  const fetchReply = async () => {
    throw new Error('Could not read the candidate history list');
  };

  const summary = await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now: '2026-01-10T00:00:00.000Z', fetchReply, executeAction, dryRun: false });
  assert.equal(passed, false);
  assert.equal(summary.errors.length, 1);
  assert.equal(loadState(stateFile).s1.track, TRACK.FIRST_CONTACT_REMINDED);
});

test('regression: an expired login aborts the whole cycle instead of continuing candidate by candidate', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  writeState(stateFile, { s1: staleRemindedCandidate('s1'), s2: staleRemindedCandidate('s2') });

  let actions = 0;
  const fetchReply = async () => {
    const err = new Error('Paycor session expired');
    err.code = 'LOGIN_REQUIRED';
    throw err;
  };
  const executeAction = async () => {
    actions++;
    return { ok: true };
  };

  await assert.rejects(
    runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now: '2026-01-10T00:00:00.000Z', fetchReply, executeAction, dryRun: false }),
    /session expired/,
  );
  assert.equal(actions, 0);
});

test('a thrown (non-login) action error is recorded and the run continues with the next candidate', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-05T00:00:00.000Z';
  writeState(stateFile, {
    n1: newCandidateRecord({ id: 'n1', name: 'A', pipelineKey: 'p1' }, now),
    n2: newCandidateRecord({ id: 'n2', name: 'B', pipelineKey: 'p1' }, now),
  });
  const executeAction = async (page, { candidateId }) => {
    if (candidateId === 'n1') throw new Error('Playwright timeout');
    return { ok: true, templateName: 'T1' };
  };

  const summary = await runDailyCycle({ stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply: async () => null, executeAction, dryRun: false });
  const state = loadState(stateFile);
  assert.equal(state.n1.track, TRACK.NEW);
  assert.equal(state.n2.track, TRACK.FIRST_CONTACT);
  assert.equal(summary.errors.length, 1);
});

test('backlog safety cap: a surprise batch of passes is queued for manual review instead of auto-executed', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-10T00:00:00.000Z';
  const state = {};
  for (let i = 0; i < 5; i++) {
    state[`c${i}`] = {
      ...newCandidateRecord({ id: `c${i}`, name: `Cand ${i}`, pipelineKey: 'p1' }, '2026-01-01T00:00:00.000Z'),
      track: TRACK.FIRST_CONTACT_REMINDED,
      awaitingReplySince: '2026-01-01T00:00:00.000Z',
      reminderSentAt: '2026-01-02T00:00:00.000Z',
    };
  }
  writeState(stateFile, state);

  let executed = 0;
  const executeAction = async () => {
    executed++;
    return { ok: true, action: ACTION.PASS_NO_RESPONSE };
  };

  const summary = await runDailyCycle({
    stateFilePath: stateFile, manualReviewFilePath: manualReviewFile, config: CONFIG, now, fetchReply: async () => null, executeAction, dryRun: false, maxPassesPerRun: 2,
  });

  assert.equal(summary.backlogCapTripped, true);
  assert.equal(executed, 0);
  assert.equal(loadManualReview(manualReviewFile).length, 5);
});

test('outreach for one chosen pipeline touches only that pipeline\'s candidates; test-run extras stay in memory', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const now = '2026-01-01T00:00:00.000Z';
  const config = { ...CONFIG, pipelines: [CONFIG.pipelines[0], { ...CONFIG.pipelines[0], key: 'p2', jobId: '2' }] };
  writeState(stateFile, { a1: newCandidateRecord({ id: 'a1', name: 'In p1', pipelineKey: 'p1' }, now), b1: newCandidateRecord({ id: 'b1', name: 'In p2', pipelineKey: 'p2' }, now) });
  const extra = newCandidateRecord({ id: 'a2', name: 'Found in Paycor', pipelineKey: 'p1' }, now);
  const summary = await runDailyCycle({
    stateFilePath: stateFile,
    manualReviewFilePath: manualReviewFile,
    config,
    now,
    fetchReply: async () => null,
    executeAction: async () => ({ ok: true }),
    dryRun: true,
    pipelineKey: 'p1',
    extraCandidates: [extra],
  });
  assert.deepEqual(summary.planned.map((p) => [p.candidateId, p.pipelineKey]).sort(), [['a1', 'p1'], ['a2', 'p1']]);
  assert.deepEqual(Object.keys(loadState(stateFile)).sort(), ['a1', 'b1']); // nothing saved by a test run
});

test('before a reminder or a pass, a reply found on the profile is handled instead', async () => {
  const { stateFile, manualReviewFile } = tmpPaths();
  const sent = '2026-01-01T00:00:00.000Z';
  const rec = { ...newCandidateRecord({ id: 'c1', name: 'Jane', pipelineKey: 'p1' }, sent), track: TRACK.FIRST_CONTACT, awaitingReplySince: sent };
  writeState(stateFile, { c1: rec });
  const actions = [];
  const summary = await runDailyCycle({
    stateFilePath: stateFile,
    manualReviewFilePath: manualReviewFile,
    config: CONFIG,
    now: '2026-01-10T00:00:00.000Z', // long past the reminder window
    fetchReply: async () => null, // no notification
    confirmNoReply: async () => ({ text: 'My favourite colour is blue', html: 'blue', messageId: 'm1' }), // but the profile has a reply
    executeAction: async (page, { action }) => (actions.push(action), { ok: true, action, templateName: 'T' }),
  });
  assert.deepEqual(actions, [ACTION.SEND_FLUENCY]); // treated as a passing reply — no reminder, no pass
  assert.equal(summary.repliesProcessed, 1);
});
