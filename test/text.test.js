const { test } = require('node:test');
const assert = require('node:assert/strict');
const { htmlToText, findVocarooLink } = require('../src/text');
const { classifyReply } = require('../src/classifier');
const { TRACK } = require('../src/engine/constants');

test('htmlToText turns <br> and block ends into line breaks and decodes entities', () => {
  assert.equal(htmlToText('<p>Hi&nbsp;there</p><div>a &amp; b</div>line<br/>two'), 'Hi there\na & b\nline\ntwo');
});

test('regression: a non-answer reply quoting a thread with an email header is a fail, not a pass', () => {
  const html = 'Thanks, looking forward to it!<br><br>From: Alex &lt;alex@echo.newtonsoftware.com&gt;<br>Sent: Monday<br>Reply with your favorite color and active email.';
  const result = classifyReply(htmlToText(html), { track: TRACK.FIRST_CONTACT });
  assert.equal(result.outcome, 'fail');
});

test('findVocarooLink finds a link that only appears in an href', () => {
  assert.equal(findVocarooLink('<a href="https://voca.ro/abc123">my recording</a>'), 'https://voca.ro/abc123');
  assert.equal(findVocarooLink('no link here'), null);
});
