const { test } = require('node:test');
const assert = require('node:assert/strict');
const data = require('../src/paycorData');
const actions = require('../src/paycor-actions');

const JOBS_URL = 'https://recruitingbypaycor.com/api/jobs/search?myJobs=true&page=0&size=10';

function capture(url, json, extra = {}) {
  return { at: Date.now(), url, method: 'GET', status: 200, requestHeaders: { accept: 'application/json', cookie: 'secret=1', 'x-xsrf-token': 'abc' }, postData: null, json, size: 100, ...extra };
}

const jobsPayload = {
  totalElements: 3,
  content: [
    { id: 'hex1', jobNumber: 220, title: 'Power Automation Analyst', stageCounts: [{ name: 'Job Seeker', count: 4 }, { name: 'Hired', count: 0 }] },
    { id: 'hex2', jobNumber: 222, title: 'RPA Production Support Analyst', stageCounts: [{ name: 'Job Seeker', count: 0 }] },
  ],
};

test('discovery picks the job list response confirmed by the cards on screen, not other lists', () => {
  const captures = [
    capture('https://recruitingbypaycor.com/api/notifications', { items: [{ id: 5, title: 'New candidate applied' }] }),
    capture(JOBS_URL, jobsPayload),
  ];
  const found = data.discoverJobsRequest(captures, [{ jobId: '220', title: 'Power Automation Analyst' }]);
  assert.equal(found.capture.url, JOBS_URL);
  assert.equal(found.titleKey, 'title');
  assert.equal(found.idKey, 'jobNumber'); // the numeric "Job ID: 220" shown on the card, not the internal hex id
  assert.equal(found.total, 3);
});

test('discovery returns null when no captured list matches the visible jobs', () => {
  const captures = [capture('https://recruitingbypaycor.com/api/other', { items: [{ number: 9, title: 'Something else' }] })];
  assert.equal(data.discoverJobsRequest(captures, [{ jobId: '220', title: 'Power Automation Analyst' }]), null);
});

test('stage counts are read when present, and reported as unknown (null) — never 0 — when absent', () => {
  assert.deepEqual(data.extractCounts(jobsPayload.content[0]), { stageCounts: [{ label: 'Job Seeker', count: 4 }, { label: 'Hired', count: 0 }], jobSeekerCount: 4 });
  assert.deepEqual(data.extractCounts({ title: 'x', jobNumber: 1 }), { stageCounts: [], jobSeekerCount: null });
});

test('count fields like jobSeekerCount / activeCandidateCount are picked up with readable stage names', () => {
  const { jobSeekerCount, stageCounts } = data.extractCounts({ title: 'x', jobSeekerCount: 7, activeCandidateCount: 9, backBurnerCandidateCount: 1, totalCount: 100 });
  assert.equal(jobSeekerCount, 7);
  assert.deepEqual(stageCounts.map((s) => s.label), ['Job Seeker', 'Active', 'Back Burner']);
});

test('the request log keeps shapes and numbers but blanks text such as candidate names', () => {
  const shape = data.skeleton({ total: 2, content: [{ title: 'Driver', jobNumber: 252, candidates: [{ name: 'Lisa Smith', email: 'l@x.com' }] }] });
  const text = JSON.stringify(shape);
  assert.match(text, /Driver/);
  assert.match(text, /252/);
  assert.doesNotMatch(text, /Lisa Smith|l@x\.com/);
});

test('the replayed request asks for big pages, steps through pages, and turns off "my jobs only"', () => {
  const recipe = { url: JOBS_URL, method: 'GET', headers: {}, body: null, path: ['content'], titleKey: 'title', idKey: 'jobNumber' };
  const first = new URL(data.buildRequest(recipe, { pageIndex: 0 }).url);
  assert.equal(first.searchParams.get('size'), '500');
  assert.equal(first.searchParams.get('page'), '0');
  assert.equal(first.searchParams.get('myJobs'), 'false');
  assert.equal(new URL(data.buildRequest(recipe, { pageIndex: 2 }).url).searchParams.get('page'), '2');
});

test('JSON request bodies are adjusted the same way', () => {
  const recipe = { url: 'https://recruitingbypaycor.com/api/jobs', method: 'POST', headers: {}, body: { filter: { onlyMine: true }, paging: { offset: 0, limit: 25 } }, path: ['jobs'] };
  const { init, changedScope } = data.buildRequest(recipe, { pageIndex: 1 });
  assert.equal(changedScope, true);
  assert.deepEqual(JSON.parse(init.body), { filter: { onlyMine: false }, paging: { offset: 500, limit: 500 } });
});

test('saved headers never include the cookie; cookies are sent only to matching Paycor hosts', () => {
  assert.equal(data.sanitizeHeaders({ cookie: 'x', Accept: 'json', ':authority': 'a' }).cookie, undefined);
  const header = data.cookieHeaderFor('https://recruitingbypaycor.com/api/jobs', [
    { name: 'NSESSIONID', value: 's', domain: '.recruitingbypaycor.com' },
    { name: 'other', value: 'o', domain: 'example.com' },
  ]);
  assert.equal(header, 'NSESSIONID=s');
});

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const body = pages.shift();
    if (body === 'LOGIN') return { status: 302, ok: false, headers: { get: () => 'https://recruitingbypaycor.com/login' }, text: async () => '' };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

test('fetchAllJobs collects every page and reports "All Jobs" once the my-jobs switch was turned off', async () => {
  const recipe = { url: JOBS_URL, method: 'GET', headers: {}, body: null, path: ['content'], titleKey: 'title', idKey: 'jobNumber' };
  const { impl, calls } = fakeFetch([
    { totalElements: 3, content: jobsPayload.content },
    { totalElements: 3, content: [{ jobNumber: 224, title: 'Test Job' }] },
  ]);
  const result = await data.fetchAllJobs(recipe, [], { fetchImpl: impl });
  assert.deepEqual(result.jobs.map((j) => j.jobId), ['220', '222', '224']);
  assert.equal(result.scope, 'All Jobs');
  assert.equal(result.scopeNote, null);
  assert.equal(calls.length, 2);
});

test('fetchAllJobs turns a redirect to the login page into a login-required error', async () => {
  const recipe = { url: JOBS_URL, method: 'GET', headers: {}, body: null, path: ['content'], titleKey: 'title', idKey: 'jobNumber' };
  const { impl } = fakeFetch(['LOGIN']);
  await assert.rejects(data.fetchAllJobs(recipe, [], { fetchImpl: impl }), (err) => err.code === 'LOGIN_REQUIRED');
});

test('fetchAllJobs fails loudly when Paycor changes the response layout', async () => {
  const recipe = { url: JOBS_URL, method: 'GET', headers: {}, body: null, path: ['content'], titleKey: 'title', idKey: 'jobNumber' };
  const { impl } = fakeFetch([{ somethingElse: [] }]);
  await assert.rejects(data.fetchAllJobs(recipe, [], { fetchImpl: impl }), /expected layout/);
});

test('findJobCard builds the Job Seeker list link for jobs that came from the data request', async () => {
  const { matches } = await actions.findJobCard(null, '220', { jobs: [{ jobId: '220', title: 'Power Automation Analyst', jobSeekerCount: null }] });
  assert.equal(matches.length, 1);
  assert.match(decodeURIComponent(matches[0].jobSeekerHref), /"name":"jobId","query":"220"/);
});
