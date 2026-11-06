// Candidate replies, read from the person's Paycor notifications — the same notifications Paycor
// shows when a candidate answers (confirmed 2026-10-19): GET /rest/notifications?pageSize&page, newest
// first, items like
//   { id, type: 'ECHO_RESPONSE_RECEIVED_FROM_CANDIDATE' (email reply) | 'TEXT_MESSAGE_RECEIVED_FROM_CANDIDATE',
//     createdDateUtc, body: the reply itself (email HTML or the text message),
//     extensionData: { candidateId, jobId (Paycor's internal job id), … } }
// Read-only: only GET is used. Marking notifications read is a separate POST that this app never calls,
// so the person's unread notifications stay exactly as they were.
//
// Notifications are per Paycor user: replies to emails sent from this login. That's why a real run still
// checks a candidate's profile before a reminder or a pass (see confirmNoReply in src/engine/scheduler.js).

const { callPaycor } = require('./paycorData');
const { htmlToText } = require('./text');

const BASE = 'https://recruitingbypaycor.com';
const REPLY_TYPES = {
  ECHO_RESPONSE_RECEIVED_FROM_CANDIDATE: 'email',
  TEXT_MESSAGE_RECEIVED_FROM_CANDIDATE: 'text message',
};
const PAGE_SIZE = 100;

/**
 * Every candidate reply notification created after `sinceMs` (newest first), at most `maxPages` pages.
 * @returns {Promise<Array<{id, candidateId, internalJobId, via, at, html, text}>>}
 */
async function fetchReplyNotifications(cookies, company, { sinceMs = 0, fetchImpl = fetch, maxPages = 30 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${BASE}/rest/notifications?pageSize=${PAGE_SIZE}&page=${page}`;
    const json = await callPaycor(url, { method: 'GET', headers: { accept: 'application/json', 'client-id': company }, redirect: 'manual' }, cookies, fetchImpl);
    const items = json && Array.isArray(json.items) ? json.items : null;
    if (!items) throw new Error("Paycor's notification list no longer has the expected layout.");
    let olderSeen = false;
    for (const n of items) {
      const created = Number(n.createdDateUtc);
      if (created && created <= sinceMs) olderSeen = true;
      const via = REPLY_TYPES[n.type];
      const ext = n.extensionData || {};
      const candidateId = ext.candidateId || n.objectId;
      if (!via || !candidateId || !(created > sinceMs)) continue;
      const html = String(n.body || '');
      out.push({ id: `notification-${n.id}`, candidateId: String(candidateId), internalJobId: ext.jobId || null, via, at: new Date(created).toISOString(), html, text: via === 'email' ? htmlToText(html) : html.trim() });
    }
    // Newest first: once a page reaches back past `sinceMs`, nothing older is needed.
    if (olderSeen || items.length < PAGE_SIZE || (json.totalSize != null && (page + 1) * PAGE_SIZE >= json.totalSize)) break;
  }
  return out;
}

/**
 * A fetchReply for the outreach engine: the newest reply notification for this candidate since they
 * started waiting — for the same job when the notification names one. Returns the engine's reply
 * shape {text, html, messageId, via} or null.
 * @param {Array} replies - from fetchReplyNotifications
 * @param {(pipelineKey: string) => string|null} internalJobIdFor - the pipeline's job, as Paycor's internal id
 */
function replyFinder(replies, internalJobIdFor) {
  const byCandidate = new Map();
  for (const r of replies) {
    if (!byCandidate.has(r.candidateId)) byCandidate.set(r.candidateId, []);
    byCandidate.get(r.candidateId).push(r);
  }
  return async (candidate) => {
    const since = Date.parse(candidate.awaitingReplySince || 0) || 0;
    const job = internalJobIdFor(candidate.pipelineKey);
    const mine = (byCandidate.get(candidate.id) || [])
      .filter((r) => Date.parse(r.at) > since && (!r.internalJobId || !job || r.internalJobId === job))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (!mine.length) return null;
    const r = mine[0];
    return { text: r.text, html: r.html, messageId: r.id, via: r.via, at: r.at };
  };
}

module.exports = { fetchReplyNotifications, replyFinder, REPLY_TYPES };
