// Keeps a copy of every job's description from Paycor, for pipeline setup and screening.
//
// Read with the saved login, no window (paycorData.fetchJobDescription). Job postings are public
// text, not candidate data. Saved in %LOCALAPPDATA%\AutonomousPaycorWorkflow\paycor-job-descriptions.json
// as { jobs: { "<jobId>": { title, text, fetchedAt } } }. Descriptions rarely change, so the
// automatic refresh only fetches ones that are missing or more than a day old.

const fs = require('fs');
const path = require('path');
const { fetchJobDescription } = require('./paycorData');
const { htmlToText } = require('./text');

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Job postings are written in Paycor's rich-text editor: typographic entities and list items.
const NAMED = { rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', bull: '•', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™' };
function descriptionText(html) {
  const withBullets = String(html || '').replace(/<li[^>]*>/gi, '• ');
  return htmlToText(withBullets)
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function readJobDescriptions(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data.jobs === 'object' && data.jobs ? data : { jobs: {} };
  } catch {
    return { jobs: {} };
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Fetches descriptions for `jobs` (each needs jobId + internalId) and saves them.
 * `force` refetches all; otherwise only missing or stale ones. A login problem stops it (thrown);
 * any other failure for one job is skipped and counted.
 * @returns {Promise<{fetched: number, failed: number, kept: number}>}
 */
async function syncJobDescriptions(jobs, cookies, file, { force = false, fetchImpl = fetch, concurrency = 4, now = Date.now() } = {}) {
  const saved = readJobDescriptions(file);
  const due = jobs.filter((j) => {
    if (!j.internalId) return false;
    const prev = saved.jobs[j.jobId];
    return force || !prev || now - Date.parse(prev.fetchedAt || 0) > MAX_AGE_MS;
  });
  let fetched = 0;
  let failed = 0;
  let loginError = null;
  const queue = [...due];
  const worker = async () => {
    while (queue.length && !loginError) {
      const job = queue.shift();
      try {
        const { html } = await fetchJobDescription(job.internalId, cookies, { fetchImpl });
        saved.jobs[job.jobId] = { title: job.title, text: descriptionText(html), fetchedAt: new Date(now).toISOString() };
        fetched++;
      } catch (err) {
        if (err.code === 'LOGIN_REQUIRED') loginError = err;
        else failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  if (fetched) writeJson(file, { syncedAt: new Date(now).toISOString(), jobs: saved.jobs });
  if (loginError) throw loginError;
  return { fetched, failed, kept: Object.keys(saved.jobs).length };
}

function jobDescriptionFor(file, jobId) {
  return readJobDescriptions(file).jobs[String(jobId)] || null;
}

module.exports = { syncJobDescriptions, readJobDescriptions, jobDescriptionFor, descriptionText };
