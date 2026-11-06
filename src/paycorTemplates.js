// Reads the list of email templates that exist in Paycor — the same lists Paycor's own "send email"
// dialog on a candidate profile builds its template picker from — so Settings can offer a dropdown
// instead of asking people to type template names exactly.
//
// Paycor's dialog (AngularJS `getCommonEmailTemplate`, confirmed by reading Paycor's page code on
// 2026-10-19) shows two groups:
//   "Your Personal Templates"          ← GET /api/UserEmailTemplate_searchUserEmailTemplates.action?companyId&userId
//                                         (customTemplates of the logged-in user)
//   "Templates Shared by Other People" ← GET /api/UserEmailTemplate_getCompanyTemplatesLibrary.action?companyId
//                                         (customTemplates in the company library, minus the user's own)
// The user id comes from GET /api/Login_getCurrentUserInfo.action. All three are replayed with the
// saved login cookies (no browser window). Read-only: nothing here changes Paycor data.
//
// Only template ids, names and which group they're in are kept. Template bodies, subjects and the
// names of the people who own shared templates are dropped straight away and never stored.

const fs = require('fs');
const path = require('path');
const { callPaycor, PaycorAuthError } = require('./paycorData');
const { readSession } = require('./edge');
const { stripBom } = require('./stripBom');

const BASE = 'https://recruitingbypaycor.com';
const COMPANY_ID_RE = /^[0-9a-f]{32}$/i;
const GROUP = Object.freeze({ PERSONAL: 'personal', SHARED: 'shared' });
const GET_INIT = Object.freeze({ method: 'GET', headers: { accept: 'application/json, text/plain, */*' }, redirect: 'manual' });

/** Template names go into a CSS attribute selector when the email is sent (src/paycor-actions.js). */
function usableName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 300 && !/["\\\r\n]/.test(name);
}

/**
 * Pure: turns Paycor's two template responses into one list.
 * @returns {Array<{id: string, name: string, group: 'personal'|'shared', sharedWithTeam: boolean, usable: boolean}>}
 */
function mapTemplateLists(personalJson, libraryJson, userId) {
  const personal = personalJson && Array.isArray(personalJson.customTemplates) ? personalJson.customTemplates : null;
  const library = libraryJson && Array.isArray(libraryJson.customTemplates) ? libraryJson.customTemplates : null;
  if (!personal && !library) throw new Error("Paycor's email template data no longer has the expected layout.");

  const libraryIds = new Set((library || []).map((t) => t && String(t.id)));
  const out = [];
  const seen = new Set();
  const add = (t, group) => {
    if (!t || typeof t.title !== 'string' || !t.title.trim() || t.id == null) return;
    const id = String(t.id);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      name: t.title, // kept exactly as Paycor has it — the send step matches it character for character
      group,
      // Colleagues only see a template if it's in the company library (shared). A personal template
      // that isn't shared exists only in this person's own Paycor account.
      sharedWithTeam: group === GROUP.SHARED || libraryIds.has(id) || t.shared === true,
      usable: usableName(t.title),
    });
  };
  for (const t of personal || []) add(t, GROUP.PERSONAL);
  for (const t of library || []) if (!t || String(t.userId) !== String(userId)) add(t, GROUP.SHARED);
  // The person's own shared templates are in the library too; Paycor lists them under "personal".
  for (const t of library || []) if (t && String(t.userId) === String(userId)) add(t, GROUP.PERSONAL);

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return out.sort((a, b) => (a.group === b.group ? collator.compare(a.name, b.name) : a.group === GROUP.PERSONAL ? -1 : 1));
}

function companyIdFrom(cookies, userInfo, preferred) {
  if (preferred && COMPANY_ID_RE.test(preferred)) return preferred;
  const cookie = (cookies || []).find((c) => c.name === 'selectedClientId' && COMPANY_ID_RE.test(String(c.value)));
  if (cookie) return cookie.value;
  const companies = (userInfo && Array.isArray(userInfo.authorizedcompanylist) && userInfo.authorizedcompanylist) || [];
  const ids = companies.map((c) => c && c.id).filter((id) => COMPANY_ID_RE.test(String(id)));
  return ids.length === 1 ? ids[0] : null;
}

async function getJson(url, cookies, fetchImpl) {
  try {
    return await callPaycor(url, GET_INIT, cookies, fetchImpl);
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') throw err;
    throw new Error(`Paycor's email template list could not be read (${err.message.replace(/ for the job list request\.?$/, '')}).`);
  }
}

/**
 * Fetches the email templates this Paycor login can use. No browser window.
 * @returns {Promise<{templates: Array, companyId: string}>}
 */
async function fetchEmailTemplates(cookies, { fetchImpl = fetch, companyId = null } = {}) {
  if (!Array.isArray(cookies) || !cookies.length) throw new PaycorAuthError('There is no saved Paycor login on this computer.');
  const userInfo = await getJson(`${BASE}/api/Login_getCurrentUserInfo.action`, cookies, fetchImpl);
  if (userInfo && userInfo.success === false) throw new PaycorAuthError('Paycor says the saved login has expired.');
  const userId = userInfo && userInfo.id;
  if (!/^\d{1,12}$/.test(String(userId ?? ''))) throw new Error("Paycor's user details no longer have the expected layout.");
  const company = companyIdFrom(cookies, userInfo, companyId);
  if (!company) throw new Error('Could not tell which Paycor company this login belongs to.');

  const q = (params) => new URLSearchParams(params).toString();
  const personal = await getJson(`${BASE}/api/UserEmailTemplate_searchUserEmailTemplates.action?${q({ companyId: company, userId: String(userId) })}`, cookies, fetchImpl);
  const library = await getJson(`${BASE}/api/UserEmailTemplate_getCompanyTemplatesLibrary.action?${q({ companyId: company })}`, cookies, fetchImpl);
  return { templates: mapTemplateLists(personal, library, userId), companyId: company };
}

// --- Cache in %LOCALAPPDATA% ---------------------------------------------------------------------

function readTemplateCache(file) {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return { syncedAt: data.syncedAt || null, templates: Array.isArray(data.templates) ? data.templates : [] };
  } catch {
    return { syncedAt: null, templates: [] };
  }
}

function writeTemplateCache(file, templates) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  // Whitelist the fields so nothing else from Paycor can ever end up in the file.
  const clean = templates.map(({ id, name, group, sharedWithTeam, usable }) => ({ id, name, group, sharedWithTeam, usable }));
  fs.writeFileSync(tmp, JSON.stringify({ syncedAt: new Date().toISOString(), templates: clean }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return readTemplateCache(file);
}

/** Reads the templates with the saved login and caches them. Throws LOGIN_REQUIRED if the login is gone. */
async function refreshEmailTemplates(p, { fetchImpl = fetch } = {}) {
  const session = readSession(p.sessionFile);
  const { templates } = await fetchEmailTemplates(session && session.cookies, { fetchImpl });
  return writeTemplateCache(p.emailTemplatesFile, templates);
}

module.exports = { fetchEmailTemplates, mapTemplateLists, companyIdFrom, readTemplateCache, writeTemplateCache, refreshEmailTemplates, usableName, GROUP };
