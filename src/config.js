// %LOCALAPPDATA% resolution — everything personal/PII (login profile, candidate state, manager
// emails, logs, screening results, the personal API key) lives here, per-laptop, never in the
// synced/shared app folder. That's what lets the project folder itself be shared with colleagues
// without ever carrying anyone's real candidate data or credentials.

const fs = require('fs');
const path = require('path');
const { stripBom } = require('./stripBom');
const { resolvePipeline } = require('./pipelines');
const { loadTeamProcess } = require('./teamProcess');

const APP_DIR_NAME = 'AutonomousPaycorWorkflow';

function appDataRoot() {
  const base = process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local');
  return path.join(base, APP_DIR_NAME);
}

function paths(root = appDataRoot()) {
  return {
    root,
    configFile: path.join(root, 'config.json'),
    envFile: path.join(root, '.env'),
    stateFile: path.join(root, 'candidatesState.json'),
    manualReviewFile: path.join(root, 'manualReview.json'),
    lockFile: path.join(root, 'run.lock'),
    logsDir: path.join(root, 'logs'),
    needsAttentionFile: path.join(root, 'NEEDS-ATTENTION.txt'),
    edgeProfileDir: path.join(root, 'EdgeProfile'),
    screeningResultsDir: path.join(root, 'screening-results'),
    connectionFile: path.join(root, 'paycor-connection.json'),
    jobsFile: path.join(root, 'paycor-jobs.json'),
    jobDescriptionsFile: path.join(root, 'paycor-job-descriptions.json'),
    stagesFile: path.join(root, 'paycor-stages.json'), // stage + status names only — see src/paycorStages.js // job postings' text — see src/jobDescriptions.js
    sessionFile: path.join(root, 'paycor-session.json'),
    recipeFile: path.join(root, 'paycor-jobs-request.json'),
    emailTemplatesFile: path.join(root, 'paycor-email-templates.json'), // template names/ids only — see src/paycorTemplates.js
    networkLogFile: path.join(root, 'logs', 'paycor-network.json'),
    homeSnapshotFile: path.join(root, 'logs', 'paycor-home-snapshot.html'),
  };
}

function writeAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

// --- .env handling (no `dotenv` dependency for a handful of variables) -----------------------

function parseEnv(text) {
  const out = {};
  for (const line of stripBom(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * Loads the personal `.env` in %LOCALAPPDATA% (written by the dashboard's Settings page), then the
 * project `.env`. Never overrides a variable already set, so precedence is:
 * real environment > personal .env > project .env.
 */
function loadEnvFile() {
  for (const envPath of [paths().envFile, path.join(__dirname, '..', '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(envPath, 'utf8')))) {
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

/** Sets one variable in the personal .env and in this process (so spawned runs inherit it). */
function setPersonalEnvVar(key, value) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid variable name ${key}`);
  if (/[\r\n]/.test(value)) throw new Error('Value must be a single line');
  const file = paths().envFile;
  const existing = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  existing[key] = value;
  writeAtomic(file, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  process.env[key] = value;
}

// --- config.json ---------------------------------------------------------------------------------

const REQUIRED_CONFIG_FIELDS = ['name', 'pipelines'];

/**
 * Loads the personal config and attaches the team's shared recruiting steps as `cfg.teamProcess`
 * (not enumerable, so it is never written back into the personal file). resolvePipeline uses it.
 */
function loadConfig(configFilePath = paths().configFile, { teamProcess = loadTeamProcess() } = {}) {
  if (!fs.existsSync(configFilePath)) {
    throw new Error(`No settings saved yet (${configFilePath}). Open the dashboard's Settings page to set up a pipeline.`);
  }
  const cfg = JSON.parse(stripBom(fs.readFileSync(configFilePath, 'utf8')));
  for (const field of REQUIRED_CONFIG_FIELDS) {
    if (!(field in cfg)) throw new Error(`config.json is missing required field "${field}"`);
  }
  if (!Array.isArray(cfg.pipelines) || cfg.pipelines.length === 0) {
    throw new Error('config.json: "pipelines" must be a non-empty array');
  }
  Object.defineProperty(cfg, 'teamProcess', { value: teamProcess, enumerable: false, writable: true, configurable: true });
  return cfg;
}

/**
 * Returns a list of human-readable problems; empty means the config is safe to save.
 * Steps a pipeline leaves blank come from the team's shared steps (`teamProcess`).
 */
function validateConfig(cfg, { teamProcess = loadTeamProcess() } = {}) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') return ['Settings are missing'];
  if (!String(cfg.name || '').trim()) problems.push('Enter your name');
  const max = cfg.screening && cfg.screening.maxPassesPerRun;
  if (max != null && (!Number.isInteger(max) || max < 0 || max > 500)) problems.push('"Most automatic Passes per screening run" must be a whole number from 0 to 500');
  const engine = cfg.screening && cfg.screening.engine;
  if (engine != null && !['rules', 'claude'].includes(engine)) problems.push('Choose how resumes are judged: rules or Claude AI');
  const out = cfg.outreach || {};
  if (out.pickUpWithinDays != null && (!Number.isInteger(out.pickUpWithinDays) || out.pickUpWithinDays < 1 || out.pickUpWithinDays > 365)) problems.push('"Pick up candidates updated in the last … days" must be a whole number from 1 to 365');
  if (out.maxNewPerRun != null && (!Number.isInteger(out.maxNewPerRun) || out.maxNewPerRun < 0 || out.maxNewPerRun > 500)) problems.push('"Most new first-contact emails per run" must be a whole number from 0 to 500');
  const per = cfg.screening && cfg.screening.maxCandidatesPerRun;
  if (per != null && (!Number.isInteger(per) || per < 1 || per > 1000)) problems.push('"Most applicants screened per job in one run" must be a whole number from 1 to 1000');
  const ap = cfg.autopilot || {};
  if (ap.everyMinutes != null && ![15, 30, 60].includes(ap.everyMinutes)) problems.push('Autopilot runs every 15, 30 or 60 minutes');
  if (ap.workHours != null) problems.push(...require('./workHours').normalizeWorkHours(ap.workHours).problems.map((p) => `Autopilot work hours: ${p}`));
  if (!Array.isArray(cfg.pipelines) || !cfg.pipelines.length) {
    problems.push('Add at least one pipeline');
    return problems;
  }
  const seen = new Set();
  cfg.pipelines.forEach((p, i) => {
    const label = p && p.key ? `Pipeline "${p.key}"` : `Pipeline ${i + 1}`;
    if (!p || !/^[a-z0-9][a-z0-9-]{0,49}$/.test(p.key || '')) problems.push(`${label}: short name must be lowercase letters, numbers and dashes (e.g. hr-director-101)`);
    else if (seen.has(p.key)) problems.push(`${label}: short name is used twice`);
    else seen.add(p.key);
    if (p && p.jobId && !/^\d{1,10}$/.test(String(p.jobId))) problems.push(`${label}: Job ID must be a number`);
    if (p && p.managerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.managerEmail)) problems.push(`${label}: manager email doesn't look like an email address`);
    // Template names end up inside a CSS attribute selector in the page script.
    for (const [field, value] of Object.entries({ ...(p && p.templates), ...(p && p.targetStatuses) })) {
      if (/["\\\r\n]/.test(String(value || ''))) problems.push(`${label}: "${field}" can't contain quotes, backslashes or line breaks`);
    }
    try {
      resolvePipeline({ pipelines: [p] }, p && p.key, teamProcess);
    } catch (err) {
      problems.push(`${label}: ${err.message.replace(/^Pipeline "[^"]*" is /, '')}`);
    }
  });
  return problems;
}

function saveConfig(cfg, configFilePath = paths().configFile, { teamProcess = loadTeamProcess() } = {}) {
  const problems = validateConfig(cfg, { teamProcess });
  if (problems.length) {
    const err = new Error('Settings not saved');
    err.problems = problems;
    throw err;
  }
  writeAtomic(configFilePath, JSON.stringify(cfg, null, 2));
}

module.exports = { appDataRoot, paths, loadConfig, loadEnvFile, setPersonalEnvVar, validateConfig, saveConfig };
