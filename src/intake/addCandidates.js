// The one place a candidate ID enters the outreach state machine — used by the CLI, the
// dashboard's "Add candidates" form, and the screening sweep on an ACCEPT verdict. Never touches
// Paycor itself: the next scheduled run picks up NEW candidates and sends First Contact through
// the same audited executeAction() path everything else uses.

const { loadState, writeState, withFileLock } = require('../state/store');
const { newCandidateRecord } = require('../state/schema');
const { CANDIDATE_ID_RE } = require('../engine/constants');

/**
 * @param {string} stateFilePath
 * @param {Array<{id: string, name: string}>} entries
 * @param {string} pipelineKey
 * @param {string} [nowIso]
 * @returns {{added: string[], skipped: {id: string, reason: string}[]}}
 */
function addCandidates(stateFilePath, entries, pipelineKey, nowIso = new Date().toISOString()) {
  if (!pipelineKey) throw new Error('addCandidates: pipelineKey is required');

  return withFileLock(stateFilePath, () => {
    const state = loadState(stateFilePath);
    const added = [];
    const skipped = [];

    for (const entry of entries) {
      if (!entry || !entry.id) {
        skipped.push({ id: entry && entry.id, reason: 'missing id' });
        continue;
      }
      if (!CANDIDATE_ID_RE.test(entry.id)) {
        skipped.push({ id: entry.id, reason: 'not a valid Paycor candidate ID' });
        continue;
      }
      if (state[entry.id]) {
        skipped.push({ id: entry.id, reason: `already tracked (track=${state[entry.id].track})` });
        continue;
      }
      state[entry.id] = newCandidateRecord({ id: entry.id, name: entry.name || '(unknown name)', pipelineKey }, nowIso);
      added.push(entry.id);
    }

    writeState(stateFilePath, state);
    return { added, skipped };
  });
}

module.exports = { addCandidates };
