const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tpl = require('../src/paycorTemplates');

const COMPANY = '8a7883d08675eec501867a6a925901d3';
const ME = 662696;
const cookies = [
  { name: 'NSESSIONID', value: 'sess', domain: '.recruitingbypaycor.com' },
  { name: 'selectedClientId', value: COMPANY, domain: '.recruitingbypaycor.com' },
  { name: 'other', value: 'nope', domain: '.example.com' },
];

// Shapes as Paycor returned them on 2026-10-19 (bodies/owner names replaced with placeholders).
const personal = {
  userId: ME,
  companyId: COMPANY,
  customTemplates: [
    { id: 11, title: 'Step 3.2 - Manager: Confirm Phone Screen', template: '<p>BODY</p>', shared: false, templateType: 6 },
    { id: 12, title: 'My shared one', template: '<p>BODY</p>', shared: true, templateType: 6 },
  ],
  interviewFeedbackTemplates: [{ id: 13, title: 'Default: Interview Feedback Request' }],
};
const library = {
  companyId: COMPANY,
  customTemplates: [
    { id: 21, title: 'Intro Email', userId: 654128, firstName: 'Someone', lastName: 'Else', template: '<p>BODY</p>' },
    { id: 22, title: 'Detail Check Email', userId: 654128, firstName: 'Someone', lastName: 'Else', template: '<p>BODY</p>' },
    { id: 23, title: 'Detail Check Email', userId: 700000, firstName: 'Third', lastName: 'Person', template: '<p>BODY</p>' },
    { id: 12, title: 'My shared one', userId: ME, template: '<p>BODY</p>' },
    { id: 24, title: 'Bad "quoted" name', userId: 654128, template: '' },
  ],
  candidateInviteTemplates: [{ id: 31, title: 'Reading Onsite Interview Invite' }],
};

test('mapTemplateLists groups templates the way Paycor\'s send-email dialog does', () => {
  const list = tpl.mapTemplateLists(personal, library, ME);
  const byId = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), ['11', '12', '21', '22', '23', '24']); // only customTemplates, no duplicates by id
  assert.equal(byId['11'].group, 'personal');
  assert.equal(byId['11'].sharedWithTeam, false); // personal, not in the company library
  assert.equal(byId['12'].group, 'personal');
  assert.equal(byId['12'].sharedWithTeam, true); // the person's own template, shared in the library
  assert.equal(byId['21'].group, 'shared');
  assert.equal(byId['21'].sharedWithTeam, true);
  assert.equal(byId['24'].usable, false); // a quote would break the exact-name match when sending
  assert.equal(byId['21'].usable, true);
  // personal first, then shared, each in natural name order
  assert.deepEqual(list.map((t) => t.group), ['personal', 'personal', 'shared', 'shared', 'shared', 'shared']);
  // nothing but id/name/group/flags — no bodies, no owner names
  for (const t of list) assert.deepEqual(Object.keys(t).sort(), ['group', 'id', 'name', 'sharedWithTeam', 'usable']);
});

test('mapTemplateLists keeps names exactly as Paycor has them', () => {
  const list = tpl.mapTemplateLists({ customTemplates: [{ id: 1, title: ' Step 1.0 – Recruiter Interest ' }] }, null, ME);
  assert.equal(list[0].name, ' Step 1.0 – Recruiter Interest ');
});

test('mapTemplateLists fails loudly when Paycor changes the layout', () => {
  assert.throws(() => tpl.mapTemplateLists({ templates: [] }, { items: [] }, ME), /expected layout/);
});

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    const body = hit ? hit[1] : null;
    if (body === 'LOGIN') return { status: 302, ok: false, headers: { get: (h) => (h === 'location' ? 'https://recruitingbypaycor.com/api/Login_checkSession.action' : null) }, text: async () => '' };
    if (body == null) return { status: 404, ok: false, headers: { get: () => null }, text: async () => 'not found' };
    return { status: 200, ok: true, headers: { get: () => 'text/plain;charset=UTF-8' }, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

const BASE = 'https://recruitingbypaycor.com/api/';

test('fetchEmailTemplates reads the user id, then both template lists, with the saved login only', async () => {
  const { impl, calls } = fakeFetch({
    [`${BASE}Login_getCurrentUserInfo.action`]: { id: ME, success: true, authorizedcompanylist: [{ id: COMPANY }] },
    [`${BASE}UserEmailTemplate_searchUserEmailTemplates.action`]: personal,
    [`${BASE}UserEmailTemplate_getCompanyTemplatesLibrary.action`]: library,
  });
  const out = await tpl.fetchEmailTemplates(cookies, { fetchImpl: impl });
  assert.equal(out.companyId, COMPANY);
  assert.equal(out.templates.length, 6);
  assert.equal(calls.length, 3);
  assert.match(calls[1].url, new RegExp(`companyId=${COMPANY}&userId=${ME}$`));
  assert.match(calls[2].url, new RegExp(`companyId=${COMPANY}$`));
  for (const c of calls) {
    assert.equal(c.init.method, 'GET'); // read-only
    assert.equal(c.init.headers.cookie, `NSESSIONID=sess; selectedClientId=${COMPANY}`);
  }
});

test('fetchEmailTemplates reports an expired login as LOGIN_REQUIRED', async () => {
  const { impl } = fakeFetch({ [`${BASE}Login_getCurrentUserInfo.action`]: 'LOGIN' });
  await assert.rejects(tpl.fetchEmailTemplates(cookies, { fetchImpl: impl }), (err) => err.code === 'LOGIN_REQUIRED');
  await assert.rejects(tpl.fetchEmailTemplates([], { fetchImpl: impl }), (err) => err.code === 'LOGIN_REQUIRED');
  const { impl: noSuccess } = fakeFetch({ [`${BASE}Login_getCurrentUserInfo.action`]: { success: false } });
  await assert.rejects(tpl.fetchEmailTemplates(cookies, { fetchImpl: noSuccess }), (err) => err.code === 'LOGIN_REQUIRED');
});

test('fetchEmailTemplates explains other failures without calling them a login problem', async () => {
  const { impl } = fakeFetch({ [`${BASE}Login_getCurrentUserInfo.action`]: { id: ME } });
  await assert.rejects(tpl.fetchEmailTemplates(cookies, { fetchImpl: impl }), (err) => err.code !== 'LOGIN_REQUIRED' && /template list could not be read/.test(err.message));
});

test('companyIdFrom prefers the selected company cookie, then a single authorized company', () => {
  assert.equal(tpl.companyIdFrom(cookies, null), COMPANY);
  assert.equal(tpl.companyIdFrom([], { authorizedcompanylist: [{ id: COMPANY }] }), COMPANY);
  assert.equal(tpl.companyIdFrom([], { authorizedcompanylist: [{ id: COMPANY }, { id: 'ffffffffffffffffffffffffffffffff' }] }), null);
});

test('the template cache keeps names and ids only, written atomically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-tpl-'));
  const file = path.join(dir, 'paycor-email-templates.json');
  const cache = tpl.writeTemplateCache(file, [{ id: '1', name: 'Intro Email', group: 'shared', sharedWithTeam: true, usable: true, template: '<p>BODY</p>', firstName: 'X' }]);
  assert.equal(cache.templates.length, 1);
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /BODY|firstName/);
  assert.ok(cache.syncedAt);
  assert.deepEqual(fs.readdirSync(dir), ['paycor-email-templates.json']); // no temp file left behind
  assert.deepEqual(tpl.readTemplateCache(path.join(dir, 'missing.json')), { syncedAt: null, templates: [] });
});
