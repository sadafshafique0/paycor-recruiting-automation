const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkHours, isWithinWorkHours, describeWorkHours } = require('../src/workHours');

const NY = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: 'America/New_York' };

test('Autopilot work hours: weekdays between start and end, in the chosen time zone', () => {
  // Tuesday 2026-10-20, 10:00 in New York = 14:00 UTC
  assert.equal(isWithinWorkHours(new Date('2026-10-20T14:00:00Z'), NY), true);
  assert.equal(isWithinWorkHours(new Date('2026-10-20T12:59:00Z'), NY), false); // 08:59 New York
  assert.equal(isWithinWorkHours(new Date('2026-10-20T22:00:00Z'), NY), false); // 18:00 New York — the day has ended
  assert.equal(isWithinWorkHours(new Date('2026-10-24T15:00:00Z'), NY), false); // Saturday
  // Same instant, Tokyo time zone: 23:00 there → outside
  assert.equal(isWithinWorkHours(new Date('2026-10-20T14:00:00Z'), { ...NY, timeZone: 'Asia/Tokyo' }), false);
});

test('work hours are checked and explained in plain language', () => {
  assert.match(describeWorkHours(NY), /Mon–Fri, 09:00–18:00 \(America\/New_York\)/);
  assert.ok(normalizeWorkHours({ days: [], start: '09:00', end: '18:00', timeZone: 'UTC' }).problems.length);
  assert.ok(normalizeWorkHours({ days: [1], start: '18:00', end: '09:00', timeZone: 'UTC' }).problems.length);
  assert.ok(normalizeWorkHours({ days: [1], start: '09:00', end: '18:00', timeZone: 'Mars/Base' }).problems.length);
  assert.deepEqual(normalizeWorkHours(undefined).workHours.days, [1, 2, 3, 4, 5]); // default Mon–Fri
});
