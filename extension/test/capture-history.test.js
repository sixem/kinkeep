import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../extract.js';
import '../dom-extract.js';

const source = await readFile(new URL('../capture.js', import.meta.url), 'utf8');
async function settle() { await new Promise(resolve => setTimeout(resolve, 20)); for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }
function harness({ flipOwner = false, timestamp = 1730000000000, text, changedText, journals = [] } = {}) {
  const uid = 'account', kinId = 'kin', sent = [];
  let reads = 0;
  const content = { nodeType: 1, tagName: 'P', childNodes: [{ nodeType: 3, nodeValue: 'A history message' }] };
  const article = { parentElement: { id: 'v2-history-msg' }, classList: ['chat_align-other__hash'], querySelectorAll: () => [content] };
  const body = { querySelectorAll: () => [article] };
  const dialog = { isConnected: true, hidden: false, getAttribute: name => name === 'aria-label' ? 'Chat history' : null, getBoundingClientRect: () => ({ width: 1, height: 1 }), querySelectorAll: () => [body] };
  const document = { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, querySelectorAll: () => [dialog], addEventListener: () => {} };
  const cache = { ownerUid: uid, client: { clientState: { queries: [{ queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } }] } } };
  const snapshot = { state: 'ready', account: { accountId: uid }, kins: [{ accountId: uid, kinId }], profiles: [], groups: [], journals, conflicts: 0, incompleteFields: 0 };
  const listeners = new Set();
  const location = { pathname: '/v2/kin-settings/kin', origin: 'https://kindroid.ai' };
  let requests = 0;
  const window = {
    addEventListener: (type, fn) => listeners.add(fn), removeEventListener: (type, fn) => listeners.delete(fn),
    postMessage: request => queueMicrotask(() => {
      requests++;
      const currentText = requests > 1 && changedText !== undefined ? changedText : text;
      const data = { type: 'KINEXPORT_HISTORY_RESPONSE', nonce: request.nonce, uid, kinId, records: [{ id: 'msg', timestamp, isSelf: false, ...(currentText === undefined ? {} : { text: currentText, chatHistoryRecordId: 'history-1' }) }] };
      for (const fn of [...listeners]) fn({ source: window, origin: location.origin, data });
    }),
  };
  const context = { window, document, location, crypto: { randomUUID: () => 'test-nonce' }, localStorage: {}, indexedDB: {}, setTimeout: (fn, delay) => setTimeout(fn, delay === 350 ? 0 : delay), clearTimeout, setInterval: () => 0,
    chrome: { storage: { local: { get: async () => ({ settings: { enabled: true } }) }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async message => { sent.push(message); return { ok: true }; } } },
    KinexportCache: { firebaseUid: () => ({ state: 'ready', uid }), getAuthenticatedCaches: async () => { reads++; return [flipOwner && reads >= 3 ? { ...cache, ownerUid: 'other' } : cache]; } },
    KinexportExtract: { extract: async () => snapshot, fingerprint: globalThis.KinexportExtract.fingerprint }, KinexportDom: globalThis.KinexportDom,
    KinexportPlaintext: { createTracker: () => ({ reset() {} }), read: () => null },
  };
  vm.runInNewContext(source, context);
  return { sent };
}
test('scanner submits history only with matched message metadata and an explicit timestamp', async () => {
  const h = harness(); await settle();
  const batches = h.sent.filter(item => item.type === 'captureBatch');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kinId, 'kin');
  assert.equal(batches[0].messages[0].timestamp, '2024-10-27T03:33:20.000Z');
  assert.equal(batches[0].messages[0].content, 'A history message');
  const missing = harness({ timestamp: null }); await settle();
  assert.equal(missing.sent.filter(item => item.type === 'captureBatch').length, 0);
});
test('scanner refuses history if the cache owner changes before submission', async () => {
  const h = harness({ flipOwner: true }); await settle();
  assert.equal(h.sent.filter(item => item.type === 'captureBatch').length, 0);
  assert.ok(h.sent.some(item => item.type === 'captureStatus' && item.state === 'identity-uncertain'));
});
test('scanner stores original source text and refuses content that changed before sending', async () => {
  const h = harness({ text: '*original*\n\nsource' }); await new Promise(resolve => setTimeout(resolve, 30)); await settle();
  const message = h.sent.find(item => item.type === 'captureBatch')?.messages[0];
  assert.equal(message?.content, '*original*\n\nsource');
  assert.equal(message?.data.captureSource, 'history');
  assert.equal(message?.data.chatHistoryRecordId, 'history-1');
  const changed = harness({ text: 'old', changedText: 'new' }); await new Promise(resolve => setTimeout(resolve, 30)); await settle();
  assert.equal(changed.sent.filter(item => item.type === 'captureBatch').length, 0);
});
test('scanner submits journals in bounded batches and rechecks account ownership', async () => {
  const entries = Array.from({ length: 21 }, (_, index) => ({ entryId: `entry-${index}`, createdAt: '2024-10-27T03:33:20.000Z', description: 'Entry' }));
  const journals = [{ kinId: 'kin', entries }];
  const h = harness({ timestamp: null, journals }); await settle();
  const batches = h.sent.filter(item => item.type === 'journal');
  assert.deepEqual(batches.map(item => item.entries.length), [10, 10, 1]);
  assert.ok(batches.every(item => item.accountId === 'account' && item.kinId === 'kin'));
  const changed = harness({ flipOwner: true, timestamp: null, journals }); await settle();
  assert.equal(changed.sent.filter(item => item.type === 'journal').length, 0);
});
