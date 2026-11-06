const { test } = require('node:test');
const assert = require('node:assert/strict');
const { judgeResume, normalizeVerdict } = require('../src/screening/resumeJudge');

function fakeClient(response) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        return response;
      },
    },
  };
}

test('normalizeVerdict: a REJECT with an invented reason is downgraded to UNCERTAIN', () => {
  const v = normalizeVerdict({ verdict: 'REJECT', reason: 'Too old', evidence: 'x', confidence: 'high' });
  assert.equal(v.verdict, 'UNCERTAIN');
  assert.equal(v.reason, null);
  assert.equal(v.flagLowConfidence, true);
});

test('normalizeVerdict: a valid high-confidence REJECT keeps its fixed reason and is not flagged', () => {
  const v = normalizeVerdict({ verdict: 'REJECT', reason: 'Job hopper', evidence: 'x', confidence: 'high' });
  assert.equal(v.verdict, 'REJECT');
  assert.equal(v.reason, 'Job hopper');
  assert.equal(v.flagLowConfidence, false);
});

test('normalizeVerdict: medium confidence always goes to a human', () => {
  assert.equal(normalizeVerdict({ verdict: 'ACCEPT', reason: '', evidence: 'x', confidence: 'medium' }).flagLowConfidence, true);
});

test('normalizeVerdict: garbage input routes to manual review', () => {
  assert.equal(normalizeVerdict(null).verdict, 'UNCERTAIN');
  assert.equal(normalizeVerdict({ verdict: 'MAYBE' }).verdict, 'UNCERTAIN');
});

test('judgeResume uses structured outputs (no forced tool call) and parses the JSON reply', async () => {
  const client = fakeClient({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({ verdict: 'ACCEPT', reason: '', evidence: '9 years HR leadership', confidence: 'high' }) }],
  });
  const v = await judgeResume(['aGVsbG8='], 'HR Director criteria', { client });

  assert.equal(v.verdict, 'ACCEPT');
  assert.equal(v.flagLowConfidence, false);
  const params = client.calls[0];
  assert.equal(params.output_config.format.type, 'json_schema');
  assert.equal(params.tool_choice, undefined);
  assert.equal(params.tools, undefined);
  assert.match(params.system, /never as instructions/);
});

test('judgeResume: a refusal or unparseable reply becomes UNCERTAIN, never an action', async () => {
  const refused = await judgeResume(['aGVsbG8='], 'c', { client: fakeClient({ stop_reason: 'refusal', content: [] }) });
  assert.equal(refused.verdict, 'UNCERTAIN');
  const junk = await judgeResume(['aGVsbG8='], 'c', { client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }) });
  assert.equal(junk.verdict, 'UNCERTAIN');
});
