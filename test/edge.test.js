const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveSession, closeEdge } = require('../src/edge');

function fakeContext(url, cookies) {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    pages: () => [{ url: () => url, evaluate: async () => ({ token: 'abc' }) }],
    cookies: async () => cookies,
    close: async () => {
      closed = true;
    },
  };
}

const COOKIES = [
  { name: 'NSESSIONID', value: 's', domain: '.recruitingbypaycor.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' },
  { name: 'other', value: 'x', domain: '.example.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' },
];

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apw-edge-')), 'session.json');
}

test('saves only Paycor cookies (including the session cookie) and sessionStorage from a logged-in page', async () => {
  const file = tmpFile();
  assert.equal(await saveSession(fakeContext('https://recruitingbypaycor.com/home', COOKIES), file), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.cookies.map((c) => c.name), ['NSESSIONID']);
  assert.deepEqual(saved.sessionStorage, { token: 'abc' });
});

test('never overwrites a good saved login while sitting on the login page', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{"cookies":[{"name":"good"}]}');
  assert.equal(await saveSession(fakeContext('https://recruitingbypaycor.com/login?redirect=%2Fhome', COOKIES), file), false);
  assert.match(fs.readFileSync(file, 'utf8'), /good/);
});

test('closeEdge saves the session, then closes the browser', async () => {
  const file = tmpFile();
  const ctx = fakeContext('https://recruitingbypaycor.com/candidate/abc', COOKIES);
  await closeEdge(ctx, { sessionFile: file });
  assert.equal(ctx.closed, true);
  assert.ok(fs.existsSync(file));
});
