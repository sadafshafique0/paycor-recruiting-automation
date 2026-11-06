// Reads job data the way Paycor's own web page does — from the JSON requests the page makes in the
// background — instead of scrolling the page and scraping what's drawn.
//
// How it works:
//   1. While the Paycor home page loads (in the login window), every JSON response from
//      recruitingbypaycor.com is recorded (captureJsonResponses).
//   2. The response that holds the job list is picked out by its shape — an array of objects with
//      a title and a numeric Job ID — and cross-checked against the job titles visible on screen
//      (discoverJobsRequest). The request is saved as a "recipe" (URL, method, headers, body).
//   3. That request is replayed directly with the saved login cookies, asking for large pages, so
//      every job comes back without a browser window or any scrolling (fetchAllJobs).
//
// These are Paycor's private website requests, not a published API, so they can change without
// notice. Anything that doesn't match the expected shape fails loudly (the caller falls back to
// reading the page) rather than returning wrong data. Read-only: nothing here changes Paycor data.

const fs = require('fs');
const path = require('path');

const PAYCOR_ORIGIN = 'https://recruitingbypaycor.com';
const TITLE_KEYS = ['title', 'jobTitle', 'name', 'positionTitle', 'jobName', 'displayTitle'];
const ID_KEYS = ['jobId', 'jobNumber', 'displayId', 'reqNumber', 'requisitionNumber', 'jobReqId', 'number', 'id', 'jobID'];
const TOTAL_KEYS = ['total', 'totalCount', 'totalElements', 'totalRecords', 'totalResults', 'numFound', 'recordsTotal', 'count'];
const PAGE_SIZE_KEYS = /^(size|pageSize|page_size|limit|rows|perPage|per_page|max|maxResults|take|numResults)$/i;
const PAGE_KEYS = /^(page|pageNumber|page_number|pageIndex|offset|start|skip|from)$/i;
const MY_JOBS_KEYS = /^(my|mine|myJobs|onlyMine|onlyMyJobs|ownedByMe|assignedToMe|isMyJobs|showMyJobs)$/i;
const DROP_HEADERS = new Set(['cookie', 'content-length', 'host', 'connection', 'accept-encoding', 'origin', 'referer']);
const STAGE_NAME_KEYS = ['name', 'stage', 'stageName', 'label', 'status', 'statusName', 'title'];
const STAGE_COUNT_KEYS = ['count', 'total', 'value', 'candidateCount', 'numCandidates'];

// ---------------------------------------------------------------------------------------------
// Capture (needs a live Playwright page)
// ---------------------------------------------------------------------------------------------

function captureJsonResponses(page) {
  const captures = [];
  const handler = async (response) => {
    try {
      const request = response.request();
      const url = response.url();
      if (!url.startsWith(PAYCOR_ORIGIN)) return;
      if (!['xhr', 'fetch'].includes(request.resourceType())) return;
      if (!/json/i.test(response.headers()['content-type'] || '')) return;
      const text = await response.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return;
      }
      const requestHeaders = await request.allHeaders().catch(() => request.headers());
      captures.push({ at: Date.now(), url, method: request.method(), status: response.status(), requestHeaders, postData: request.postData() || null, json, size: text.length });
    } catch {
      // a response that can't be read is simply not captured
    }
  };
  page.on('response', handler);
  return { captures, stop: () => page.off('response', handler) };
}

// ---------------------------------------------------------------------------------------------
// Discovery (pure — unit-tested)
// ---------------------------------------------------------------------------------------------

function* arraysOfObjects(value, pathParts = [], depth = 0) {
  if (depth > 5 || value == null) return;
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) yield { path: pathParts, items: value };
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* arraysOfObjects(v, [...pathParts, k], depth + 1);
  }
}

function getPath(obj, pathParts) {
  return pathParts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function pickKey(items, keys, test) {
  for (const key of keys) {
    const hits = items.filter((o) => test(o[key])).length;
    if (hits && hits >= Math.ceil(items.length * 0.8)) return key;
  }
  return null;
}

const isTitle = (v) => typeof v === 'string' && v.trim().length > 1 && v.length < 200;
const isNumericId = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e9) || (typeof v === 'string' && /^\d{1,9}$/.test(v));

/**
 * Picks the captured response that holds the job list.
 * @param {Array} captures - from captureJsonResponses
 * @param {Array<{jobId: string, title: string}>} visibleJobs - job cards visible on screen (no scrolling), used to confirm the pick
 * @returns {null | {capture, path: string[], titleKey: string, idKey: string, items: object[], total: number|null, confirmedBy: number}}
 */
function discoverJobsRequest(captures, visibleJobs = []) {
  const visibleIds = new Set(visibleJobs.map((j) => String(j.jobId)));
  const visibleTitles = new Set(visibleJobs.map((j) => j.title.trim().toLowerCase()));
  let best = null;

  for (const capture of captures) {
    if (capture.status >= 400) continue;
    for (const { path: arrPath, items } of arraysOfObjects(capture.json)) {
      const titleKey = pickKey(items, TITLE_KEYS, isTitle);
      if (!titleKey) continue;
      // Prefer the numeric ID key whose values match the "Job ID: N" shown on the cards.
      const idCandidates = ID_KEYS.filter((k) => items.filter((o) => isNumericId(o[k])).length >= Math.ceil(items.length * 0.8));
      const idKey = idCandidates.find((k) => items.some((o) => visibleIds.has(String(o[k])))) || idCandidates[0] || null;
      if (!idKey) continue;

      const confirmedBy = items.filter((o) => visibleIds.has(String(o[idKey])) || visibleTitles.has(String(o[titleKey]).trim().toLowerCase())).length;
      if (visibleJobs.length && !confirmedBy) continue; // looks like a list, but not *this* job list
      const urlHint = /job/i.test(capture.url) ? 1 : 0;
      const score = confirmedBy * 1000 + urlHint * 100 + items.length + capture.at / 1e13; // later captures win ties (e.g. after switching to all jobs)
      if (!best || score > best.score) {
        const parent = arrPath.length ? getPath(capture.json, arrPath.slice(0, -1)) : null;
        const totalHolder = [parent, capture.json].find((o) => o && typeof o === 'object' && TOTAL_KEYS.some((k) => typeof o[k] === 'number'));
        const total = totalHolder ? totalHolder[TOTAL_KEYS.find((k) => typeof totalHolder[k] === 'number')] : null;
        best = { score, capture, path: arrPath, titleKey, idKey, items, total, confirmedBy };
      }
    }
  }
  return best;
}

/** Stage counts on a job object, wherever the response keeps them. null = not present (≠ zero). */
function extractCounts(job) {
  const stageCounts = [];
  for (const [key, value] of Object.entries(job)) {
    if (Array.isArray(value) && value.length && value.every((v) => v && typeof v === 'object')) {
      const nameKey = STAGE_NAME_KEYS.find((k) => value.every((v) => typeof v[k] === 'string'));
      const countKey = STAGE_COUNT_KEYS.find((k) => value.every((v) => typeof v[k] === 'number'));
      if (nameKey && countKey) for (const v of value) stageCounts.push({ label: v[nameKey], count: v[countKey] });
    } else if (value && typeof value === 'object' && !Array.isArray(value) && /count|stage|pipeline|candidate/i.test(key)) {
      for (const [k, v] of Object.entries(value)) if (typeof v === 'number') stageCounts.push({ label: k, count: v });
    } else if (typeof value === 'number' && /count$/i.test(key) && !/^(total|page|result|record)/i.test(key)) {
      // e.g. jobSeekerCount, activeCandidateCount, backBurnerCandidateCount → "Job Seeker", "Active", "Back Burner"
      const label =
        key
          .replace(/(Candidates?)?(Stage)?Count$/i, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim() || key;
      stageCounts.push({ label, count: value });
    }
  }
  const seeker = stageCounts.find((s) => /job\s*seeker|posting\s*response|jobseeker/i.test(s.label)) || stageCounts.find((s) => /^new\b|applicant/i.test(s.label));
  return { stageCounts, jobSeekerCount: seeker ? seeker.count : null };
}

function mapJobs(items, { titleKey, idKey }) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return items.map((o) => {
    const { stageCounts, jobSeekerCount } = extractCounts(o);
    // Paycor's priority is a number where LOWER is more urgent (4 = Urgent, then 8, 12, 16 —
    // confirmed 2026-10-19); jobs arrive already in Paycor's own order, which is kept as-is.
    const priority = o.priority != null && /^\d+$/.test(String(o.priority)) ? Number(o.priority) : null;
    return {
      jobId: String(o[idKey]),
      title: String(o[titleKey]).trim(),
      internalId: text(o.id),
      location: text(o.location),
      department: text(o.department),
      priority,
      jobSeekerCount,
      stageCounts,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Recipe: the saved, replayable job-list request
// ---------------------------------------------------------------------------------------------

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (k.startsWith(':') || DROP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function toRecipe(found) {
  let body = null;
  if (found.capture.postData) {
    try {
      body = JSON.parse(found.capture.postData);
    } catch {
      body = found.capture.postData;
    }
  }
  return {
    discoveredAt: new Date().toISOString(),
    url: found.capture.url,
    method: found.capture.method,
    headers: sanitizeHeaders(found.capture.requestHeaders),
    body,
    path: found.path,
    titleKey: found.titleKey,
    idKey: found.idKey,
    sampleCount: found.items.length,
    total: found.total,
  };
}

function rewriteObject(obj, fn, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return obj;
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const [k, v] of Object.entries(out)) {
    const replaced = fn(k, v);
    if (replaced === undefined) delete out[k];
    else out[k] = typeof replaced === 'object' ? rewriteObject(replaced, fn, depth + 1) : replaced;
  }
  return out;
}

const SCOPE_KEYS = /^(role|jobFilter|filterType|scope)$/i;

/**
 * The recipe's request, adjusted for page `pageIndex` with large pages, and with any "my jobs only"
 * switch turned off (or the job filter set to `scopeValue`). Returns {url, init, changedPaging, changedScope}.
 */
function buildRequest(recipe, { pageIndex = 0, pageSize = 500, allJobs = true, scopeValue = null } = {}) {
  let changedPaging = false;
  let changedScope = false;
  const adjust = (k, v) => {
    // Paycor's job filter ("My Jobs", "All Jobs", …) is one value in the request, e.g. role: "myJob" / "all".
    if (scopeValue != null && SCOPE_KEYS.test(k) && typeof v === 'string') {
      changedScope = true;
      return scopeValue;
    }
    if (PAGE_SIZE_KEYS.test(k) && (typeof v === 'number' || /^\d+$/.test(String(v)))) {
      changedPaging = true;
      return typeof v === 'number' ? pageSize : String(pageSize);
    }
    if (PAGE_KEYS.test(k) && (typeof v === 'number' || /^\d+$/.test(String(v)))) {
      changedPaging = true;
      // Offsets count items; page numbers keep whatever base (0 or 1) the captured first page used.
      const n = /offset|start|skip|from/i.test(k) ? pageIndex * pageSize : Number(v) + pageIndex;
      return typeof v === 'number' ? n : String(n);
    }
    if (allJobs && MY_JOBS_KEYS.test(k) && (v === true || v === 'true')) {
      changedScope = true;
      return typeof v === 'boolean' ? false : 'false';
    }
    return v;
  };

  const url = new URL(recipe.url);
  for (const [k, v] of [...url.searchParams.entries()]) url.searchParams.set(k, String(adjust(k, v)));

  let body = recipe.body;
  if (body && typeof body === 'object') body = rewriteObject(body, adjust);
  else if (typeof body === 'string' && body.includes('=')) {
    const params = new URLSearchParams(body);
    for (const [k, v] of [...params.entries()]) params.set(k, String(adjust(k, v)));
    body = params.toString();
  }

  const init = { method: recipe.method, headers: { ...recipe.headers }, redirect: 'manual' };
  if (body != null && recipe.method !== 'GET') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return { url: url.toString(), init, changedPaging, changedScope };
}

function cookieHeaderFor(url, cookies) {
  const host = new URL(url).hostname;
  return (cookies || [])
    .filter((c) => {
      const d = String(c.domain || '').replace(/^\./, '');
      return host === d || host.endsWith(`.${d}`);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

class PaycorAuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'LOGIN_REQUIRED';
  }
}

async function callPaycor(url, init, cookies, fetchImpl = fetch) {
  const res = await fetchImpl(url, { ...init, headers: { ...init.headers, cookie: cookieHeaderFor(url, cookies) } });
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400 && /login/i.test(res.headers.get('location') || ''))) {
    throw new PaycorAuthError('Paycor says the saved login has expired.');
  }
  if (!res.ok) throw new Error(`Paycor answered ${res.status} for the job list request.`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (/<html/i.test(text) && /login|sign in/i.test(text)) throw new PaycorAuthError('Paycor sent back its login page — the saved login has expired.');
    throw new Error('Paycor did not send job data in the expected format.');
  }
}

/**
 * Fetches every job using the saved recipe and login cookies — no browser involved.
 * @returns {Promise<{jobs, scope: string, scopeNote: string|null, total: number|null}>}
 */
async function fetchAllJobs(recipe, cookies, { fetchImpl = fetch, maxPages = 20, scopeValue = null } = {}) {
  const byId = new Map();
  let scope = 'My Jobs';
  let scopeNote = null;
  let total = null;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const req = buildRequest(recipe, { pageIndex, scopeValue });
    if (pageIndex === 0 && req.changedScope) scope = scopeValue != null ? (/^all$/i.test(scopeValue) ? 'All Jobs' : 'My Jobs') : 'All Jobs';
    const json = await callPaycor(req.url, req.init, cookies, fetchImpl);
    const items = getPath(json, recipe.path);
    if (!Array.isArray(items)) throw new Error('Paycor job data no longer has the expected layout.');
    if (pageIndex === 0) {
      const parent = recipe.path.length ? getPath(json, recipe.path.slice(0, -1)) : null;
      const holder = [parent, json].find((o) => o && typeof o === 'object' && TOTAL_KEYS.some((k) => typeof o[k] === 'number'));
      total = holder ? holder[TOTAL_KEYS.find((k) => typeof holder[k] === 'number')] : null;
    }
    const before = byId.size;
    for (const job of mapJobs(items, recipe)) byId.set(job.jobId, job);
    if (!req.changedPaging || byId.size === before || (total != null && byId.size >= total) || items.length === 0) break;
  }

  if (scopeValue == null) {
    if (recipe.scope) scope = recipe.scope; // set when the list was captured after switching to all jobs on screen
    if (scope === 'My Jobs') scopeNote = 'This may be only "My Jobs": the app couldn\'t find Paycor\'s all-jobs setting.';
  }
  return { jobs: [...byId.values()], scope, scopeNote, total };
}

/**
 * The values Paycor's own job request used for "My Jobs" (before the filter was switched on screen)
 * and "All Jobs" (after), e.g. { mine: "myJob", all: "all" }. Missing values are left out.
 */
function learnScopeValues(captures, url, switchAt) {
  const values = {};
  if (switchAt == null) return values;
  for (const c of captures) {
    if (c.url !== url || !c.postData) continue;
    let body;
    try {
      body = JSON.parse(c.postData);
    } catch {
      continue;
    }
    if (!body || typeof body !== 'object') continue;
    const key = Object.keys(body).find((k) => SCOPE_KEYS.test(k) && typeof body[k] === 'string');
    if (!key) continue;
    if (c.at < switchAt) values.mine = values.mine || body[key];
    else values.all = body[key];
  }
  if (values.mine && values.mine === values.all) delete values.mine;
  return values;
}

/**
 * Both of Paycor's lists in one go: All Jobs (in Paycor's order — Urgent first) with each job
 * marked as being in My Jobs or not. Uses the filter values learned from Paycor's own requests,
 * falling back to the ones confirmed on 2026-10-19 ("all" / "myJob").
 * @returns {Promise<{jobs, scope, scopeNote, total, hasMyJobs: boolean}>}
 */
async function fetchMineAndAll(recipe, cookies, { fetchImpl = fetch } = {}) {
  const values = recipe.scopeValues || {};
  const hasScopeKey = recipe.body && typeof recipe.body === 'object' && Object.keys(recipe.body).some((k) => SCOPE_KEYS.test(k));
  if (!hasScopeKey) {
    const only = await fetchAllJobs(recipe, cookies, { fetchImpl });
    return { ...only, jobs: only.jobs.map((j, i) => ({ ...j, rank: i, mine: null, myRank: null })), hasMyJobs: false };
  }

  const all = await fetchAllJobs(recipe, cookies, { fetchImpl, scopeValue: values.all || 'all' });
  let mine = null;
  try {
    mine = await fetchAllJobs(recipe, cookies, { fetchImpl, scopeValue: values.mine || 'myJob' });
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') throw err;
  }
  const myRank = new Map((mine ? mine.jobs : []).map((j, i) => [j.jobId, i]));
  const jobs = all.jobs.map((j, i) => ({ ...j, rank: i, mine: mine ? myRank.has(j.jobId) : null, myRank: myRank.has(j.jobId) ? myRank.get(j.jobId) : null }));
  // A job in My Jobs but not in All Jobs shouldn't happen; keep it rather than lose it.
  if (mine) for (const j of mine.jobs) if (!all.jobs.some((a) => a.jobId === j.jobId)) jobs.push({ ...j, rank: jobs.length, mine: true, myRank: myRank.get(j.jobId) });
  return {
    jobs,
    scope: 'All Jobs',
    scopeNote: mine ? null : 'Your "My Jobs" list couldn\'t be loaded, so only All Jobs is available right now.',
    total: all.total,
    hasMyJobs: !!mine,
  };
}

/**
 * One job's description as Paycor stores it (HTML), read with the saved login — the request
 * Paycor's own job page makes (`/api/Job_showDescription.action?id=<internal job id>`, confirmed
 * 2026-10-19). Read-only. Returns { html, spanishHtml } (either may be '').
 */
async function fetchJobDescription(internalId, cookies, { fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9]{1,64}$/.test(String(internalId || ''))) throw new Error('This job has no Paycor internal ID.');
  const url = `${PAYCOR_ORIGIN}/api/Job_showDescription.action?id=${encodeURIComponent(internalId)}`;
  const json = await callPaycor(url, { method: 'GET', headers: { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' }, redirect: 'manual' }, cookies, fetchImpl);
  if (!json || typeof json !== 'object' || !('description' in json)) throw new Error('Paycor did not send the job description in the expected format.');
  return { html: String(json.description || ''), spanishHtml: String(json.spanishDescription || '') };
}

/**
 * Downloads one Paycor file (e.g. a resume attachment) straight into memory with the saved login —
 * nothing is written to disk and nothing shows in any browser. Login cookies are only sent to
 * recruitingbypaycor.com: if Paycor redirects to file storage elsewhere, that hop goes without them.
 * @returns {Promise<{buffer: Buffer, contentType: string, fileName: string}>}
 */
async function fetchPaycorFile(url, cookies, { fetchImpl = fetch, maxBytes = 15 * 1024 * 1024 } = {}) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const onPaycor = new URL(current).hostname.endsWith('recruitingbypaycor.com');
    const res = await fetchImpl(current, { redirect: 'manual', headers: onPaycor ? { cookie: cookieHeaderFor(current, cookies) } : {} });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error('Paycor redirected the file download without saying where.');
      if (onPaycor && /\/login/i.test(location)) throw new PaycorAuthError('Paycor asked for a login while downloading the resume.');
      current = new URL(location, current).toString();
      continue;
    }
    if (onPaycor && (res.status === 401 || res.status === 403)) throw new PaycorAuthError('Paycor refused the resume download — the saved login has expired.');
    if (!res.ok) throw new Error(`The resume download failed (${res.status}).`);
    const contentType = res.headers.get('content-type') || '';
    if (onPaycor && /text\/html/i.test(contentType)) throw new Error('Paycor sent a web page instead of the resume file.');
    if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new Error('The resume file is too large to read.');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('The resume file is too large to read.');
    const disposition = res.headers.get('content-disposition') || '';
    const named = disposition.match(/filename\*=UTF-8''([^;]+)/i) || disposition.match(/filename="?([^";]+)"?/i);
    const fileName = named ? decodeURIComponent(named[1]) : decodeURIComponent(new URL(current).pathname.split('/').pop() || '');
    return { buffer, contentType, fileName };
  }
  throw new Error('Too many redirects while downloading the resume.');
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

function saveRecipe(file, recipe) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(recipe, null, 2), 'utf8');
}

function loadRecipe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Text kept in the log only for these keys (job titles, stage names) — every other string is
// blanked, so candidate names, emails and notes never reach the file.
const KEEP_TEXT_KEYS = /^(title|jobTitle|positionTitle|displayTitle|label|stage|stageName|status|statusName|type)$/i;

/** The shape of a JSON value: keys, numbers and list sizes, with text blanked except job/stage labels. */
function skeleton(value, key = '', depth = 0) {
  if (depth > 6) return '…';
  if (Array.isArray(value)) return value.length ? [`(${value.length} items, first:)`, skeleton(value[0], key, depth + 1)] : [];
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 80).map(([k, v]) => [k, skeleton(v, k, depth + 1)]));
  }
  if (typeof value === 'string') return KEEP_TEXT_KEYS.test(key) ? value.slice(0, 120) : `<text, ${value.length} chars>`;
  return value; // numbers, booleans, null
}

function redactQuery(urlString) {
  const url = new URL(urlString);
  for (const [k, v] of [...url.searchParams.entries()]) if (!/^\d+$|^(true|false)$/i.test(v) && !PAGE_SIZE_KEYS.test(k) && !PAGE_KEYS.test(k)) url.searchParams.set(k, `<${v.length} chars>`);
  return url.toString();
}

/** A record of the captured requests' shapes (no cookies, tokens or candidate details), for fixing discovery against Paycor's real responses. */
function writeNetworkLog(file, captures) {
  const redact = (h) => Object.fromEntries(Object.entries(sanitizeHeaders(h)).map(([k, v]) => [k, /auth|token|xsrf|csrf/i.test(k) ? '(redacted)' : v]));
  let postShape = (c) => {
    try {
      return skeleton(JSON.parse(c.postData));
    } catch {
      return c.postData ? `<text, ${c.postData.length} chars>` : null;
    }
  };
  const entries = captures.map((c) => ({ url: redactQuery(c.url), method: c.method, status: c.status, size: c.size, requestHeaders: redact(c.requestHeaders), postData: postShape(c), shape: skeleton(c.json) }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ capturedAt: new Date().toISOString(), entries }, null, 2), 'utf8');
}

module.exports = {
  captureJsonResponses,
  discoverJobsRequest,
  extractCounts,
  mapJobs,
  toRecipe,
  buildRequest,
  cookieHeaderFor,
  fetchAllJobs,
  fetchMineAndAll,
  learnScopeValues,
  fetchJobDescription,
  callPaycor,
  fetchPaycorFile,
  PaycorAuthError,
  sanitizeHeaders,
  saveRecipe,
  loadRecipe,
  writeNetworkLog,
  skeleton,
};
