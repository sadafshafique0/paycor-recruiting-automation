// Reads the company's recruiting stages and their statuses from Paycor — the "stage library"
// Paycor's own settings pages use (GET /rest/stage-library?includeStatuses=true, found in Paycor's
// app code and confirmed live 2026-10-19: 24 stages, e.g. "Compatibility Evaluation" → "Resume
// Quick Screen", "Preliminary Screen Attempt 1", "Attention to Detail Review", …) — so Settings
// can offer each step's "move the candidate to" status as a dropdown instead of typed text.
//
// Read-only, with the saved login, no browser window. Only stage/status names and ids are kept.
// Hidden stages and hidden statuses (Paycor's own internal ones, e.g. offer-letter states) are left out.

const fs = require('fs');
const path = require('path');
const { callPaycor, PaycorAuthError } = require('./paycorData');
const { readSession } = require('./edge');
const { stripBom } = require('./stripBom');
const { companyIdFrom } = require('./paycorTemplates');

const STAGES_URL = 'https://recruitingbypaycor.com/rest/stage-library?includeStatuses=true';
const GET_INIT = Object.freeze({ method: 'GET', headers: { accept: 'application/json, text/plain, */*' }, redirect: 'manual' });

/** Pure: Paycor's stage library → [{ id, number, title, statuses: [{ id, title }] }] in Paycor's stage order. */
function mapStageLibrary(json) {
  const items = json && Array.isArray(json.items) ? json.items : null;
  if (!items) throw new Error("Paycor's stage list no longer has the expected layout.");
  return items
    .filter((s) => s && s.visible !== false && typeof s.title === 'string' && s.title.trim())
    .map((s) => ({
      id: String(s.id),
      number: Number(s.number) || 0,
      title: s.title,
      statuses: (Array.isArray(s.statuses) ? s.statuses : [])
        .filter((x) => x && x.visible !== false && typeof x.title === 'string' && x.title.trim())
        .sort((a, b) => (a.order ?? a.number ?? 0) - (b.order ?? b.number ?? 0))
        .map((x) => ({ id: String(x.id), number: Number(x.number), title: x.title })), // number = the status code in candidate lists; exact text: the status menu is matched character for character
    }))
    .filter((s) => s.statuses.length)
    .sort((a, b) => a.number - b.number);
}

// Paycor's /rest/ requests name the company in a client-id header (it answers 400 without it).
async function fetchStages(cookies, { fetchImpl = fetch, companyId = null } = {}) {
  if (!Array.isArray(cookies) || !cookies.length) throw new PaycorAuthError('There is no saved Paycor login on this computer.');
  const company = companyIdFrom(cookies, null, companyId);
  if (!company) throw new Error('Could not tell which Paycor company this login belongs to.');
  let json;
  try {
    json = await callPaycor(STAGES_URL, { ...GET_INIT, headers: { ...GET_INIT.headers, 'client-id': company } }, cookies, fetchImpl);
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') throw err;
    throw new Error(`Paycor's stage list could not be read (${err.message.replace(/ for the job list request\.?$/, '')}).`);
  }
  return mapStageLibrary(json);
}

function readStageCache(file) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return { syncedAt: data.syncedAt || null, stages: Array.isArray(data.stages) ? data.stages : [] };
  } catch {
    return { syncedAt: null, stages: [] };
  }
}

function writeStageCache(file, stages) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const clean = stages.map(({ id, number, title, statuses }) => ({ id, number, title, statuses: statuses.map(({ id: sid, number: n, title: st }) => ({ id: sid, number: n, title: st })) }));
  fs.writeFileSync(tmp, JSON.stringify({ syncedAt: new Date().toISOString(), stages: clean }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return readStageCache(file);
}

/** With the saved login (or `cookies`), reads the stages and caches them. Throws LOGIN_REQUIRED if the login is gone. */
async function refreshStages(p, { fetchImpl = fetch, cookies = null } = {}) {
  const session = cookies ? { cookies } : readSession(p.sessionFile);
  const stages = await fetchStages(session && session.cookies, { fetchImpl });
  return writeStageCache(p.stagesFile, stages);
}

module.exports = { fetchStages, mapStageLibrary, readStageCache, writeStageCache, refreshStages };
