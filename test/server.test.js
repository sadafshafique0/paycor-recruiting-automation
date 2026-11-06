const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// Point %LOCALAPPDATA% at a temp dir before the server (and config.js) load.
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'apw-server-'));
process.env.LOCALAPPDATA = appData;
process.env.PORT = '4178';
fs.mkdirSync(path.join(appData, 'AutonomousPaycorWorkflow'));
fs.copyFileSync(path.join(__dirname, '..', 'config.example.json'), path.join(appData, 'AutonomousPaycorWorkflow', 'config.json'));

const { app } = require('../server/index');

let server;
let port;
before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
});
after(() => server.close());

function request(method, urlPath, { body, host = 'localhost:4178' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers: { host, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('requests with a foreign Host header are refused (DNS-rebinding guard)', async () => {
  const res = await request('GET', '/api/config', { host: 'evil.example:4178' });
  assert.equal(res.status, 403);
});

test('screening-criteria rejects a path-traversal jobId', async () => {
  const res = await request('POST', '/api/screening-criteria', { body: { jobId: '../../evil', text: 'x' } });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'evil.md')), false);
});

test('a live screening run requires a pipeline to enroll accepted candidates into', async () => {
  const res = await request('POST', '/api/screen-job', { body: { job: '146', dryRun: false } });
  assert.equal(res.status, 400);
  assert.match(res.body, /pipeline/i);
});

test('candidate intake validates the pipeline and the IDs', async () => {
  const bad = await request('POST', '/api/candidates', { body: { pipeline: 'nope', ids: 'abc' } });
  assert.equal(bad.status, 400);

  const ok = await request('POST', '/api/candidates', { body: { pipeline: 'hr-director-101', ids: '8a7887a19fd3ba90019fdd408ef0063e, <script>' } });
  assert.equal(ok.status, 200);
  const result = JSON.parse(ok.body);
  assert.deepEqual(result.added, ['8a7887a19fd3ba90019fdd408ef0063e']);
  assert.equal(result.skipped[0].reason, 'not a valid Paycor candidate ID');
});

test('settings: invalid settings come back as a list of problems, valid ones save', async () => {
  const bad = await request('PUT', '/api/settings', { body: { name: '', pipelines: [] } });
  assert.equal(bad.status, 400);
  assert.ok(JSON.parse(bad.body).problems.length >= 2);

  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  example.name = 'Alex';
  const ok = await request('PUT', '/api/settings', { body: example });
  assert.equal(ok.status, 200);
  const settings = JSON.parse((await request('GET', '/api/settings')).body);
  assert.equal(settings.config.name, 'Alex');
});

test('the API key is saved but never sent back in full', async () => {
  const bad = await request('PUT', '/api/settings/api-key', { body: { apiKey: 'hello' } });
  assert.equal(bad.status, 400);

  const key = 'sk-ant-test-0123456789abcdefghijWXYZ';
  const ok = await request('PUT', '/api/settings/api-key', { body: { apiKey: key } });
  assert.equal(ok.status, 200);
  const settings = (await request('GET', '/api/settings')).body;
  assert.equal(settings.includes(key), false);
  assert.match(settings, /…WXYZ/);
  const health = JSON.parse((await request('GET', '/api/health')).body);
  assert.equal(health.apiKeySet, true);
});

test('Paycor jobs are listed with whether each one is ready to screen', async () => {
  const session = require('../src/paycorSession');
  session.saveJobs([
    { jobId: '101', title: 'HR Director', jobSeekerCount: 4, stageCounts: [] },
    { jobId: '146', title: 'Diesel Mechanic', jobSeekerCount: 0, stageCounts: [] },
  ]);
  const data = JSON.parse((await request('GET', '/api/paycor/jobs')).body);
  const hr = data.jobs.find((j) => j.jobId === '101');
  const mech = data.jobs.find((j) => j.jobId === '146');
  assert.equal(hr.pipelineKey, 'hr-director-101'); // matched to the pipeline with that Job ID
  assert.equal(mech.pipelineKey, null);
  assert.equal(typeof hr.hasDescription, 'boolean');
  assert.equal(data.autoRefresh.everyMinutes, 15);
});

test('status reflects the login, and logging out clears it', async () => {
  const session = require('../src/paycorSession');
  session.markConnected();
  assert.equal(JSON.parse((await request('GET', '/api/paycor/status')).body).connected, true);
  assert.equal(JSON.parse((await request('GET', '/api/health')).body).paycorConnected, true);

  const out = await request('POST', '/api/paycor/logout', { body: {} });
  assert.equal(out.status, 200);
  const status = JSON.parse((await request('GET', '/api/paycor/status')).body);
  assert.equal(status.connected, false);
  assert.equal(status.jobCount, 0);
});

test('screening rules: invalid rules are refused with reasons, valid ones are saved and read back', async () => {
  const bad = await request('PUT', '/api/screening-rules/999001', { body: { preferredSkills: ['forklift'] } });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /at least one rule/);

  const ok = await request('PUT', '/api/screening-rules/999001', { body: { requiredSkills: ['CDL | commercial driver'], minimumYears: 2, allowedLocations: ['PA'] } });
  assert.equal(ok.status, 200);
  const saved = JSON.parse((await request('GET', '/api/screening-rules/999001')).body);
  assert.equal(saved.exists, true);
  assert.deepEqual(saved.rules.requiredSkills[0].alternatives, ['CDL', 'commercial driver']);
  fs.rmSync(path.join(__dirname, '..', 'screening-criteria', 'job-999001.rules.json'));

  assert.equal((await request('PUT', '/api/screening-rules/..%2Fevil', { body: { minimumYears: 1 } })).status, 400);
});

test('Accept/Pass on a queue item rejects an invented Pass reason', async () => {
  const res = await request('POST', '/api/manual-review/act', { body: { candidateId: 'x', addedAt: 'y', action: 'pass', reason: 'Too old' } });
  assert.equal(res.status, 400);
});

test('years of experience can be set on its own, keeping the job\'s other rules', async () => {
  const file = path.join(__dirname, '..', 'screening-criteria', 'job-999002.rules.json');
  try {
    assert.equal((await request('PUT', '/api/screening-rules/999002/minimum-years', { body: { minimumYears: 99 } })).status, 400);
    await request('PUT', '/api/screening-rules/999002', { body: { requiredSkills: ['CDL'] } });
    const ok = await request('PUT', '/api/screening-rules/999002/minimum-years', { body: { minimumYears: 3 } });
    assert.equal(ok.status, 200);
    const saved = JSON.parse((await request('GET', '/api/screening-rules/999002')).body).rules;
    assert.equal(saved.minimumYears, 3);
    assert.equal(saved.requiredSkills[0].name, 'CDL'); // untouched

    fs.rmSync(file);
    await request('PUT', '/api/screening-rules/999002/minimum-years', { body: { minimumYears: 2 } });
    assert.equal(fs.existsSync(file), true); // years alone is a valid rule set
    await request('PUT', '/api/screening-rules/999002/minimum-years', { body: { minimumYears: '' } });
    assert.equal(fs.existsSync(file), false); // cleared, and nothing else was in it
  } finally {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

test('Autopilot is off until turned on, and saving Settings never switches it back', async () => {
  const off = JSON.parse((await request('GET', '/api/autopilot')).body);
  assert.equal(off.enabled, false);
  assert.equal(off.everyMinutes, 30);

  assert.equal((await request('PUT', '/api/autopilot', { body: { everyMinutes: 7 } })).status, 400);
  const on = await request('PUT', '/api/autopilot', { body: { enabled: true, everyMinutes: 15 } });
  assert.equal(on.status, 200);
  assert.equal(JSON.parse(on.body).enabled, true);

  // A Settings page opened before Autopilot was turned on saves its (older) settings…
  const settings = JSON.parse((await request('GET', '/api/settings')).body).config;
  delete settings.autopilot;
  assert.equal((await request('PUT', '/api/settings', { body: settings })).status, 200);
  // …and Autopilot is still on.
  const still = JSON.parse((await request('GET', '/api/autopilot')).body);
  assert.equal(still.enabled, true);
  assert.equal(still.everyMinutes, 15);

  await request('PUT', '/api/autopilot', { body: { enabled: false } });
  assert.equal(JSON.parse((await request('GET', '/api/autopilot')).body).enabled, false);
});
