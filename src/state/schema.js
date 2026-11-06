// Ported as-is from Paycor-Outreach-Toolkit/src/state/schema.js.
const { TRACK } = require('../engine/constants');

const SCHEMA_VERSION = 1;

/**
 * @param {{id: string, name: string, pipelineKey: string}} entry
 * @param {string} nowIso
 */
function newCandidateRecord(entry, nowIso) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: entry.id,
    name: entry.name,
    pipelineKey: entry.pipelineKey,
    track: TRACK.NEW,
    attempt: 0,
    status: 'active', // 'active' | 'terminal'
    lastEmailTemplate: null,
    lastEmailSentAt: null,
    awaitingReplySince: null,
    reminderSentAt: null,
    repliedAt: null,
    processedMessageIds: [],
    passReason: null,
    fluencyScore: null, // set once AUTO_SCORE_FLUENCY succeeds — see src/fluency/scorecardMapping.js
    errorState: null, // {message, at, retryCount}
    history: [{ at: nowIso, event: 'ADDED', detail: `pipeline=${entry.pipelineKey}` }],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

// Placeholder for future schema changes — bump SCHEMA_VERSION and add a case here rather
// than changing newCandidateRecord's shape retroactively for existing stored records.
function migrate(record) {
  if (!record.schemaVersion || record.schemaVersion === SCHEMA_VERSION) return record;
  throw new Error(`No migration path from schemaVersion ${record.schemaVersion} to ${SCHEMA_VERSION}`);
}

module.exports = { SCHEMA_VERSION, newCandidateRecord, migrate };
