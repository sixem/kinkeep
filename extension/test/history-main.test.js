import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../history-main.js', import.meta.url), 'utf8');
const key = (uid = 'user-a', kin = 'kin-a') => ['v2', 'chat-history-window', uid, 'ai', kin, 'window', 1, 2];
const entry = (id, timestamp = 1730000000000, isSelf = false) => ({ id, timestamp, isSelf, text: 'private text', token: 'private token' });
const query = (queryKey, messages) => ({ queryKey, state: { data: { pages: [{ messages }] } } });
const client = queries => ({ getQueryCache: () => ({ getAll: () => queries }) });
function makeBridge(clients, pathname = '/v2/kin-settings/kin-a/') {
  let listener;
  const replies = [];
  const children = clients.map(value => ({ memoizedProps: { value: { queryClient: value } } }));
  for (let i = 0; i < children.length - 1; i++) children[i].sibling = children[i + 1];
  const root = { '__reactContainer$test': { child: children[0] } };
  const window = { addEventListener(type, callback) { assert.equal(type, 'message'); listener = callback; }, postMessage(value, origin) { replies.push({ value: JSON.parse(JSON.stringify(value)), origin }); } };
  const location = { origin: 'https://kindroid.ai', pathname };
  const document = { documentElement: root, createTreeWalker: () => ({ nextNode: () => null }) };
  vm.runInNewContext(script, { window, document, location, NodeFilter: { SHOW_ELEMENT: 1 }, Date });
  return { replies, send(data, overrides = {}) { listener({ source: window, origin: location.origin, data, ...overrides }); } };
}
const request = (ids = ['message-a']) => ({ type: 'KINKEEP_HISTORY_REQUEST', nonce: 'nonce_123', uid: 'user-a', kinId: 'kin-a', ids });

test('returns only requested IDs, original text and allowlisted metadata from matching queries', () => {
  const bridge = makeBridge([client([
    query(key(), [entry('message-a', 1730000000000, true), entry('unrequested')]),
    query(key('another-user'), [entry('message-b')]),
    query(key('user-a', 'another-kin'), [entry('message-b')]),
  ])]);
  bridge.send(request(['message-a', 'message-b']));
  assert.deepEqual(bridge.replies, [{ value: { type: 'KINKEEP_HISTORY_RESPONSE', nonce: 'nonce_123', uid: 'user-a', kinId: 'kin-a', records: [{ id: 'message-a', timestamp: 1730000000000, isSelf: true, text: 'private text' }] }, origin: 'https://kindroid.ai' }]);
});

test('rejects conflicting and malformed duplicate metadata and wrong query shapes', () => {
  const wrongType = key(); wrongType[3] = 'group';
  const wrongWindow = key(); wrongWindow[6] = '1';
  const bridge = makeBridge([client([
    query(key(), [entry('conflict'), entry('conflict', 1730000000001), entry('invalid', null), entry('invalid'), entry('valid')]),
    query(wrongType, [entry('wrong-type')]), query(wrongWindow, [entry('wrong-window')]),
  ])]);
  bridge.send(request(['conflict', 'invalid', 'valid', 'wrong-type', 'wrong-window']));
  assert.deepEqual(bridge.replies[0].value.records, [{ id: 'valid', timestamp: 1730000000000, isSelf: false, text: 'private text' }]);
});

test('copies bounded metadata, rejects conflicting text and omits encrypted or malformed data', () => {
  const first = { ...entry('valid'), text: '*exact*\n\ntext', persona: 'Persona', chatHistoryRecordId: 'history', senderAiId: 'kin', reactions: { 'kin:k': '❤️' }, reactionsRevision: 3 };
  const bridge = makeBridge([client([query(key(), [first, { ...entry('changed'), text: 'one' }, { ...entry('changed'), text: 'two' },
    { ...entry('encrypted'), text: 'U2FsdGVkX1abcdefghij==', reactions: { token: 'x' }, persona: ' ' },
  ])])]);
  bridge.send(request(['valid', 'changed', 'encrypted']));
  assert.deepEqual(bridge.replies[0].value.records, [
    { id: 'valid', timestamp: 1730000000000, isSelf: false, text: '*exact*\n\ntext', persona: 'Persona', chatHistoryRecordId: 'history', senderAiId: 'kin', reactionsRevision: 3, reactions: { 'kin:k': '❤️' } },
    { id: 'encrypted', timestamp: 1730000000000, isSelf: false },
  ]);
});

test('ignores invalid route, messages, origin, and multiple matching query clients', () => {
  const c = client([query(key(), [entry('message-a')])]);
  const wrongRoute = makeBridge([c], '/v2/chat/kin-a');
  wrongRoute.send(request());
  assert.equal(wrongRoute.replies.length, 0);
  const bridge = makeBridge([c, client([query(key(), [entry('message-a')])])]);
  bridge.send(request(), { origin: 'https://other.example' });
  bridge.send({ ...request(), ids: ['message-a', 'message-a'] });
  bridge.send({ ...request(), nonce: '<bad>' });
  assert.equal(bridge.replies.length, 0);
  bridge.send(request());
  assert.deepEqual(bridge.replies[0].value.records, []);
});

test('finds a client through a hook baseState and accepts URL-encoded Kin IDs', () => {
  const value = client([query(key('user-a', 'kin a'), [entry('message-a')])]);
  let listener;
  const replies = [];
  const root = { '__reactContainer$test': { current: { child: { memoizedState: { baseState: { client: value } } } } } };
  const window = { addEventListener(_type, callback) { listener = callback; }, postMessage(payload) { replies.push(JSON.parse(JSON.stringify(payload))); } };
  const location = { origin: 'https://kindroid.ai', pathname: '/v2/kin-settings/kin%20a' };
  const document = { documentElement: root, createTreeWalker: () => ({ nextNode: () => null }) };
  vm.runInNewContext(script, { window, document, location, NodeFilter: { SHOW_ELEMENT: 1 }, Date });
  listener({ source: window, origin: location.origin, data: { ...request(), kinId: 'kin a' } });
  assert.equal(replies[0].records.length, 1);
});

test('continues scanning other fibers when a state chain exceeds the hook limit', () => {
  const value = client([query(key(), [entry('message-a')])]);
  let chain = null;
  for (let i = 0; i < 110; i++) chain = { next: chain };
  let listener;
  const replies = [];
  const root = { '__reactContainer$test': { child: { memoizedState: chain, sibling: { memoizedProps: { value } } } } };
  const window = { addEventListener(_type, callback) { listener = callback; }, postMessage(payload) { replies.push(JSON.parse(JSON.stringify(payload))); } };
  const location = { origin: 'https://kindroid.ai', pathname: '/v2/kin-settings/kin-a' };
  const document = { documentElement: root, createTreeWalker: () => ({ nextNode: () => null }) };
  vm.runInNewContext(script, { window, document, location, NodeFilter: { SHOW_ELEMENT: 1 }, Date });
  listener({ source: window, origin: location.origin, data: request() });
  assert.equal(replies[0].records.length, 1);
});
