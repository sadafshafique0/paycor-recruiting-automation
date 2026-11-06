// Calendar-day timer math. Deliberately date-only (midnight-to-midnight), not elapsed
// milliseconds, so "3 days" means "3 calendar days have turned over" regardless of what time
// of day an email went out or what time of day the daily run happens to fire.
//
// Missed-day safety rule: this module never lets elapsed time skip a step. A candidate can
// only become timeout-eligible if its track is already a "*_REMINDED" track (i.e. the
// reminder action has actually executed and been recorded in the state store) — so even if
// a run was skipped for a week and 10 days have elapsed since the original send, a candidate
// still stuck on e.g. FIRST_CONTACT (never reminded) is only ever offered TIMER_DUE_REMINDER,
// never TIMER_DUE_TIMEOUT. See constants.js for the track lists this switches on.
//
// Ported as-is from Paycor-Outreach-Toolkit/src/engine/timers.js.

const {
  AWAITING_FIRST_REPLY_TRACKS,
  AWAITING_AFTER_REMINDER_TRACKS,
  DEFAULT_TIMER_CONFIG,
} = require('./constants');

function toDateOnly(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function calendarDaysBetween(fromIsoOrDate, toIsoOrDate) {
  const from = toDateOnly(fromIsoOrDate);
  const to = toDateOnly(toIsoOrDate);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((to.getTime() - from.getTime()) / msPerDay);
}

/**
 * Decide whether a timer-driven event is due for a candidate today.
 *
 * @param {{track: string, awaitingReplySince: string|null, reminderSentAt: string|null}} candidate
 * @param {Date|string} now
 * @param {{reminderAfterDays: number, timeoutAfterReminderDays: number}} [config]
 * @returns {{type: 'TIMER_DUE_REMINDER'} | {type: 'TIMER_DUE_TIMEOUT'} | null}
 */
function evaluateTimer(candidate, now, config = DEFAULT_TIMER_CONFIG) {
  if (!candidate.awaitingReplySince) return null;

  if (AWAITING_AFTER_REMINDER_TRACKS.includes(candidate.track)) {
    const since = candidate.reminderSentAt || candidate.awaitingReplySince;
    const daysSinceReminder = calendarDaysBetween(since, now);
    if (daysSinceReminder >= config.timeoutAfterReminderDays) {
      return { type: 'TIMER_DUE_TIMEOUT' };
    }
    return null;
  }

  if (AWAITING_FIRST_REPLY_TRACKS.includes(candidate.track)) {
    const daysSince = calendarDaysBetween(candidate.awaitingReplySince, now);
    if (daysSince >= config.reminderAfterDays) {
      return { type: 'TIMER_DUE_REMINDER' };
    }
    return null;
  }

  return null; // terminal track, or NEW (not yet sent anything) — no timer applies
}

module.exports = { evaluateTimer, calendarDaysBetween };
