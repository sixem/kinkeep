import test from 'node:test';
import assert from 'node:assert/strict';
import '../cache-read.js';
import '../profiles.js';
import '../extract.js';

const { firebaseUid } = globalThis.KinexportCache;
const { extract } = globalThis.KinexportExtract;
function localStorage(values) {
  const entries = Object.entries(values);
  return { length: entries.length, key: index => entries[index]?.[0] ?? null, getItem: key => values[key] ?? null };
}
function cache(owner = 'account-a') {
  const queries = [
    { queryKey: ['v2', 'user', 'account-a'], state: { data: { aiList: ['kin-a', 'kin-b'], unrelatedToken: 'do-not-send' } } },
    { queryKey: ['v2', 'kins', 'account-a', 'page', 'az', '', 20], state: { dataUpdatedAt: 20, data: { pages: [{ docs: [
      { uid: 'account-a', ai_id: 'kin-a', ai_name: 'Alex', unrelatedSecret: 'do-not-send' },
      { uid: 'wrong-account', ai_id: 'kin-b', ai_name: 'Wrong name' },
    ] }] } } },
    { queryKey: ['v2', 'kins', 'account-a', 'kin-b'], state: { dataUpdatedAt: 30, data: { uid: 'account-a', ai_id: 'kin-b', ai_name: 'Blair' } } },
    { queryKey: ['v2', 'chat-messages', 'account-a', 'kin-a'], state: { data: [{
      id: 'message-1', text: 'Hello', isSelf: true, senderAiId: null, timestamp: 1730000000000,
      persona: 'My persona', reactions: { 'kin:kin-a': '❤️' }, reactionsRevision: 1, chatHistoryRecordId: 'record-1', accessToken: 'do-not-send',
    }] } },
    { queryKey: ['v2', 'chat-messages', 'other-account', 'kin-a'], state: { data: [{ id: 'wrong', text: 'wrong account', isSelf: true, timestamp: 1730000000000 }] } },
    { queryKey: ['v2', 'chat-messages', 'account-a', 'unknown-kin'], state: { data: [{ id: 'wrong', text: 'unknown kin', isSelf: true, timestamp: 1730000000000 }] } },
  ];
  return { ownerUid: owner, client: { clientState: { queries } } };
}
test('Firebase identity must be present, valid, and unambiguous', () => {
  assert.deepEqual(firebaseUid(localStorage({})), { state: 'waiting' });
  assert.deepEqual(firebaseUid(localStorage({ 'firebase:authUser:one': '{"uid":"account-a","token":"secret"}' })), { state: 'ready', uid: 'account-a' });
  assert.deepEqual(firebaseUid(localStorage({ 'firebase:authUser:one': '{"uid":"account-a","displayName":" Alice ","token":"secret"}' })), { state: 'ready', uid: 'account-a', displayName: 'Alice' });
  assert.deepEqual(firebaseUid(localStorage({ 'firebase:authUser:one': '{"uid":"account-a","displayName":"Alice"}', 'firebase:authUser:two': '{"uid":"account-a","displayName":"Bob"}' })), { state: 'ready', uid: 'account-a' });
  assert.equal(firebaseUid(localStorage({ 'firebase:authUser:one': '{broken' })).state, 'identity-uncertain');
  assert.equal(firebaseUid(localStorage({ 'firebase:authUser:one': '{"uid":"a"}', 'firebase:authUser:two': '{"uid":"b"}' })).state, 'identity-uncertain');
});
test('only verified owner and Kin messages leave the extractor', async () => {
  assert.equal((await extract('account-a', [])).state, 'waiting');
  assert.equal((await extract('account-a', [cache('wrong-account')])).state, 'identity-uncertain');
  assert.equal((await extract('account-a', [cache(), cache()])).state, 'identity-uncertain');
  const result = await extract('account-a', [cache()]);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.account, { accountId: 'account-a' });
  assert.deepEqual(result.kins, [{ accountId: 'account-a', kinId: 'kin-a', name: 'Alex' }, { accountId: 'account-a', kinId: 'kin-b', name: 'Blair' }]);
  assert.equal(result.groups.length, 1);
  const [message] = result.groups[0].messages;
  assert.deepEqual({ ...message, fingerprint: '<hash>' }, {
    conversationId: 'observed-main', messageId: 'message-1', sender: 'user', timestamp: '2024-10-27T03:33:20.000Z', content: 'Hello',
    data: { captureSource: 'cache', persona: 'My persona', reactions: { 'kin:kin-a': '❤️' }, chatHistoryRecordId: 'record-1', reactionsRevision: 1 }, fingerprint: '<hash>',
  });
  assert.match(message.fingerprint, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /do-not-send|wrong account|unknown kin/);
});
test('revisions change the fingerprint and conflicting duplicates are not guessed', async () => {
  const first = cache();
  const second = cache();
  second.client.clientState.queries[3].state.data[0].reactionsRevision++;
  const fingerprint1 = (await extract('account-a', [first])).groups[0].messages[0].fingerprint;
  const fingerprint2 = (await extract('account-a', [second])).groups[0].messages[0].fingerprint;
  assert.notEqual(fingerprint1, fingerprint2);
  const duplicateQuery = structuredClone(first.client.clientState.queries[3]);
  first.client.clientState.queries.push(duplicateQuery);
  assert.equal((await extract('account-a', [first])).groups[0].messages.length, 1);
  duplicateQuery.state.data[0].text = 'different';
  const conflicting = await extract('account-a', [first]);
  assert.equal(conflicting.groups.length, 0);
  assert.equal(conflicting.conflicts, 1);
});

test('optimistic cache IDs are ignored until a stable message ID is available', async () => {
  const input = cache();
  const records = input.client.clientState.queries[3].state.data;
  const temporary = 'local-01234567-89ab-cdef-0123-456789abcdef';
  records.push({ ...records[0], id: temporary });
  const result = await extract('account-a', [input]);
  assert.deepEqual(result.groups[0].messages.map(message => message.messageId), ['message-1']);
  assert.equal(result.cacheIds.get('kin-a').has(temporary), false);
});

test('journals require the verified account and Kin, a timestamp, and bounded plaintext', async () => {
  const input = cache();
  const query = (uid, kinId, entries) => ({ queryKey: ['v2', 'journal-entries', 'kin', uid, kinId], state: { data: { pages: [{ entries }] } } });
  const base = { id: 'journal-1', created: 1730000000000, description: 'A remembered day', keywords: ['one', 'two'], origin: 'ai', image: null, accessToken: 'do-not-send' };
  input.client.clientState.queries.push(query('account-a', 'kin-a', [
    base, { ...base, id: 'empty-keywords', keywords: [], origin: null },
    { ...base, id: 'invalid-keywords', keywords: [42] },
    { ...base, id: 'missing-time', created: null },
    { ...base, id: 'encrypted', description: 'U2FsdGVkX1abcdefghijkl==' },
    { ...base, id: 'conflict', description: 'one' }, { ...base, id: 'conflict', description: 'two' },
  ]));
  input.client.clientState.queries.push(query('wrong-account', 'kin-a', [{ ...base, id: 'wrong-account' }]));
  input.client.clientState.queries.push(query('account-a', 'unknown', [{ ...base, id: 'wrong-kin' }]));
  const result = await extract('account-a', [input]);
  assert.equal(result.journals.length, 1);
  assert.equal(result.journals[0].kinId, 'kin-a');
  assert.deepEqual(result.journals[0].entries, [
    { entryId: 'journal-1', createdAt: '2024-10-27T03:33:20.000Z', description: 'A remembered day', keywords: ['one', 'two'], origin: 'ai' },
    { entryId: 'empty-keywords', createdAt: '2024-10-27T03:33:20.000Z', description: 'A remembered day', keywords: [] },
    { entryId: 'invalid-keywords', createdAt: '2024-10-27T03:33:20.000Z', description: 'A remembered day', origin: 'ai' },
  ]);
  assert.equal(result.conflicts, 1);
  assert.ok(result.incompleteFields >= 2);
  assert.doesNotMatch(JSON.stringify(result.journals), /do-not-send|wrong-account|wrong-kin/);
});
