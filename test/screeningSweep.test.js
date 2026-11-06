const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const realActions = require('../src/paycor-actions');
const { runScreeningSweep } = require('../src/screening/runScreeningSweep');
const { loadState } = require('../src/state/store');
const { loadManualReview } = require('../src/state/manualReview');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-screen-'));
  const criteriaDir = path.join(dir, 'criteria');
  fs.mkdirSync(criteriaDir);
  fs.writeFileSync(path.join(criteriaDir, 'job-146.md'), 'Diesel mechanic, 3+ years');
  fs.writeFileSync(path.join(criteriaDir, 'job-146.rules.json'), JSON.stringify({ requiredSkills: ['diesel | diesel engine'], minimumYears: 3 }));
  return {
    screeningCriteriaDir: criteriaDir,
    screeningResultsDir: path.join(dir, 'results'),
    manualReviewFilePath: path.join(dir, 'manualReview.json'),
    stateFilePath: path.join(dir, 'state.json'),
  };
}

// Fake Paycor: every candidate starts as a Job Seeker unless listed in `movedIds`.
function fakeActions({ candidates, movedIds = [], loginOn = null, resumes = {} } = {}) {
  const calls = { advanced: [], passed: [], resumeReads: [] };
  let current = null;
  const resumeState = (id) => {
    if (id === loginOn) throw new realActions.LoginRequiredError('https://recruitingbypaycor.com/login');
    if (movedIds.includes(id)) return { alreadyMoved: true, currentStage: 'Resume Quick Screen' };
    return null;
  };
  return {
    calls,
    isLoginRequired: realActions.isLoginRequired,
    isJobSeekerStage: realActions.isJobSeekerStage,
    async findJobCard() {
      return { matches: [{ jobId: '146', title: 'Diesel Mechanic', jobSeekerHref: '/candidate/search?q=x' }] };
    },
    async scrapeJobSeekers() {
      return candidates.map((id) => ({ candidateId: id, candidateName: `Name ${id}` }));
    },
    async screenshotResumePages(page, id) {
      return resumeState(id) || { screenshots: ['aGVsbG8='] };
    },
    async readResumeText(page, id) {
      calls.resumeReads.push(id);
      return resumeState(id) || { text: resumes[id] || 'resume text', method: 'file', words: 100 };
    },
    async openCandidateProfile(page, id) {
      current = id;
    },
    async readCurrentStage() {
      return movedIds.includes(current) ? 'Resume Quick Screen' : 'Posting Response';
    },
    async advanceResumeQuickScreen() {
      calls.advanced.push(current);
      return { ok: true };
    },
    async passCandidate(page, reason) {
      calls.passed.push({ id: current, reason });
      return { ok: true };
    },
  };
}

const PIPELINE = { key: 'mech-146' };
const verdicts = {
  accept: { verdict: 'ACCEPT', reason: null, evidence: 'fit', confidence: 'high', flagLowConfidence: false },
  reject: { verdict: 'REJECT', reason: 'Job hopper', evidence: 'no fit', confidence: 'high', flagLowConfidence: false },
  unsure: { verdict: 'UNCERTAIN', reason: null, evidence: 'borderline', confidence: 'low', flagLowConfidence: true },
};

test('ACCEPT advances the candidate AND enrolls them in the outreach pipeline (the hand-off)', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['a1'] });
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, judge: async () => verdicts.accept });

  assert.deepEqual(actions.calls.advanced, ['a1']);
  assert.equal(summary.enrolled, 1);
  const state = loadState(deps.stateFilePath);
  assert.equal(state.a1.track, 'NEW');
  assert.equal(state.a1.pipelineKey, 'mech-146');
});

test('a candidate who already left the Job Seeker stage is never acted on', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['m1'], movedIds: ['m1'] });
  let judged = false;
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, judge: async () => { judged = true; return verdicts.reject; } });

  assert.equal(summary.skippedAlreadyMoved, 1);
  assert.equal(judged, false); // no API call spent either
  assert.equal(actions.calls.passed.length, 0);
});

test('low-confidence verdicts are queued for a human with the suggested verdict attached', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['u1'] });
  await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, judge: async () => verdicts.unsure });

  const queue = loadManualReview(deps.manualReviewFilePath);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].kind, 'screening');
  assert.equal(queue[0].pipelineKey, 'mech-146');
  assert.equal(actions.calls.advanced.length + actions.calls.passed.length, 0);
});

test('the Pass cap stops the run — the rest wait for the next run instead of piling up in Needs attention', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['r1', 'r2', 'r3'] });
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, judge: async () => verdicts.reject, maxPassesPerRun: 2 });

  assert.equal(actions.calls.passed.length, 2);
  assert.equal(summary.manualReview, 0);
  assert.equal(summary.passCapReached, true);
  assert.equal(summary.stoppedAtPassCap, true);
  assert.equal(summary.leftForNextRun, 1);
});

test('a big backlog is screened newest first, a batch per run', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: [] });
  const listJobSeekers = async () => ['n1', 'n2', 'n3', 'n4'].map((id) => ({ candidateId: id, candidateName: id }));
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, dryRun: true, judge: async () => verdicts.accept, listJobSeekers, maxCandidatesPerRun: 3 });
  assert.deepEqual(summary.candidates.map((c) => c.candidateId), ['n1', 'n2', 'n3']);
  assert.equal(summary.totalWaiting, 4);
  assert.equal(summary.leftForNextRun, 1);
});

test('dry run judges but never clicks or enrolls', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['d1', 'd2'] });
  let i = 0;
  await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, dryRun: true, judge: async () => (i++ ? verdicts.reject : verdicts.accept) });

  assert.equal(actions.calls.advanced.length + actions.calls.passed.length, 0);
  assert.deepEqual(loadState(deps.stateFilePath), {});
});

test('an expired login stops the sweep, and the log still records what happened before it', async () => {
  const deps = setup();
  const actions = fakeActions({ candidates: ['ok1', 'login'], loginOn: 'login' });
  await assert.rejects(
    runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions, judge: async () => verdicts.accept }),
    (err) => realActions.isLoginRequired(err),
  );
  const logFile = fs.readdirSync(deps.screeningResultsDir)[0];
  const log = JSON.parse(fs.readFileSync(path.join(deps.screeningResultsDir, logFile), 'utf8'));
  assert.equal(log.runs[0].candidates.length, 1);
  assert.equal(log.runs[0].candidates[0].candidateId, 'ok1');
});

test('refuses to screen without saved rules (rules mode) or a description (Claude mode)', async () => {
  const deps = setup();
  fs.rmSync(path.join(deps.screeningCriteriaDir, 'job-146.rules.json'));
  const rulesRun = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', actions: fakeActions({ candidates: ['x'] }), judge: async () => verdicts.accept });
  assert.equal(rulesRun.status, 'missing_criteria');
  assert.equal(rulesRun.engine, 'rules');

  const deps2 = setup();
  fs.rmSync(path.join(deps2.screeningCriteriaDir, 'job-146.md'));
  const claudeRun = await runScreeningSweep({ ...deps2, page: {}, jobQuery: '146', engine: 'claude', actions: fakeActions({ candidates: ['x'] }), judge: async () => verdicts.accept });
  assert.equal(claudeRun.status, 'missing_criteria');
});

test('end to end with the real rules (no AI): clear fit advanced, clear mismatch passed, borderline sent to a person', async () => {
  const deps = setup();
  const filler = ' Experienced, reliable and safety focused, with strong troubleshooting and maintenance skills.'.repeat(6);
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ago = new Date();
  ago.setMonth(ago.getMonth() - 30); // ~2.5 years: just under the 3-year minimum → a person decides
  const unsureStart = `${MONTH_NAMES[ago.getMonth()]} ${ago.getFullYear()}`;
  const actions = fakeActions({
    candidates: ['fit', 'nope', 'unsure'],
    resumes: {
      fit: `Diesel engine technician.\nFleet Mechanic, Jan 2018 - Present\n${filler}`,
      nope: `Retail cashier.\nCashier, Jan 2015 - Present\n${filler}`,
      unsure: `Diesel mechanic.\nMechanic, ${unsureStart} - Present\n${filler}`,
    },
  });
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', pipeline: PIPELINE, actions });

  assert.equal(summary.engine, 'rules');
  assert.deepEqual(actions.calls.advanced, ['fit']);
  assert.deepEqual(actions.calls.passed, [{ id: 'nope', reason: 'Experience / Skills are not a match' }]);
  assert.equal(summary.manualReview, 1);
  assert.equal(summary.candidates.find((c) => c.candidateId === 'fit').readBy, 'resume file');
  assert.equal(loadManualReview(deps.manualReviewFilePath)[0].candidateId, 'unsure');
});

test('invalid saved rules stop the run with the reason', async () => {
  const deps = setup();
  fs.writeFileSync(path.join(deps.screeningCriteriaDir, 'job-146.rules.json'), JSON.stringify({ preferredSkills: ['x'] }));
  const summary = await runScreeningSweep({ ...deps, page: {}, jobQuery: '146', actions: fakeActions({ candidates: ['x'] }) });
  assert.equal(summary.status, 'invalid_rules');
  assert.match(summary.problems[0], /at least one rule/);
});
