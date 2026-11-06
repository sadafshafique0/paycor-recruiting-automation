const { test } = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTimer, calendarDaysBetween } = require('../src/engine/timers');
const { TRACK } = require('../src/engine/constants');

test('calendarDaysBetween counts calendar-day turnover, not 24h elapsed', () => {
  assert.equal(calendarDaysBetween('2026-01-01T23:00:00Z', '2026-01-02T01:00:00Z'), 1);
  assert.equal(calendarDaysBetween('2026-01-01T00:00:00Z', '2026-01-01T23:59:00Z'), 0);
});

test('no awaitingReplySince -> no timer ever fires', () => {
  const candidate = { track: TRACK.FIRST_CONTACT, awaitingReplySince: null, reminderSentAt: null };
  assert.equal(evaluateTimer(candidate, '2026-01-10'), null);
});

test('under 3 days on a first-wait track -> nothing due', () => {
  const candidate = { track: TRACK.FIRST_CONTACT, awaitingReplySince: '2026-01-01', reminderSentAt: null };
  assert.equal(evaluateTimer(candidate, '2026-01-03'), null);
});

test('exactly 3 days on a first-wait track -> reminder due', () => {
  const candidate = { track: TRACK.FIRST_CONTACT, awaitingReplySince: '2026-01-01', reminderSentAt: null };
  assert.deepEqual(evaluateTimer(candidate, '2026-01-04'), { type: 'TIMER_DUE_REMINDER' });
});

test('after reminder, 3 more days -> timeout due, measured from reminderSentAt', () => {
  const candidate = { track: TRACK.FIRST_CONTACT_REMINDED, awaitingReplySince: '2026-01-01', reminderSentAt: '2026-01-04' };
  assert.equal(evaluateTimer(candidate, '2026-01-06'), null);
  assert.deepEqual(evaluateTimer(candidate, '2026-01-07'), { type: 'TIMER_DUE_TIMEOUT' });
});

test('missed-day safety: 10 days elapsed but never reminded -> still just a reminder, never a skip to timeout', () => {
  const candidate = { track: TRACK.FIRST_CONTACT, awaitingReplySince: '2026-01-01', reminderSentAt: null };
  assert.deepEqual(evaluateTimer(candidate, '2026-01-11'), { type: 'TIMER_DUE_REMINDER' });
});

test('terminal tracks never produce a timer event', () => {
  const candidate = { track: TRACK.PASSED, awaitingReplySince: '2026-01-01', reminderSentAt: null };
  assert.equal(evaluateTimer(candidate, '2026-01-20'), null);
});
