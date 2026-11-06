const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyReply } = require('../src/classifier');
const { TRACK } = require('../src/engine/constants');

test('stated color word -> pass', () => {
  const r = classifyReply('My favorite color is blue, thanks!', { track: TRACK.FIRST_CONTACT });
  assert.equal(r.outcome, 'pass');
});

test('stated an email address -> pass', () => {
  const r = classifyReply('You can reach me at jane@example.com', { track: TRACK.FIRST_CONTACT });
  assert.equal(r.outcome, 'pass');
});

test('neither color nor email -> fail', () => {
  const r = classifyReply('Looking forward to the next step!', { track: TRACK.ATTENTION_1 });
  assert.equal(r.outcome, 'fail');
});

test('a real question -> query, even if it also contains a color word', () => {
  const r = classifyReply('Is blue an acceptable answer or do you need something else?', { track: TRACK.FIRST_CONTACT });
  assert.equal(r.outcome, 'query');
});

test('empty reply after quote-stripping -> query', () => {
  const r = classifyReply('> On Mon, Jane wrote:\n> please reply with your favorite color', { track: TRACK.FIRST_CONTACT });
  assert.equal(r.outcome, 'query');
});

test('fluency track: any non-empty reply is "submitted", not content-classified', () => {
  const r = classifyReply('Here is my recording: https://voca.ro/abc123', { track: TRACK.FLUENCY });
  assert.equal(r.outcome, 'submitted');
});

test('fluency track: empty reply is a query, not a silent submission', () => {
  const r = classifyReply('', { track: TRACK.FLUENCY });
  assert.equal(r.outcome, 'query');
});
