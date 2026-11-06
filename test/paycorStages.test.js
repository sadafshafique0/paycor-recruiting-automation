const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchStages, mapStageLibrary, refreshStages, readStageCache } = require('../src/paycorStages');
const { actOnScreeningCandidate } = require('../src/screening/runScreeningSweep');
const { resolvePipeline } = require('../src/pipelines');
const { normalizeTeamProcess } = require('../src/teamProcess');

const COMPANY = '8a7883d08675eec501867a6a925901d3';
const COOKIES = [
  { name: 'NSESSIONID', value: 's', domain: '.recruitingbypaycor.com' },
  { name: 'selectedClientId', value: COMPANY, domain: 'recruitingbypaycor.com' },
];
const LIBRARY = {
  totalSize: 3,
  items: [
    { id: 2, number: 108, title: 'Compatibility Evaluation', visible: true, statuses: [{ id: 21, title: 'Preliminary Screen Attempt 1', visible: true, order: 2 }, { id: 20, title: 'Resume Quick Screen', visible: true, order: 1 }] },
    { id: 1, number: 1, title: 'Job Seeker', visible: true, statuses: [{ id: 11, title: 'Posting Response', visible: true }, { id: 12, title: 'Internal', visible: false }] },
    { id: 3, number: 9, title: 'Offer Letter', visible: false, statuses: [{ id: 31, title: 'Offer Letter Sent', visible: true }] },
  ],
};

test("Paycor's stages come back in Paycor's order with their visible statuses; hidden ones are left out", () => {
  const stages = mapStageLibrary(LIBRARY);
  assert.deepEqual(stages.map((s) => s.title), ['Job Seeker', 'Compatibility Evaluation']);
  assert.deepEqual(stages[0].statuses.map((s) => s.title), ['Posting Response']);
  assert.deepEqual(stages[1].statuses.map((s) => s.title), ['Resume Quick Screen', 'Preliminary Screen Attempt 1']);
  assert.throws(() => mapStageLibrary({ nope: [] }), /expected layout/);
});

test('the stage list is read with the login and the company id header, and cached', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, clientId: init.headers['client-id'], cookie: init.headers.cookie };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(LIBRARY) };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-stages-'));
  const p = { stagesFile: path.join(dir, 'stages.json') };
  const cache = await refreshStages(p, { fetchImpl, cookies: COOKIES });
  assert.equal(seen.url, 'https://recruitingbypaycor.com/rest/stage-library?includeStatuses=true');
  assert.equal(seen.clientId, COMPANY);
  assert.match(seen.cookie, /NSESSIONID=s/);
  assert.equal(cache.stages.length, 2);
  assert.equal(readStageCache(p.stagesFile).stages[1].title, 'Compatibility Evaluation');

  const expired = async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(fetchStages(COOKIES, { fetchImpl: expired }), (e) => e.code === 'LOGIN_REQUIRED');
});

test('the "resume screened" status is part of the team steps and reaches the pipeline', () => {
  const { process: team } = normalizeTeamProcess({ targetStatuses: { resumeScreened: 'Resume Quick Screen', firstContact: 'Preliminary Screen Attempt 1' } });
  assert.equal(team.targetStatuses.resumeScreened, 'Resume Quick Screen');
  const config = { pipelines: [{ key: 'job-1', jobId: '1', managerEmail: 'm@x.com', templates: Object.fromEntries(require('../src/pipelines').REQUIRED_TEMPLATE_KEYS.map((k) => [k, 'T'])), targetStatuses: { attentionToDetail1: 'A', attentionToDetail2: 'A', fluencyEvaluation: 'F' } }] };
  assert.equal(resolvePipeline(config, 'job-1', team).targetStatuses.resumeScreened, 'Resume Quick Screen');
});

test('accepting a screened resume moves it to the chosen status; with none chosen it clicks Resume Quick Screen', async () => {
  const calls = [];
  const actions = {
    openCandidateProfile: async () => {},
    readCurrentStage: async () => 'Job Seeker - Posting Response',
    isJobSeekerStage: (s) => /posting response/i.test(s),
    moveToStatus: async (page, status) => (calls.push(['status', status]), { ok: true }),
    advanceResumeQuickScreen: async () => (calls.push(['quick']), { ok: true }),
    passCandidate: async () => ({ ok: true }),
  };
  await actOnScreeningCandidate({ page: {}, candidateId: 'a1', decision: 'accept', screenedStatus: 'Shortlisted Candidate', actions });
  await actOnScreeningCandidate({ page: {}, candidateId: 'a1', decision: 'accept', actions });
  assert.deepEqual(calls, [['status', 'Shortlisted Candidate'], ['quick']]);

  // "Resume Quick Screen" = the green button of the job's own pipeline; the menu only if the button is missing
  calls.length = 0;
  await actOnScreeningCandidate({ page: {}, candidateId: 'a1', decision: 'accept', screenedStatus: 'Resume Quick Screen', actions });
  actions.advanceResumeQuickScreen = async () => (calls.push(['quick']), { error: 'no "Resume Quick Screen" button found' });
  await actOnScreeningCandidate({ page: {}, candidateId: 'a1', decision: 'accept', screenedStatus: 'Resume Quick Screen', actions });
  assert.deepEqual(calls, [['quick'], ['quick'], ['status', 'Resume Quick Screen']]);
});
