// The team's shared recruiting steps: which Paycor email template each step sends, which Paycor
// status the candidate moves to, and the Pass reasons. The process is the same for every colleague,
// so it lives in ONE file in the app folder (team-process.json, next to screening-criteria/) — the
// folder that is copied/synced to every colleague's computer — instead of in each person's
// personal config.json in %LOCALAPPDATA%.
//
// A pipeline (one job) in the personal config only needs its basics (short name, Job ID, company,
// manager email); every step comes from here unless that pipeline overrides it (src/pipelines.js).
// Contains Paycor template/status names only — never anything about candidates.

const fs = require('fs');
const path = require('path');
const { stripBom } = require('./stripBom');
const { REQUIRED_TEMPLATE_KEYS, REQUIRED_TARGET_STATUS_KEYS, OPTIONAL_TARGET_STATUS_KEYS, DEFAULT_PASS_REASONS } = require('./pipelines');

const TEAM_PROCESS_FILE = path.join(__dirname, '..', 'team-process.json');
const SECTIONS = {
  templates: REQUIRED_TEMPLATE_KEYS,
  targetStatuses: [...OPTIONAL_TARGET_STATUS_KEYS, ...REQUIRED_TARGET_STATUS_KEYS],
  passReasons: Object.keys(DEFAULT_PASS_REASONS),
};

/** The shared steps, or an empty process if the file is missing/unreadable (pipelines then need their own values). */
function loadTeamProcess(file = process.env.APW_TEAM_PROCESS_FILE || TEAM_PROCESS_FILE) {
  try {
    const raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
    return normalizeTeamProcess(raw).process;
  } catch {
    return { templates: {}, targetStatuses: {}, passReasons: {}, updatedAt: null, updatedBy: null };
  }
}

/** Keeps only the known keys, as strings; returns problems in plain language. */
function normalizeTeamProcess(input) {
  const problems = [];
  const out = { templates: {}, targetStatuses: {}, passReasons: {}, updatedAt: null, updatedBy: null };
  if (!input || typeof input !== 'object') return { process: out, problems: ['The team steps are missing'] };
  for (const [section, keys] of Object.entries(SECTIONS)) {
    const values = input[section] && typeof input[section] === 'object' ? input[section] : {};
    for (const key of keys) {
      const value = values[key];
      if (value == null || String(value).trim() === '') continue;
      if (typeof value !== 'string') {
        problems.push(`Team steps: "${key}" must be text`);
        continue;
      }
      // Template names end up inside a CSS attribute selector in the page script.
      if (/["\\\r\n]/.test(value)) problems.push(`Team steps: "${key}" can't contain quotes, backslashes or line breaks`);
      else if (value.length > 300) problems.push(`Team steps: "${key}" is too long`);
      else out[section][key] = value; // not trimmed: Paycor matches names character for character
    }
  }
  if (typeof input.updatedAt === 'string') out.updatedAt = input.updatedAt;
  if (typeof input.updatedBy === 'string') out.updatedBy = input.updatedBy.slice(0, 100);
  return { process: out, problems };
}

function saveTeamProcess(input, { file = process.env.APW_TEAM_PROCESS_FILE || TEAM_PROCESS_FILE, updatedBy = null } = {}) {
  const { process: clean, problems } = normalizeTeamProcess(input);
  if (problems.length) {
    const err = new Error('Team steps not saved');
    err.problems = problems;
    throw err;
  }
  clean.updatedAt = new Date().toISOString();
  clean.updatedBy = updatedBy ? String(updatedBy).slice(0, 100) : null;
  const doc = {
    about: 'Shared recruiting steps for everyone using this app. Edit on the dashboard Settings page. Each pipeline in a personal config can still override a step.',
    ...clean,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { loadTeamProcess, saveTeamProcess, normalizeTeamProcess, TEAM_PROCESS_FILE };
