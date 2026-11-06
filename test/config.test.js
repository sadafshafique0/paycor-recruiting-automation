const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOCALAPPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-config-'));
const { validateConfig, saveConfig, loadConfig, setPersonalEnvVar, paths } = require('../src/config');
const { extractResult, stripResultLines, RESULT_MARKER } = require('../src/cliResult');

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));

test('the shipped example config is valid', () => {
  assert.deepEqual(validateConfig(example), []);
});

test('validateConfig explains problems in plain language', () => {
  const bad = JSON.parse(JSON.stringify(example));
  bad.name = '';
  bad.pipelines[0].key = 'HR Director';
  bad.pipelines[0].templates.firstContact = '';
  bad.pipelines[0].templates.fluencyReminder = 'Bad "quote"';
  bad.pipelines[0].managerEmail = 'not-an-email';
  // No shared team steps here, so the blanked template really is missing.
  const problems = validateConfig(bad, { teamProcess: {} });
  assert.ok(problems.some((p) => /Enter your name/.test(p)));
  assert.ok(problems.some((p) => /short name must be lowercase/.test(p)));
  assert.ok(problems.some((p) => /missing templates: firstContact/.test(p)));
  assert.ok(problems.some((p) => /can't contain quotes/.test(p)));
  assert.ok(problems.some((p) => /doesn't look like an email/.test(p)));
});

test('duplicate pipeline names are rejected', () => {
  const dup = JSON.parse(JSON.stringify(example));
  dup.pipelines.push(JSON.parse(JSON.stringify(example.pipelines[0])));
  assert.ok(validateConfig(dup).some((p) => /used twice/.test(p)));
});

test('saveConfig refuses invalid settings and writes valid ones', () => {
  assert.throws(() => saveConfig({ name: '', pipelines: [] }), (err) => err.problems.length > 0);
  saveConfig(example);
  assert.equal(loadConfig().pipelines[0].key, example.pipelines[0].key);
});

test('setPersonalEnvVar writes to the personal .env and the current process', () => {
  setPersonalEnvVar('APW_TEST_VAR', 'hello');
  assert.equal(process.env.APW_TEST_VAR, 'hello');
  assert.match(fs.readFileSync(paths().envFile, 'utf8'), /APW_TEST_VAR=hello/);
  assert.throws(() => setPersonalEnvVar('APW_TEST_VAR', 'two\nlines'));
});

test('extractResult reads the last result line; stripResultLines hides it from the log', () => {
  const out = `working...\n${RESULT_MARKER}{"a":1}\nmore\n${RESULT_MARKER}{"a":2}\n`;
  assert.deepEqual(extractResult(out), { a: 2 });
  assert.equal(stripResultLines(out), 'working...\nmore');
  assert.equal(extractResult('no result here'), null);
});
