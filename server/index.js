// Local dashboard — the thing a non-technical colleague actually uses: set up once in Settings,
// connect to Paycor, then pick a job and click a button. No MCP, no Claude Code chat, no terminal.
//
// Runs the real CLI entry points as child processes rather than re-implementing their logic here,
// so the dashboard and a scheduled Task Scheduler run always do exactly the same thing. Each CLI
// prints one machine-readable result line (src/cliResult.js) that the UI turns into a plain-language
// result card.
//
// Bound to 127.0.0.1 with a Host-header check: this serves candidate names and can trigger live
// Paycor actions, so it must not be reachable from the rest of the network or from a web page
// that rebinds its DNS name to localhost.

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');

const { paths, loadConfig, loadEnvFile, saveConfig, setPersonalEnvVar } = require('../src/config');
const { loadState } = require('../src/state/store');
const { loadManualReview, resolveManualReview, findManualReview } = require('../src/state/manualReview');
const { addCandidates } = require('../src/intake/addCandidates');
const { TRACK, SCREENING_PASS_REASONS } = require('../src/engine/constants');
const { REQUIRED_TEMPLATE_KEYS, REQUIRED_TARGET_STATUS_KEYS, OPTIONAL_TARGET_STATUS_KEYS, SCREENING_STEP, DEFAULT_PASS_REASONS } = require('../src/pipelines');
const paycorStages = require('../src/paycorStages');
const { checkInstalled } = require('../src/fluency/runFluencyScorer');
const { extractResult, extractProgress, stripResultLines } = require('../src/cliResult');
const { stripBom } = require('../src/stripBom');
const paycorSession = require('../src/paycorSession');
const { loadJobsWithoutBrowser } = require('../src/jobLoader');
const { normalizeRules, DEFAULT_RULES } = require('../src/screening/rules');
const { jobDescriptionFor, readJobDescriptions } = require('../src/jobDescriptions');
const { normalizeWorkHours, isWithinWorkHours, describeWorkHours } = require('../src/workHours');

loadEnvFile();

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4178;
const ROOT = path.join(__dirname, '..');
const SCREENING_CRITERIA_DIR = path.join(ROOT, 'screening-criteria');
const JOB_ID_RE = /^\d{1,10}$/;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const EXAMPLE_CONFIG = JSON.parse(stripBom(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')));

const app = express();
app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return res.status(403).send('Forbidden');
  next();
});
app.use(express.json({ limit: '200kb' }));
// no-cache = always revalidate, so colleagues never run a stale dashboard after the app is updated.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

function tryLoadConfig() {
  try {
    return { config: loadConfig(paths().configFile) };
  } catch (err) {
    return { error: err.message };
  }
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

// --- Spawned CLI runs. Only one Paycor-touching run at a time — they share one Edge profile. ---
const jobs = new Map(); // jobId -> { kind, status, log: string[], startedAt, finishedAt, exitCode, result }
const lastJobByKind = {};
let activeJobId = null;

function spawnJob(kind, scriptPath, args, env = {}) {
  if (activeJobId && jobs.get(activeJobId).status === 'running') return { busy: true, jobId: activeJobId };

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { kind, status: 'running', log: [], startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, result: null, dryRun: env.DRY_RUN === 'true', byAutopilot: env.AUTOPILOT === 'true' };
  job.done = new Promise((resolve) => (job.resolveDone = resolve)); // the Autopilot waits on this
  jobs.set(jobId, job);
  activeJobId = jobId;
  lastJobByKind[kind] = jobId;

  const proc = spawn(process.execPath, [scriptPath, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
  proc.stdout.on('data', (d) => job.log.push(d.toString()));
  proc.stderr.on('data', (d) => job.log.push(d.toString()));
  proc.on('error', (err) => job.log.push(`Failed to start: ${err.message}\n`));
  proc.on('close', (code) => {
    job.result = extractResult(job.log.join(''));
    // Any run that hit Paycor's login page means the saved session is gone — ask for a login.
    if (job.result && job.result.loginRequired) paycorSession.markDisconnected();
    job.status = code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    // Screening and outreach change applicant counts — refresh the job data straight after.
    if (['screen', 'daily', 'act'].includes(kind) && !job.dryRun && code === 0) autoRefreshJobs({ force: true });
    job.resolveDone(job);
  });
  return { jobId };
}

// --- Automatic job-data refresh ---------------------------------------------------------------
// Runs inside this server process (not as a spawned run), using only the windowless path — so it
// never opens a browser window and never blocks the dashboard's buttons. If the windowless path
// can't be used, it just leaves the data as it is; "Refresh from Paycor" handles that case.
const AUTO_REFRESH_EVERY_MS = 15 * 60 * 1000;
const autoRefresh = { running: false, lastAttemptAt: null, lastError: null };

async function autoRefreshJobs({ force = false } = {}) {
  if (autoRefresh.running) return;
  if (!paycorSession.readConnection().connected) return;
  const cache = paycorSession.readJobs();
  if (!force && cache.syncedAt && Date.now() - new Date(cache.syncedAt).getTime() < AUTO_REFRESH_EVERY_MS) return;

  autoRefresh.running = true;
  autoRefresh.lastAttemptAt = new Date().toISOString();
  try {
    const loaded = await loadJobsWithoutBrowser(paths());
    if (loaded) {
      paycorSession.saveJobs(loaded.jobs, paycorSession.jobListExtras(loaded));
      autoRefresh.lastError = null;
    } else {
      autoRefresh.lastError = 'Automatic refresh isn\'t set up yet — click "Refresh from Paycor" once.';
    }
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') paycorSession.markDisconnected();
    autoRefresh.lastError = err.message;
  } finally {
    autoRefresh.running = false;
  }
}

function sendSpawn(res, result) {
  if (result.busy) return res.status(409).json({ error: 'Something else is already running — wait for it to finish.', jobId: result.jobId });
  res.json({ jobId: result.jobId });
}

function jobView(id) {
  const job = jobs.get(id);
  if (!job) return null;
  return { id, kind: job.kind, status: job.status, dryRun: job.dryRun, exitCode: job.exitCode, startedAt: job.startedAt, finishedAt: job.finishedAt, result: job.result, progress: job.status === 'running' ? extractProgress(job.log.slice(-40).join('')) : null, log: stripResultLines(job.log.join('')).slice(-50000) };
}

// --- Health / home screen ------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  const p = paths();
  const { config, error } = tryLoadConfig();
  const fluency = checkInstalled();
  const connection = paycorSession.readConnection();
  const openReviewCount = loadManualReview(p.manualReviewFile).filter((e) => !e.resolvedAt).length;
  const active = activeJobId && jobs.get(activeJobId).status === 'running' ? { id: activeJobId, kind: jobs.get(activeJobId).kind } : null;
  res.json({
    configured: !error,
    configError: error || null,
    name: config ? config.name : null,
    screeningEngine: (config && config.screening && config.screening.engine) || 'rules',
    apiKeySet: !!process.env.ANTHROPIC_API_KEY,
    fluencyHelper: { ok: fluency.ok, reason: fluency.reason || null },
    paycorConnected: connection.connected,
    jobsSyncedAt: paycorSession.readJobs().syncedAt,
    paycorLastConnectedAt: connection.lastConnectedAt,
    needsAttention: fs.existsSync(p.needsAttentionFile) ? fs.readFileSync(p.needsAttentionFile, 'utf8') : null,
    openReviewCount,
    activeJob: active,
  });
});

// --- Settings (replaces hand-editing config.json in %LOCALAPPDATA%) --------------------------

app.get('/api/settings', (req, res) => {
  const p = paths();
  const existing = readJsonOrNull(p.configFile);
  const key = process.env.ANTHROPIC_API_KEY || '';
  res.json({
    exists: !!existing,
    config: existing || { name: '', screening: { engine: 'rules', maxPassesPerRun: 25 }, pipelines: [] },
    examplePipeline: EXAMPLE_CONFIG.pipelines[0],
    templateKeys: REQUIRED_TEMPLATE_KEYS,
    statusKeys: [...OPTIONAL_TARGET_STATUS_KEYS, ...REQUIRED_TARGET_STATUS_KEYS],
    defaultPassReasons: DEFAULT_PASS_REASONS,
    apiKey: { set: !!key, hint: key ? `…${key.slice(-4)}` : null },
  });
});

app.put('/api/settings', (req, res) => {
  try {
    // Autopilot on/off is changed only by its own switch — a Settings page opened earlier must not undo it.
    const existing = readJsonOrNull(paths().configFile);
    const body = { ...(req.body || {}) };
    if (existing && existing.autopilot) body.autopilot = existing.autopilot;
    else delete body.autopilot;
    saveConfig(body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message, problems: err.problems || [] });
  }
});

app.put('/api/settings/api-key', (req, res) => {
  const apiKey = String((req.body && req.body.apiKey) || '').trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) return res.status(400).json({ error: 'That doesn\'t look like an Anthropic API key (it starts with sk-ant-).' });
  setPersonalEnvVar('ANTHROPIC_API_KEY', apiKey);
  res.json({ ok: true, hint: `…${apiKey.slice(-4)}` });
});

// --- Config / pipelines ----------------------------------------------------------------------

app.get('/api/config', (req, res) => {
  const { config, error } = tryLoadConfig();
  if (error) return res.json({ configured: false, error, configPath: paths().configFile });
  res.json({
    configured: true,
    name: config.name,
    pipelines: config.pipelines.map((pl) => ({ key: pl.key, jobId: pl.jobId, company: pl.company, sourceStatus: pl.sourceStatus })),
    screeningPassReasons: SCREENING_PASS_REASONS,
    screeningEngine: (config.screening && config.screening.engine) || 'rules',
    outreach: { pickUpWithinDays: (config.outreach && config.outreach.pickUpWithinDays) || 30, maxNewPerRun: (config.outreach && config.outreach.maxNewPerRun) ?? 50 },
  });
});

// --- Candidate state -----------------------------------------------------------------------

app.get('/api/state', (req, res) => {
  const state = loadState(paths().stateFile);
  const candidates = Object.values(state);
  const byTrack = {};
  for (const track of Object.values(TRACK)) byTrack[track] = 0;
  for (const c of candidates) byTrack[c.track] = (byTrack[c.track] || 0) + 1;
  res.json({
    total: candidates.length,
    byTrack,
    candidates: candidates.map((c) => ({ id: c.id, name: c.name, pipelineKey: c.pipelineKey, track: c.track, status: c.status, updatedAt: c.updatedAt, fluencyScore: c.fluencyScore, passReason: c.passReason, error: c.errorState ? c.errorState.message : null })),
  });
});

app.post('/api/candidates', (req, res) => {
  const { pipeline, ids } = req.body || {};
  const { config, error } = tryLoadConfig();
  if (error) return res.status(400).json({ error });
  if (!config.pipelines.some((p) => p.key === pipeline)) return res.status(400).json({ error: `Unknown pipeline "${pipeline}"` });
  const list = String(ids || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'Paste at least one candidate ID' });
  res.json(addCandidates(paths().stateFile, list.map((id) => ({ id })), pipeline));
});

// --- Exception queue -------------------------------------------------------------------------

app.get('/api/manual-review', (req, res) => {
  const entries = loadManualReview(paths().manualReviewFile);
  res.json({ open: entries.filter((e) => !e.resolvedAt), resolved: entries.filter((e) => e.resolvedAt).slice(-100).reverse() });
});

app.post('/api/manual-review/resolve', (req, res) => {
  const { candidateId, addedAt, note } = req.body || {};
  if (!candidateId || !addedAt) return res.status(400).json({ error: 'candidateId and addedAt are required' });
  try {
    res.json({ ok: true, entry: resolveManualReview(paths().manualReviewFile, String(candidateId), String(addedAt), note ? String(note) : null) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/manual-review/act', (req, res) => {
  const { candidateId, addedAt, action, reason } = req.body || {};
  if (!['accept', 'pass'].includes(action)) return res.status(400).json({ error: 'action must be accept or pass' });
  if (action === 'pass' && !SCREENING_PASS_REASONS.includes(reason)) return res.status(400).json({ error: 'Pick one of the fixed Pass reasons' });
  const entry = findManualReview(paths().manualReviewFile, String(candidateId), String(addedAt));
  if (!entry || entry.kind !== 'screening' || entry.resolvedAt) return res.status(404).json({ error: 'No open screening item matches' });

  const args = ['--candidate', entry.candidateId, '--added-at', entry.addedAt, '--action', action];
  if (action === 'pass') args.push('--reason', reason);
  sendSpawn(res, spawnJob('act', path.join(ROOT, 'cli', 'act-on-candidate.js'), args));
});

// --- Screening criteria: paste a job description, no file editing ----------------------------

app.post('/api/screening-criteria', (req, res) => {
  const { jobId, text } = req.body || {};
  if (!JOB_ID_RE.test(String(jobId))) return res.status(400).json({ error: 'jobId must be the numeric Paycor Job ID' });
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'Paste the job description first' });
  if (!fs.existsSync(SCREENING_CRITERIA_DIR)) fs.mkdirSync(SCREENING_CRITERIA_DIR, { recursive: true });
  const filePath = path.join(SCREENING_CRITERIA_DIR, `job-${jobId}.md`);
  fs.writeFileSync(filePath, String(text), 'utf8');
  res.json({ ok: true, file: `screening-criteria/job-${jobId}.md` });
});

// --- Screening rules (the free, offline screener) -------------------------------------------------

app.get('/api/screening-rules/:jobId', (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'jobId must be numeric' });
  const filePath = path.join(SCREENING_CRITERIA_DIR, `job-${req.params.jobId}.rules.json`);
  if (!fs.existsSync(filePath)) return res.json({ exists: false, rules: DEFAULT_RULES });
  try {
    res.json({ exists: true, rules: normalizeRules(JSON.parse(fs.readFileSync(filePath, 'utf8'))).rules });
  } catch {
    res.json({ exists: false, rules: DEFAULT_RULES, error: 'The saved rules file could not be read — save the rules again.' });
  }
});

app.put('/api/screening-rules/:jobId', (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'jobId must be numeric' });
  const { rules, problems } = normalizeRules(req.body || {});
  if (problems.length) return res.status(400).json({ error: 'Rules not saved', problems });
  if (!fs.existsSync(SCREENING_CRITERIA_DIR)) fs.mkdirSync(SCREENING_CRITERIA_DIR, { recursive: true });
  fs.writeFileSync(path.join(SCREENING_CRITERIA_DIR, `job-${req.params.jobId}.rules.json`), JSON.stringify(rules, null, 2), 'utf8');
  res.json({ ok: true, rules });
});

app.get('/api/screening-criteria/:jobId', (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'jobId must be numeric' });
  const filePath = path.join(SCREENING_CRITERIA_DIR, `job-${req.params.jobId}.md`);
  if (!fs.existsSync(filePath)) return res.json({ exists: false });
  res.json({ exists: true, text: fs.readFileSync(filePath, 'utf8') });
});

// Years of experience on its own (pipeline setup): changes only minimumYears in the job's rules,
// keeping every other rule. Empty clears it; a rules file that held nothing else is removed.
app.put('/api/screening-rules/:jobId/minimum-years', (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'jobId must be numeric' });
  const raw = req.body ? req.body.minimumYears : null;
  const minimumYears = raw === '' || raw == null ? null : Number(raw);
  if (minimumYears != null && !(Number.isFinite(minimumYears) && minimumYears >= 0 && minimumYears <= 50)) {
    return res.status(400).json({ error: 'Years of experience must be a number from 0 to 50.' });
  }
  const filePath = path.join(SCREENING_CRITERIA_DIR, `job-${req.params.jobId}.rules.json`);
  let current = DEFAULT_RULES;
  try {
    if (fs.existsSync(filePath)) current = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return res.status(409).json({ error: 'The saved rules for this job could not be read — open Screen applicants and save them again.' });
  }
  const { rules, problems } = normalizeRules({ ...current, minimumYears });
  if (problems.length) {
    if (minimumYears == null && problems.every((p) => /at least one rule/.test(p))) {
      if (fs.existsSync(filePath)) fs.rmSync(filePath);
      return res.json({ ok: true, rules: null });
    }
    return res.status(400).json({ error: 'Not saved', problems });
  }
  if (!fs.existsSync(SCREENING_CRITERIA_DIR)) fs.mkdirSync(SCREENING_CRITERIA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(rules, null, 2), 'utf8');
  res.json({ ok: true, rules });
});

// The job's description as it is in Paycor (copied at each refresh), for pipeline setup and screening.
app.get('/api/paycor/job-descriptions/:jobId', (req, res) => {
  if (!JOB_ID_RE.test(req.params.jobId)) return res.status(400).json({ error: 'jobId must be numeric' });
  const found = jobDescriptionFor(paths().jobDescriptionsFile, req.params.jobId);
  if (!found) return res.json({ exists: false });
  res.json({ exists: true, title: found.title, text: found.text, fetchedAt: found.fetchedAt });
});

// --- Trigger runs ------------------------------------------------------------------------------

app.post('/api/run-daily', (req, res) => {
  const dryRun = !!(req.body && req.body.dryRun);
  // Optional: run outreach for one pipeline only (the dropdown on the Daily outreach page).
  const pipeline = req.body && req.body.pipeline ? String(req.body.pipeline) : '';
  if (pipeline) {
    const { config } = tryLoadConfig();
    if (!config || !config.pipelines.some((p) => p.key === pipeline)) return res.status(400).json({ error: 'Unknown pipeline — choose one from the list.' });
  }
  sendSpawn(res, spawnJob('daily', path.join(ROOT, 'cli', 'run-daily.js'), [], { DRY_RUN: dryRun ? 'true' : 'false', OUTREACH_PIPELINE: pipeline }));
});

app.post('/api/screen-job', (req, res) => {
  const { job, pipeline, dryRun } = req.body || {};
  const jobQuery = String(job || '').trim();
  if (!jobQuery || jobQuery.length > 100) return res.status(400).json({ error: 'Enter a Job ID or title fragment' });
  const { config, error } = tryLoadConfig();
  if (error) return res.status(400).json({ error });
  if (pipeline && !config.pipelines.some((p) => p.key === pipeline)) return res.status(400).json({ error: `Unknown pipeline "${pipeline}"` });
  if (!dryRun && !pipeline) {
    return res.status(400).json({ error: 'Pick the pipeline accepted candidates should be enrolled into (or do a test run).' });
  }
  const args = ['--job', jobQuery];
  if (pipeline) args.push('--pipeline', pipeline);
  sendSpawn(res, spawnJob('screen', path.join(ROOT, 'cli', 'screen-job.js'), args, { DRY_RUN: dryRun ? 'true' : 'false' }));
});

// --- Paycor connection & job list ----------------------------------------------------------------

app.get('/api/paycor/status', (req, res) => {
  const connection = paycorSession.readConnection();
  const cache = paycorSession.readJobs();
  const loginJob = lastJobByKind.login ? jobView(lastJobByKind.login) : null;
  res.json({ ...connection, jobsSyncedAt: cache.syncedAt, jobCount: cache.jobs.length, loginJob });
});

app.post(['/api/paycor/login', '/api/login'], (req, res) => {
  sendSpawn(res, spawnJob('login', path.join(ROOT, 'cli', 'login.js'), []));
});

app.post('/api/paycor/sync', (req, res) => {
  sendSpawn(res, spawnJob('sync', path.join(ROOT, 'cli', 'sync-jobs.js'), []));
});

// Paycor's priority numbers: lower = more urgent. 4 is "Urgent" (confirmed on Paycor's cards);
// names for the others are learned from the cards at login, otherwise shown by level.
const PRIORITY_LEVELS = { 4: 1, 8: 2, 12: 3, 16: 4 };
function priorityLabel(priority, learned) {
  if (priority == null) return null;
  if (learned && learned[String(priority)]) return learned[String(priority)];
  if (Number(priority) === 4) return 'Urgent';
  return `Priority ${PRIORITY_LEVELS[priority] || priority}`;
}

app.get('/api/paycor/jobs', (req, res) => {
  const cache = paycorSession.readJobs();
  const { config } = tryLoadConfig();
  const pipelines = config ? config.pipelines : [];
  const descriptions = readJobDescriptions(paths().jobDescriptionsFile).jobs;
  res.json({
    syncedAt: cache.syncedAt,
    totalReported: cache.totalReported ?? null,
    scope: cache.scope || null,
    scopeNote: cache.scopeNote || null,
    source: cache.source || null,
    hasMyJobs: !!cache.hasMyJobs,
    descriptionCount: Object.keys(descriptions).length,
    autoRefresh: { everyMinutes: AUTO_REFRESH_EVERY_MS / 60000, refreshing: autoRefresh.running, lastError: autoRefresh.lastError },
    screeningEngine: (config && config.screening && config.screening.engine) || 'rules',
    // Kept in Paycor's own order (most urgent first), as saved.
    jobs: cache.jobs.map((j, i) => {
      const pipeline = pipelines.find((p) => String(p.jobId) === String(j.jobId));
      return {
        jobId: j.jobId,
        title: j.title,
        location: j.location || null,
        department: j.department || null,
        priority: j.priority ?? null,
        priorityLabel: priorityLabel(j.priority, cache.priorityLabels),
        rank: j.rank ?? i,
        mine: j.mine ?? null,
        myRank: j.myRank ?? null,
        hasPaycorDescription: !!(descriptions[j.jobId] && descriptions[j.jobId].text),
        jobSeekerCount: j.jobSeekerCount,
        stageCounts: j.stageCounts || [],
        pipelineKey: pipeline ? pipeline.key : null,
        hasDescription: JOB_ID_RE.test(String(j.jobId)) && fs.existsSync(path.join(SCREENING_CRITERIA_DIR, `job-${j.jobId}.md`)),
        hasRules: JOB_ID_RE.test(String(j.jobId)) && fs.existsSync(path.join(SCREENING_CRITERIA_DIR, `job-${j.jobId}.rules.json`)),
      };
    }),
  });
});

app.post('/api/paycor/logout', (req, res) => {
  if (activeJobId && jobs.get(activeJobId).status === 'running') {
    return res.status(409).json({ error: 'Wait for the current run to finish before logging out.' });
  }
  paycorSession.logOut();
  res.json({ ok: true });
});

// --- Email templates from Paycor + the team's shared recruiting steps ----------------------------
// Templates are read windowless with the saved login (src/paycorTemplates.js) — names and ids only.
// The steps (which template each step sends) are shared by the whole team in team-process.json in
// the app folder (src/teamProcess.js); a pipeline in the personal config can still override a step.
const paycorTemplates = require('../src/paycorTemplates');
const teamProcess = require('../src/teamProcess');
const { PROCESS_STEPS, PASS_REASON_STEPS } = require('../src/pipelines');
const templateRefresh = { running: null, lastError: null, lastErrorAt: null, loginRequired: false };

function refreshTemplatesNow() {
  if (templateRefresh.running) return templateRefresh.running;
  templateRefresh.running = paycorTemplates
    .refreshEmailTemplates(paths())
    .then((cache) => {
      templateRefresh.lastError = null;
      templateRefresh.loginRequired = false;
      return cache;
    })
    .catch((err) => {
      templateRefresh.loginRequired = err.code === 'LOGIN_REQUIRED';
      if (templateRefresh.loginRequired) paycorSession.markDisconnected();
      templateRefresh.lastError = templateRefresh.loginRequired ? 'Your Paycor login has expired — log in to Paycor again, then refresh the templates.' : err.message;
      templateRefresh.lastErrorAt = new Date().toISOString();
      throw err;
    })
    .finally(() => {
      templateRefresh.running = null;
    });
  return templateRefresh.running;
}

function templatesView() {
  const cache = paycorTemplates.readTemplateCache(paths().emailTemplatesFile);
  // A login run (cli/login.js) also refreshes the list; a newer list clears an older error.
  if (templateRefresh.lastErrorAt && cache.syncedAt && cache.syncedAt > templateRefresh.lastErrorAt) {
    templateRefresh.lastError = null;
    templateRefresh.lastErrorAt = null;
    templateRefresh.loginRequired = false;
  }
  return { ...cache, refreshing: !!templateRefresh.running, lastError: templateRefresh.lastError, loginRequired: templateRefresh.loginRequired, connected: paycorSession.readConnection().connected };
}

app.get('/api/paycor/email-templates', (req, res) => {
  const view = templatesView();
  // First visit after logging in: fetch the list in the background so the dropdowns fill on the next look.
  if (!view.syncedAt && view.connected && !view.refreshing && !templateRefresh.lastError) {
    refreshTemplatesNow().catch(() => {});
    view.refreshing = true;
  }
  res.json(view);
});

app.post('/api/paycor/email-templates/refresh', async (req, res) => {
  if (!paycorSession.readConnection().connected) return res.status(401).json({ error: 'Log in to Paycor first.', loginRequired: true });
  try {
    await refreshTemplatesNow();
    res.json(templatesView());
  } catch (err) {
    res.status(err.code === 'LOGIN_REQUIRED' ? 401 : 502).json({ ...templatesView(), error: templateRefresh.lastError || err.message });
  }
});

// Paycor's stages and their statuses, for the "move the candidate to" dropdowns. Kept current by
// every job refresh; this reads it now when asked (or when it has never been read).
let stagesRefreshing = null;
function refreshStagesNow() {
  if (!stagesRefreshing) {
    stagesRefreshing = paycorStages.refreshStages(paths()).finally(() => {
      stagesRefreshing = null;
    });
  }
  return stagesRefreshing;
}

app.get('/api/paycor/stages', async (req, res) => {
  let cache = paycorStages.readStageCache(paths().stagesFile);
  let error = null;
  if (!cache.syncedAt && paycorSession.readConnection().connected) {
    try {
      cache = await refreshStagesNow();
    } catch (err) {
      if (err.code === 'LOGIN_REQUIRED') paycorSession.markDisconnected();
      error = err.code === 'LOGIN_REQUIRED' ? 'Your Paycor login has expired — log in to Paycor again.' : err.message;
    }
  }
  res.json({ ...cache, error });
});

app.post('/api/paycor/stages/refresh', async (req, res) => {
  if (!paycorSession.readConnection().connected) return res.status(401).json({ error: 'Log in to Paycor first.', loginRequired: true });
  try {
    res.json({ ...(await refreshStagesNow()), error: null });
  } catch (err) {
    if (err.code === 'LOGIN_REQUIRED') paycorSession.markDisconnected();
    res.status(err.code === 'LOGIN_REQUIRED' ? 401 : 502).json({ ...paycorStages.readStageCache(paths().stagesFile), error: err.message, loginRequired: err.code === 'LOGIN_REQUIRED' });
  }
});

app.get('/api/team-process', (req, res) => {
  res.json({
    exists: fs.existsSync(process.env.APW_TEAM_PROCESS_FILE || teamProcess.TEAM_PROCESS_FILE),
    process: teamProcess.loadTeamProcess(),
    steps: PROCESS_STEPS,
    screeningStep: SCREENING_STEP,
    passReasonSteps: PASS_REASON_STEPS,
    defaultPassReasons: DEFAULT_PASS_REASONS,
  });
});

app.put('/api/team-process', (req, res) => {
  const { config } = tryLoadConfig();
  try {
    const saved = teamProcess.saveTeamProcess(req.body || {}, { updatedBy: config ? config.name : null });
    res.json({ ok: true, process: saved });
  } catch (err) {
    res.status(400).json({ error: err.message, problems: err.problems || [] });
  }
});

app.get('/api/jobs/latest', (req, res) => {
  const out = {};
  for (const [kind, id] of Object.entries(lastJobByKind)) out[kind] = jobView(id);
  res.json(out);
});

app.get('/api/jobs/:id', (req, res) => {
  const view = jobView(req.params.id);
  if (!view) return res.status(404).json({ error: 'unknown job id' });
  res.json(view);
});

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
}

// --- Autopilot: screening + outreach on a timer --------------------------------------------------
// While this dashboard is open and Autopilot is on (Settings → personal config `autopilot`), every
// N minutes (default 30, so nothing waits more than an hour) it runs one cycle, one step at a time:
//   1. refresh the job list from Paycor (windowless);
//   2. screen every pipeline job that has new applicants and screening rules — for real;
//   3. run the daily outreach for all pipelines — picks up candidates, handles replies, sends emails.
// Each step is an ordinary run (the same as the buttons), so it shows its progress and result on the
// dashboard. It never starts while something else is running, and it stops a cycle when the Paycor
// login has expired. Off unless someone turns it on.
const AUTOPILOT_CHOICES = [15, 30, 60];
const autopilot = { running: false, step: null, startedAt: null, lastCycleStartedAt: null, history: [] };

function autopilotSettings() {
  const { config } = tryLoadConfig();
  const a = (config && config.autopilot) || {};
  const { workHours } = normalizeWorkHours(a.workHours);
  return { enabled: !!a.enabled, everyMinutes: AUTOPILOT_CHOICES.includes(a.everyMinutes) ? a.everyMinutes : 30, workHours };
}

function autopilotLogFile() {
  return path.join(paths().root, 'autopilot-log.json');
}
function loadAutopilotHistory() {
  try {
    const data = JSON.parse(stripBom(fs.readFileSync(autopilotLogFile(), 'utf8')));
    autopilot.history = Array.isArray(data.history) ? data.history.slice(0, 20) : [];
    autopilot.lastCycleStartedAt = autopilot.history[0] ? autopilot.history[0].startedAt : null;
  } catch {
    autopilot.history = [];
  }
}
function saveAutopilotHistory() {
  try {
    const file = autopilotLogFile();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ history: autopilot.history.slice(0, 20) }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // the log is a convenience — never stop a cycle over it
  }
}

/** Starts one run and waits for it to finish. Returns the finished job, or null if something else was running. */
async function runAndWait(kind, script, args, env) {
  const started = spawnJob(kind, path.join(ROOT, 'cli', script), args, { ...env, AUTOPILOT: 'true' });
  if (started.busy) return null;
  return jobs.get(started.jobId).done;
}

async function runAutopilotCycle({ manual = false, dryRun = false, screenLimit = null } = {}) {
  if (autopilot.running) return { busy: true };
  if (activeJobId && jobs.get(activeJobId).status === 'running') return { busy: true };
  const cycle = { startedAt: new Date().toISOString(), finishedAt: null, manual, dryRun, screened: [], outreach: null, problems: [] };
  autopilot.running = true;
  autopilot.startedAt = cycle.startedAt;
  if (!dryRun) autopilot.lastCycleStartedAt = cycle.startedAt; // a test cycle doesn't move the schedule
  try {
    if (!paycorSession.readConnection().connected) {
      cycle.problems.push('Not logged in to Paycor — log in, and the next cycle carries on.');
      return cycle;
    }
    const { config, error } = tryLoadConfig();
    if (error) {
      cycle.problems.push(`Settings need fixing first: ${error}`);
      return cycle;
    }

    autopilot.step = 'Refreshing the job list from Paycor';
    await autoRefreshJobs({ force: true });
    if (!paycorSession.readConnection().connected) {
      cycle.problems.push('The Paycor login has expired — log in, and the next cycle carries on.');
      return cycle;
    }

    // 2. Screening: pipeline jobs with new applicants and saved screening rules (rules engine).
    const byId = new Map((paycorSession.readJobs().jobs || []).map((j) => [String(j.jobId), j]));
    const engine = (config.screening && config.screening.engine) || 'rules';
    const toScreen = config.pipelines
      .map((p) => ({ p, job: byId.get(String(p.jobId)) }))
      .filter(({ p, job }) => job && job.jobSeekerCount > 0 && JOB_ID_RE.test(String(p.jobId)))
      .filter(({ p }) => fs.existsSync(path.join(SCREENING_CRITERIA_DIR, engine === 'claude' ? `job-${p.jobId}.md` : `job-${p.jobId}.rules.json`)) || engine === 'claude');
    for (const [i, { p, job }] of toScreen.entries()) {
      autopilot.step = `Screening ${job.title} (${i + 1} of ${toScreen.length})`;
      const done = await runAndWait('screen', 'screen-job.js', ['--job', String(p.jobId), '--pipeline', p.key], { DRY_RUN: dryRun ? 'true' : 'false', ...(dryRun && screenLimit ? { SCREEN_LIMIT: String(screenLimit) } : {}) });
      if (!done) {
        cycle.problems.push('Something else was started — the rest of this cycle waits for the next one.');
        return cycle;
      }
      const r = done.result || {};
      const would = (o) => (r.candidates || []).filter((c) => c.outcome === o).length;
      cycle.screened.push({ jobId: p.jobId, title: job.title, status: r.status || (done.status === 'failed' ? 'error' : 'unknown'), advanced: dryRun ? would('accepted') : r.advanced || 0, passed: dryRun ? would('rejected') : r.passed || 0, needsAttention: r.manualReview || 0, waiting: r.leftForNextRun || 0, stoppedAtPassCap: !!r.stoppedAtPassCap, errors: r.errors || 0, error: r.error || (r.status === 'error' ? r.detail : null) || null });
      if (r.loginRequired) {
        cycle.problems.push('The Paycor login expired while screening — log in, and the next cycle carries on.');
        return cycle;
      }
    }

    // 3. Outreach for every pipeline: candidates found in Paycor, replies handled, emails sent.
    autopilot.step = 'Daily outreach — replies and emails';
    const done = await runAndWait('daily', 'run-daily.js', [], { DRY_RUN: dryRun ? 'true' : 'false', OUTREACH_PIPELINE: '' });
    if (!done) {
      cycle.problems.push('Something else was started — outreach waits for the next cycle.');
      return cycle;
    }
    const r = done.result || {};
    const s = r.summary || {};
    const plannedCount = (a) => (s.planned || []).filter((x) => x.action === a).length;
    if (dryRun) {
      s.newCandidatesStarted = plannedCount('SEND_FIRST_CONTACT');
      s.passed = plannedCount('PASS_NO_RESPONSE') + plannedCount('PASS_OTHER_QUALIFIED');
    }
    cycle.outreach = { replies: s.repliesProcessed || 0, firstEmails: s.newCandidatesStarted || 0, reminders: s.remindersSent || 0, passed: s.passed || 0, needsAttention: s.manualReviewAdded || 0, errors: (s.errors || []).length, pickedUp: r.intake ? r.intake.total : 0, error: r.error || null };
    if (r.loginRequired) cycle.problems.push('The Paycor login expired during outreach — log in, and the next cycle carries on.');
    return cycle;
  } catch (err) {
    cycle.problems.push(`The cycle stopped: ${err.message}`);
    return cycle;
  } finally {
    cycle.finishedAt = new Date().toISOString();
    autopilot.history.unshift(cycle);
    autopilot.history = autopilot.history.slice(0, 20);
    saveAutopilotHistory();
    autopilot.running = false;
    autopilot.step = null;
    autopilot.startedAt = null;
  }
}

function autopilotNextAt() {
  const { enabled, everyMinutes, workHours } = autopilotSettings();
  if (!enabled) return null;
  const last = autopilot.lastCycleStartedAt ? Date.parse(autopilot.lastCycleStartedAt) : 0;
  let at = Math.max(Date.now(), last + everyMinutes * 60000);
  // Outside work hours: the next moment the work day starts (checked in 5-minute steps, up to 8 days ahead).
  for (let i = 0; i < 8 * 24 * 12 && !isWithinWorkHours(new Date(at), workHours); i++) at = (Math.floor(at / 300000) + 1) * 300000;
  return new Date(at).toISOString();
}

// Checked every minute: start a cycle when one is due, it's work hours, and nothing else is running.
function autopilotTick() {
  const { enabled, workHours } = autopilotSettings();
  if (!enabled || autopilot.running) return;
  if (!isWithinWorkHours(new Date(), workHours)) return;
  if (Date.parse(autopilotNextAt()) > Date.now()) return;
  runAutopilotCycle().catch(() => {});
}

function autopilotView() {
  const settings = autopilotSettings();
  return {
    ...settings,
    workHoursText: describeWorkHours(settings.workHours),
    inWorkHours: isWithinWorkHours(new Date(), settings.workHours),
    choices: AUTOPILOT_CHOICES,
    running: autopilot.running,
    step: autopilot.step,
    startedAt: autopilot.startedAt,
    nextAt: autopilot.running ? null : autopilotNextAt(),
    history: autopilot.history.slice(0, 10),
  };
}

app.get('/api/autopilot', (req, res) => res.json(autopilotView()));

app.put('/api/autopilot', (req, res) => {
  const body = req.body || {};
  // The raw personal settings file (not the merged view with team steps) — only autopilot changes.
  const config = readJsonOrNull(paths().configFile);
  if (!config) return res.status(400).json({ error: 'Save your settings first.' });
  const current = autopilotSettings();
  const everyMinutes = body.everyMinutes == null ? current.everyMinutes : Number(body.everyMinutes);
  if (!AUTOPILOT_CHOICES.includes(everyMinutes)) return res.status(400).json({ error: 'Choose 15, 30 or 60 minutes.' });
  const enabled = body.enabled == null ? current.enabled : !!body.enabled;
  const { workHours, problems } = normalizeWorkHours(body.workHours == null ? current.workHours : body.workHours);
  if (problems.length) return res.status(400).json({ error: problems.join(' '), problems });
  try {
    saveConfig({ ...config, autopilot: { enabled, everyMinutes, workHours } }, paths().configFile);
  } catch (err) {
    return res.status(400).json({ error: err.message, problems: err.problems || [] });
  }
  res.json(autopilotView());
});

app.post('/api/autopilot/run', (req, res) => {
  if (autopilot.running) return res.status(409).json({ error: 'A cycle is already running.' });
  if (activeJobId && jobs.get(activeJobId).status === 'running') return res.status(409).json({ error: 'Something else is running — try again when it finishes.' });
  const dryRun = !!(req.body && req.body.dryRun);
  const screenLimit = dryRun && Number.isInteger(req.body.screenLimit) && req.body.screenLimit > 0 ? req.body.screenLimit : null; // test cycles only
  runAutopilotCycle({ manual: true, dryRun, screenLimit }).catch(() => {});
  res.json(autopilotView());
});

if (require.main === module) {
  const url = `http://localhost:${PORT}`;
  const shouldOpen = process.argv.includes('--open');
  const server = app.listen(PORT, HOST, () => {
    console.log(`Autonomous Paycor Workflow is running: ${url}`);
    console.log('Keep this window open while you use the dashboard. Close it to stop.');
    if (shouldOpen) openBrowser(url);
    autoRefreshJobs(); // catch up straight away if the saved job data is old
    setInterval(autoRefreshJobs, 60 * 1000).unref(); // checks every minute; refreshes once the data is 15+ minutes old
    loadAutopilotHistory();
    setInterval(autopilotTick, 60 * 1000).unref(); // Autopilot: starts a cycle when one is due (only if turned on)
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`The dashboard is already running — opening ${url}`);
      if (shouldOpen) openBrowser(url);
      process.exit(0);
    }
    throw err;
  });
}

module.exports = { app, PORT };
