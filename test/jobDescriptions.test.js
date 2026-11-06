const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { syncJobDescriptions, readJobDescriptions, descriptionText } = require('../src/jobDescriptions');
const { fetchJobDescription } = require('../src/paycorData');

const COOKIES = [{ name: 'NSESSIONID', value: 's', domain: '.recruitingbypaycor.com' }];
const ok = (obj) => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(obj) });

test('a job description is read from Paycor\'s own description request, with the login', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, cookie: init.headers.cookie };
    return ok({ id: 'abc123', description: '<p>Drive the shuttle</p>', spanishDescription: '' });
  };
  const d = await fetchJobDescription('abc123', COOKIES, { fetchImpl });
  assert.equal(seen.url, 'https://recruitingbypaycor.com/api/Job_showDescription.action?id=abc123');
  assert.equal(seen.cookie, 'NSESSIONID=s');
  assert.equal(d.html, '<p>Drive the shuttle</p>');
  await assert.rejects(fetchJobDescription('../x', COOKIES, { fetchImpl }), /internal ID/);
});

test('descriptions become readable text: paragraphs, bullets and typographic characters', () => {
  assert.equal(descriptionText('<p>We&rsquo;re hiring</p><ul><li>CDL &ndash; required</li><li>2 years</li></ul>'), 'We’re hiring\n• CDL – required\n• 2 years');
});

test('all jobs are copied; later refreshes only fetch missing or day-old ones; one failure is skipped', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apw-jd-')), 'jd.json');
  const jobs = [
    { jobId: '252', internalId: 'a1', title: 'Shuttle Van Driver' },
    { jobId: '248', internalId: 'a2', title: 'Body Technician' },
    { jobId: '9', internalId: null, title: 'No internal id' },
  ];
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    if (url.endsWith('a2')) return { status: 500, ok: false, headers: { get: () => null }, text: async () => '' };
    return ok({ description: '<p>Text</p>' });
  };
  const now = Date.parse('2026-10-19T12:00:00Z');
  const first = await syncJobDescriptions(jobs, COOKIES, file, { fetchImpl, now });
  assert.deepEqual(first, { fetched: 1, failed: 1, kept: 1 });
  assert.equal(readJobDescriptions(file).jobs['252'].text, 'Text');

  calls = 0;
  await syncJobDescriptions(jobs, COOKIES, file, { fetchImpl, now: now + 60_000 });
  assert.equal(calls, 1); // only the one that failed is retried
  calls = 0;
  await syncJobDescriptions(jobs, COOKIES, file, { fetchImpl, now: now + 25 * 3600_000 });
  assert.equal(calls, 2); // a day later both are refreshed
});

test('an expired login stops the copy and is reported, without losing what was saved', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apw-jd-')), 'jd.json');
  const expired = async () => ({ status: 401, ok: false, headers: { get: () => null }, text: async () => '' });
  await assert.rejects(syncJobDescriptions([{ jobId: '1', internalId: 'a' }], COOKIES, file, { fetchImpl: expired }), (e) => e.code === 'LOGIN_REQUIRED');
  assert.deepEqual(readJobDescriptions(file).jobs, {});
});
