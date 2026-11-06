const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchPaycorFile } = require('../src/paycorData');
const { pickResumeAttachments } = require('../src/paycor-actions');
const { extractText, detectKind } = require('../src/screening/resumeText');

const COOKIES = [{ name: 'NSESSIONID', value: 'secret', domain: '.recruitingbypaycor.com' }];

function response({ status = 200, headers = {}, body = '' }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => h[k.toLowerCase()] ?? null }, arrayBuffer: async () => Buffer.from(body) };
}

test('the resume download sends the login only to Paycor, never to the storage server it redirects to', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, cookie: init.headers.cookie || null });
    if (url.startsWith('https://recruitingbypaycor.com')) return response({ status: 302, headers: { location: 'https://files.example-storage.com/r.pdf?sig=1' } });
    return response({ headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="Jane Resume.pdf"' }, body: '%PDF-1.4 fake' });
  };
  const file = await fetchPaycorFile('https://recruitingbypaycor.com/attachments/abc', COOKIES, { fetchImpl });
  assert.equal(seen[0].cookie, 'NSESSIONID=secret');
  assert.equal(seen[1].cookie, null);
  assert.equal(file.fileName, 'Jane Resume.pdf');
});

test('a redirect to the login page is a login problem, and a web page is never read as a resume', async () => {
  await assert.rejects(
    fetchPaycorFile('https://recruitingbypaycor.com/attachments/abc', COOKIES, { fetchImpl: async () => response({ status: 302, headers: { location: '/login?redirect=x' } }) }),
    (err) => err.code === 'LOGIN_REQUIRED',
  );
  await assert.rejects(
    fetchPaycorFile('https://recruitingbypaycor.com/attachments/abc', COOKIES, { fetchImpl: async () => response({ headers: { 'content-type': 'text/html' }, body: '<html>' }) }),
    /web page instead/,
  );
});

test('the typing test or an offer letter is not mistaken for the resume', () => {
  const picks = pickResumeAttachments([
    { href: '/attachments/1', descriptor: 'typingtest certificate.pdf' },
    { href: '/attachments/2', descriptor: 'Jane_Doe_Resume.pdf' },
    { href: '/attachments/3', descriptor: 'Offer Letter.pdf' },
  ]);
  assert.deepEqual(picks.map((p) => p.href), ['/attachments/2']);
  // When the Resume tab names the file, that one wins.
  assert.deepEqual(pickResumeAttachments([{ href: '/a', descriptor: 'cover.pdf' }, { href: '/b', descriptor: 'CV 2026.docx' }], ['CV 2026']).map((p) => p.href), ['/b']);
});

test('file types are recognised from their content, not just their name', async () => {
  assert.equal(detectKind(Buffer.from('%PDF-1.7'), 'resume.bin'), 'pdf');
  assert.equal(detectKind(Buffer.from([0x50, 0x4b, 3, 4]), 'resume'), 'docx');
  const rtf = await extractText(Buffer.from('{\\rtf1\\ansi CDL driver\\par 5 years}'), { fileName: 'r.rtf' });
  assert.match(rtf.text, /CDL driver/);
});
