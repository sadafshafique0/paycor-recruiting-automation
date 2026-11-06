// Work hours for the Autopilot: it only starts cycles on these days, between these times, in this time
// zone (2026-10-19: "run in our work hours only"). Outside them nothing is screened or emailed.

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function defaultTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_WORK_HOURS = Object.freeze({ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });

/** Fills in defaults; returns {workHours, problems}. days: 0 = Sunday … 6 = Saturday. */
function normalizeWorkHours(input) {
  const problems = [];
  const raw = input && typeof input === 'object' ? input : {};
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [...DEFAULT_WORK_HOURS.days];
  const start = raw.start == null ? DEFAULT_WORK_HOURS.start : String(raw.start);
  const end = raw.end == null ? DEFAULT_WORK_HOURS.end : String(raw.end);
  const timeZone = raw.timeZone == null || raw.timeZone === '' ? defaultTimeZone() : String(raw.timeZone);
  if (!days.length) problems.push('Choose at least one work day.');
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) problems.push('Work hours must look like 09:00 and 18:00.');
  else if (start >= end) problems.push('The work day must end after it starts.');
  if (!validTimeZone(timeZone)) problems.push(`"${timeZone}" isn't a time zone (e.g. America/New_York, Asia/Tokyo).`);
  return { workHours: { days, start, end, timeZone }, problems };
}

/** Day of week and "HH:MM" of `date` in the time zone. */
function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { day: DAY_NAMES.indexOf(get('weekday')), time: `${get('hour')}:${get('minute')}` };
}

function isWithinWorkHours(date, workHours) {
  const { workHours: wh } = normalizeWorkHours(workHours);
  const { day, time } = localParts(date, wh.timeZone);
  return wh.days.includes(day) && time >= wh.start && time < wh.end;
}

/** "Mon–Fri, 09:00–18:00 (America/New_York)" */
function describeWorkHours(workHours) {
  const { workHours: wh } = normalizeWorkHours(workHours);
  const weekdays = wh.days.join(',') === '1,2,3,4,5';
  const days = weekdays ? 'Mon–Fri' : wh.days.map((d) => DAY_NAMES[d]).join(', ');
  return `${days}, ${wh.start}–${wh.end} (${wh.timeZone})`;
}

module.exports = { normalizeWorkHours, isWithinWorkHours, describeWorkHours, DEFAULT_WORK_HOURS, DAY_NAMES, defaultTimeZone };
