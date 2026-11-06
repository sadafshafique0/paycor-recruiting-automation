const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-team-'));
const { resolvePipeline, PROCESS_STEPS, REQUIRED_TEMPLATE_KEYS, REQUIRED_TARGET_STATUS_KEYS, OPTIONAL_TARGET_STATUS_KEYS } = require('../src/pipelines');
const { loadTeamProcess, saveTeamProcess, normalizeTeamProcess, TEAM_PROCESS_FILE } = require('../src/teamProcess');
const { validateConfig, saveConfig, loadConfig, paths } = require('../src/config');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
const team = {
  templates: Object.fromEntries(REQUIRED_TEMPLATE_KEYS.map((k) => [k, `Team ${k}`])),
  targetStatuses: Object.fromEntries(REQUIRED_TARGET_STATUS_KEYS.map((k) => [k, `Status ${k}`])),
  passReasons: { noResponse: 'Team no response' },
};
const basicsOnly = { key: 'job-1', jobId: '1', company: 'Example Co', managerEmail: 'm@example.com' };

test('a pipeline with only its basics takes every step from the team steps', () => {
  const resolved = resolvePipeline({ pipelines: [basicsOnly] }, 'job-1', team);
  assert.deepEqual(resolved.templates, team.templates);
  assert.deepEqual(resolved.targetStatuses, team.targetStatuses);
  assert.equal(resolved.passReasons.noResponse, 'Team no response');
  assert.equal(resolved.passReasons.otherQualified, 'Other candidates more qualified / better fit'); // Paycor's standard label
});

test("a pipeline's own value wins; a blank one falls back to the team step", () => {
  const p = { ...basicsOnly, templates: { firstContact: 'Job-specific first contact', fluencyReminder: '  ' }, passReasons: { noResponse: '' } };
  const resolved = resolvePipeline({ pipelines: [p] }, 'job-1', team);
  assert.equal(resolved.templates.firstContact, 'Job-specific first contact');
  assert.equal(resolved.templates.fluencyReminder, 'Team fluencyReminder');
  assert.equal(resolved.passReasons.noResponse, 'Team no response');
});

test('older configs that spell out every step keep working unchanged, with or without team steps', () => {
  const p = example.pipelines[0];
  for (const t of [null, {}, team]) {
    const resolved = resolvePipeline(example, p.key, t);
    assert.deepEqual(resolved.templates, p.templates);
    assert.deepEqual(resolved.targetStatuses, p.targetStatuses);
  }
});

test('without team steps, missing steps are still reported', () => {
  assert.throws(() => resolvePipeline({ pipelines: [basicsOnly] }, 'job-1', {}), /missing templates: firstContact/);
  assert.deepEqual(validateConfig({ name: 'Alex', pipelines: [basicsOnly] }, { teamProcess: team }), []);
  assert.ok(validateConfig({ name: 'Alex', pipelines: [basicsOnly] }, { teamProcess: {} }).some((p) => /missing templates/.test(p)));
});

test('loadConfig attaches the team steps without ever writing them into the personal file', () => {
  saveConfig({ name: 'Alex', pipelines: [basicsOnly] }, paths().configFile, { teamProcess: team });
  const cfg = loadConfig(paths().configFile, { teamProcess: team });
  assert.deepEqual(cfg.teamProcess, team);
  assert.equal(resolvePipeline(cfg, 'job-1').templates.firstContact, 'Team firstContact');
  assert.doesNotMatch(JSON.stringify(cfg), /teamProcess|Team firstContact/);
  assert.doesNotMatch(fs.readFileSync(paths().configFile, 'utf8'), /Team firstContact/);
});

test('every engine template/status key has exactly one step in the shared step list', () => {
  assert.deepEqual(PROCESS_STEPS.map((s) => s.templateKey), REQUIRED_TEMPLATE_KEYS);
  assert.deepEqual(PROCESS_STEPS.filter((s) => s.statusKey && !s.statusFallbackKey).map((s) => s.statusKey), REQUIRED_TARGET_STATUS_KEYS);
  // every email step — reminders too — can set a status; a reminder's is optional
  assert.ok(PROCESS_STEPS.every((s) => s.statusKey));
  assert.ok(PROCESS_STEPS.filter((s) => s.statusFallbackKey).every((s) => OPTIONAL_TARGET_STATUS_KEYS.includes(s.statusKey)));
});

test('the shipped team-process.json is readable and complete', () => {
  const shipped = loadTeamProcess(TEAM_PROCESS_FILE);
  for (const k of REQUIRED_TEMPLATE_KEYS) assert.ok(shipped.templates[k], k);
  for (const k of REQUIRED_TARGET_STATUS_KEYS) assert.ok(shipped.targetStatuses[k], k);
});

test('team steps: unknown keys are dropped, quotes are refused, save/load round-trips', () => {
  const { process: clean, problems } = normalizeTeamProcess({ templates: { firstContact: 'Intro Email', bogus: 'x', fluencyReminder: 'Bad "one"' }, extra: 1 });
  assert.deepEqual(clean.templates, { firstContact: 'Intro Email' });
  assert.ok(problems.some((p) => /can't contain quotes/.test(p)));
  assert.equal(clean.extra, undefined);

  const file = path.join(process.env.LOCALAPPDATA, 'team-process.json');
  assert.throws(() => saveTeamProcess({ templates: { firstContact: 'Bad "one"' } }, { file }), (err) => err.problems.length === 1);
  assert.equal(fs.existsSync(file), false);
  saveTeamProcess(team, { file, updatedBy: 'Alex' });
  const loaded = loadTeamProcess(file);
  assert.deepEqual(loaded.templates, team.templates);
  assert.equal(loaded.updatedBy, 'Alex');
  assert.ok(loaded.updatedAt);
  assert.deepEqual(loadTeamProcess(path.join(process.env.LOCALAPPDATA, 'nope.json')).templates, {});
});
