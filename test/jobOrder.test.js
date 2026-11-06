const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-joborder-'));
const data = require('../src/paycorData');
const session = require('../src/paycorSession');
const { learnPriorityLabels } = require('../src/jobLoader');

const URL_ = 'https://recruitingbypaycor.com/rest/home-dashboard/active';
const recipe = {
  url: URL_,
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: { pageNumber: '0', sortType: '2', role: 'all', companyId: 'c1' },
  path: ['jobs'],
  titleKey: 'title',
  idKey: 'jobNumber',
};

// Paycor's own order: Urgent (4) first, then 8, 12, 16 — kept exactly as sent.
const ALL = [
  { jobNumber: 252, title: 'Shuttle Van Driver', priority: 4, location: 'Lancaster, PA', jobSeekerCount: 3 },
  { jobNumber: 224, title: 'Test Job', priority: 8, jobSeekerCount: 0 },
  { jobNumber: 211, title: 'Accountant', priority: 12, jobSeekerCount: 9 },
  { jobNumber: 220, title: 'Power Automation Analyst', priority: 16, jobSeekerCount: 1 },
];
const MINE = [ALL[3], ALL[1]];

function fakePaycor(seen = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body.role);
    const jobs = body.role === 'all' ? ALL : body.role === 'myJob' ? MINE : [];
    const text = JSON.stringify({ total: jobs.length, pageNumber: 0, jobs });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => text };
  };
}

test('both lists are fetched: All Jobs in Paycor\'s order, each job marked as in My Jobs or not', async () => {
  const seen = [];
  const result = await data.fetchMineAndAll(recipe, [], { fetchImpl: fakePaycor(seen) });
  assert.deepEqual(seen, ['all', 'myJob']);
  assert.equal(result.hasMyJobs, true);
  assert.deepEqual(result.jobs.map((j) => j.jobId), ['252', '224', '211', '220']); // not re-sorted by applicants
  assert.deepEqual(result.jobs.map((j) => j.priority), [4, 8, 12, 16]);
  assert.deepEqual(result.jobs.filter((j) => j.mine).map((j) => [j.jobId, j.myRank]), [['224', 1], ['220', 0]]);
  assert.equal(result.jobs[0].location, 'Lancaster, PA');
});

test('if My Jobs can\'t be loaded, All Jobs still is — but an expired login still stops everything', async () => {
  const failingMine = async (url, init) => {
    if (JSON.parse(init.body).role !== 'all') return { status: 500, ok: false, headers: { get: () => null }, text: async () => '' };
    return fakePaycor()(url, init);
  };
  const result = await data.fetchMineAndAll(recipe, [], { fetchImpl: failingMine });
  assert.equal(result.hasMyJobs, false);
  assert.equal(result.jobs.length, 4);
  assert.match(result.scopeNote, /My Jobs/);

  const expired = async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(data.fetchMineAndAll(recipe, [], { fetchImpl: expired }), (e) => e.code === 'LOGIN_REQUIRED');
});

test('the My Jobs / All Jobs values are learned from Paycor\'s own requests before and after the filter switch', () => {
  const c = (at, role) => ({ at, url: URL_, postData: JSON.stringify({ pageNumber: '0', role }) });
  assert.deepEqual(data.learnScopeValues([c(1, 'myJob'), c(5, 'all')], URL_, 3), { mine: 'myJob', all: 'all' });
  assert.deepEqual(data.learnScopeValues([c(1, 'myJob')], URL_, null), {}); // no switch happened → nothing learned
});

test('priority names come from Paycor\'s badges and survive a windowless refresh', () => {
  assert.deepEqual(learnPriorityLabels([{ priority: 4, priorityLabel: 'Urgent' }, { priority: 16, priorityLabel: null }]), { 4: 'Urgent' });
  session.saveJobs([], { priorityLabels: { 4: 'Urgent' } });
  session.saveJobs([], session.jobListExtras({ jobs: [], hasMyJobs: true })); // a refresh sees no badges
  const saved = session.readJobs();
  assert.deepEqual(saved.priorityLabels, { 4: 'Urgent' });
  assert.equal(saved.hasMyJobs, true);
});
