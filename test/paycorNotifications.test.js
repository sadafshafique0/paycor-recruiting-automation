const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchReplyNotifications, replyFinder } = require('../src/paycorNotifications');

const COOKIES = [{ name: 'NSESSIONID', value: 's', domain: '.recruitingbypaycor.com' }];
const at = (iso) => Date.parse(iso);
const PAGE = {
  totalSize: 4,
  items: [
    { id: 4, type: 'TEXT_MESSAGE_RECEIVED_FROM_CANDIDATE', createdDateUtc: at('2026-10-18T10:00:00Z'), body: 'my email is jane@x.com', extensionData: { candidateId: 'c1', jobId: 'jobA' } },
    { id: 3, type: 'CANDIDATE_STATUS_CHANGED', createdDateUtc: at('2026-10-17T10:00:00Z'), body: 'status', extensionData: { candidateId: 'c1' } },
    { id: 2, type: 'ECHO_RESPONSE_RECEIVED_FROM_CANDIDATE', createdDateUtc: at('2026-10-16T10:00:00Z'), body: '<div>Blue<br>Thanks</div>', extensionData: { candidateId: 'c2', jobId: 'jobB' } },
    { id: 1, type: 'ECHO_RESPONSE_RECEIVED_FROM_CANDIDATE', createdDateUtc: at('2026-10-01T10:00:00Z'), body: 'old reply', extensionData: { candidateId: 'c1', jobId: 'jobA' } },
  ],
};

test('reply notifications (email and text) are read with the login, read-only', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method });
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(PAGE) };
  };
  const replies = await fetchReplyNotifications(COOKIES, 'co', { sinceMs: at('2026-10-05T00:00:00Z'), fetchImpl });
  assert.deepEqual(replies.map((r) => [r.candidateId, r.via]), [['c1', 'text message'], ['c2', 'email']]); // status change and the old one left out
  assert.equal(replies[1].text, 'Blue\nThanks');
  assert.ok(calls.every((c) => c.method === 'GET')); // never marks anything read
});

test('a reply counts only after the candidate started waiting, and for the same job', async () => {
  const replies = [
    { id: 'n2', candidateId: 'c1', internalJobId: 'jobA', via: 'email', at: '2026-10-18T10:00:00.000Z', html: '<p>Red</p>', text: 'Red' },
    { id: 'n1', candidateId: 'c1', internalJobId: 'jobOther', via: 'email', at: '2026-10-19T10:00:00.000Z', html: 'x', text: 'other job' },
  ];
  const find = replyFinder(replies, (key) => (key === 'p-a' ? 'jobA' : null));
  const got = await find({ id: 'c1', pipelineKey: 'p-a', awaitingReplySince: '2026-10-15T00:00:00.000Z' });
  assert.equal(got.text, 'Red');
  assert.equal(got.messageId, 'n2');
  assert.equal(await find({ id: 'c1', pipelineKey: 'p-a', awaitingReplySince: '2026-10-18T12:00:00.000Z' }), null); // reply came before they waited
  assert.equal(await find({ id: 'c9', pipelineKey: 'p-a', awaitingReplySince: '2026-10-01T00:00:00.000Z' }), null);
});
