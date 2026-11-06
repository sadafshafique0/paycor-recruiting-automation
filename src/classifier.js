// State-aware reply classifier. The same reply text means something different depending on
// which email prompted it: First Contact / Attention-to-Detail tracks are checked against the
// color-word-or-email attention-to-detail rule, while Fluency track replies aren't
// content-classified at all — the engine only needs to know whether a real submission arrived.
//
// Deliberately NOT an LLM call: this is a narrow, auditable, free check. Anything it can't
// confidently call (a real question, an empty reply) comes back as 'query', which the track
// machine always routes to manual review rather than guessing.
// Ported as-is from Paycor-Outreach-Toolkit/src/classifier.js.

const { TRACK } = require('./engine/constants');
const { stripQuote } = require('./quoteStrip');
const COLOR_WORDS = require('./colorWords');

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function hasColorWord(text) {
  return COLOR_WORDS.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(text));
}

const FLUENCY_TRACKS = new Set([TRACK.FLUENCY, TRACK.FLUENCY_REMINDED]);

/**
 * @param {string} rawText - full reply body, including quoted original message
 * @param {{track: string, attempt?: number}} context
 * @returns {{outcome: 'pass'|'fail'|'query'|'submitted', reason: string, hasColor?: boolean, hasEmail?: boolean, hasQuestion?: boolean}}
 */
function classifyReply(rawText, context) {
  const text = stripQuote(rawText);

  if (FLUENCY_TRACKS.has(context.track)) {
    if (!text) {
      return { outcome: 'query', reason: 'empty reply on fluency track — could not confirm a real submission' };
    }
    return { outcome: 'submitted', reason: 'non-empty reply received on fluency track' };
  }

  if (!text) {
    return { outcome: 'query', reason: 'empty reply after stripping quoted text' };
  }

  const hasQuestion = text.includes('?');
  const hasColor = hasColorWord(text);
  const hasEmail = EMAIL_RE.test(text);

  if (hasQuestion) {
    return { outcome: 'query', reason: 'reply contains a question — default to manual review', hasColor, hasEmail, hasQuestion };
  }
  if (hasColor || hasEmail) {
    const parts = [];
    if (hasColor) parts.push('color');
    if (hasEmail) parts.push('email');
    return { outcome: 'pass', reason: `stated ${parts.join(' and ')}`, hasColor, hasEmail, hasQuestion };
  }
  return { outcome: 'fail', reason: 'no color or email given', hasColor, hasEmail, hasQuestion };
}

module.exports = { classifyReply };
