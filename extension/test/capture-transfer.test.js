import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../cache-read.js';
import '../extract.js';

const source = await readFile(new URL('../capture.js', import.meta.url), 'utf8');
const message = (messageId, fingerprint, content = 'sample') => ({ conversationId: 'main', messageId, fingerprint, content });

async function harness({ enabled = true, messages = [message('a', 'a1'), message('b', 'b1')], entries = [{ entryId: 'j' }] } = {}) {
  let uid = 'account', tick, settingsChanged;
  let rejectBatch = false, observed = false, cacheReads = 0;
  let archiveKnowsKin = false;
  const settings = { enabled };
  const sent = [];
  const snapshot = () => ({
    state: 'ready', account: { accountId: uid }, kins: [{ accountId: uid, kinId: 'k' }],
    groups: [{ kinId: 'k', messages }], profiles: [{ accountId: uid, kinId: 'k', fields: { ai_name: { value: 'sample' } } }],
    journals: [{ kinId: 'k', entries }],
  });
  await vm.runInNewContext(source, {
    document: { documentElement: {}, addEventListener() {} }, location: { pathname: '/v2/chat/k' }, localStorage: {}, indexedDB: {},
    setTimeout, clearTimeout, setInterval(fn) { tick = fn; },
    MutationObserver: class { observe() { observed = true; } disconnect() { observed = false; } },
    chrome: {
      storage: { local: { get: async () => ({ settings }) }, onChanged: { addListener(fn) { settingsChanged = fn; } } },
      runtime: { sendMessage: async value => {
        sent.push(structuredClone(value));
        if (value.type === 'inventory') archiveKnowsKin = true;
        else if (value.type !== 'captureStatus' && !archiveKnowsKin) return { ok: false, reason: 'Archive returned HTTP 400.' };
        if (rejectBatch && value.type === 'captureBatch') { rejectBatch = false; return { ok: false }; }
        return { ok: true };
      } },
    },
    KinKeepCache: { ...globalThis.KinKeepCache, firebaseUid: () => ({ state: 'ready', uid }), getAuthenticatedCaches: async () => {
      cacheReads++;
      return [{ ownerUid: uid, client: { clientState: { queries: [{ queryKey: ['v2', 'user', uid], state: { data: { aiList: ['k'] } } }] } } }];
    } },
    KinKeepExtract: { extract: async () => snapshot(), fingerprint: globalThis.KinKeepExtract.fingerprint },
    KinKeepDom: { extractVisible: async () => [] },
    KinKeepPlaintext: { createTracker: () => ({ reset() {} }), read: () => null },
  });
  return { sent, messages, tick, settings, configure() { return settingsChanged({ settings: {} }, 'local'); },
    restoreEmptyArchive() { archiveKnowsKin = false; }, changeOwner() { uid = 'other'; }, rejectNextBatch() { rejectBatch = true; },
    get observed() { return observed; }, get cacheReads() { return cacheReads; },
  };
}

test('one changed message transfers independently, including retries and account switches', async () => {
  const h = await harness();
  assert.deepEqual(h.sent.map(m => m.type), ['inventory', 'captureBatch', 'journal', 'profile', 'captureStatus']);
  h.sent.length = 0;
  await h.tick();
  assert.deepEqual(h.sent, []);
  h.messages[0] = message('a', 'a2');
  h.rejectNextBatch();
  await h.tick();
  await h.tick();
  assert.deepEqual(h.sent.filter(m => m.type === 'captureBatch').map(m => m.messages.map(item => item.fingerprint)), [['a2'], ['a2', 'b1']]);
  h.sent.length = 0;
  h.messages.push(message('c', 'c1'));
  await h.tick();
  assert.deepEqual(h.sent.map(m => m.type), ['captureBatch']);
  assert.deepEqual(h.sent[0].messages.map(m => m.fingerprint), ['c1']);
  h.sent.length = 0;
  h.changeOwner();
  await h.tick();
  assert.deepEqual(h.sent.map(m => m.type), ['inventory', 'captureBatch', 'journal', 'profile']);
  assert.deepEqual(h.sent[1].messages.map(m => m.fingerprint), ['a2', 'b1', 'c1']);
});

test('paused capture suspends observation and cache polling, and resumes on a settings change', async () => {
  const h = await harness({ enabled: false });
  await h.tick();
  assert.equal(h.observed, false);
  assert.equal(h.cacheReads, 0);
  h.settings.enabled = true;
  await h.configure();
  assert.ok(h.sent.some(m => m.type === 'captureStatus' && m.state === 'ready'));
  assert.equal(h.observed, true);
  h.settings.enabled = false;
  await h.configure();
  assert.equal(h.observed, false);
  const before = h.cacheReads;
  await h.tick();
  assert.equal(h.cacheReads, before);
});

test('large messages split across transfers before reaching the count limit', async () => {
  const content = 'x'.repeat(999999);
  const h = await harness({ messages: [message('a', 'a1', content), message('b', 'b1', content), message('c', 'c1', 'short')] });
  assert.deepEqual(h.sent.filter(m => m.type === 'captureBatch').map(m => m.messages.map(item => item.messageId)), [['a'], ['b', 'c']]);
});

test('large journals respect the serialized size budget and retain entry order', async () => {
  const description = '\u0001'.repeat(200_000);
  const entries = ['a', 'b', 'c'].map(entryId => ({ entryId, description }));
  const h = await harness({ entries });
  assert.deepEqual(h.sent.filter(m => m.type === 'journal').map(m => m.entries.map(entry => entry.entryId)), [['a'], ['b'], ['c']]);
});

test('changing archive settings rechecks every previously acknowledged record', async () => {
  const h = await harness();
  h.sent.length = 0;
  h.settings.endpoint = 'http://localhost:9000';
  await h.configure();
  assert.deepEqual(h.sent.map(m => m.type), ['inventory', 'captureBatch', 'journal', 'profile']);
  assert.equal(h.sent[1].messages.length, 2);
});

test('an empty restored archive receives inventory and all observed records after a scoped write fails', async () => {
  const h = await harness();
  h.restoreEmptyArchive();
  h.sent.length = 0;
  h.messages.push(message('c', 'c1'));
  await h.tick();
  assert.deepEqual(h.sent.map(m => m.type), ['captureBatch']);
  assert.deepEqual(h.sent[0].messages.map(m => m.messageId), ['c']);
  h.sent.length = 0;
  await h.tick();
  assert.deepEqual(h.sent.map(m => m.type), ['inventory', 'captureBatch', 'journal', 'profile']);
  assert.deepEqual(h.sent[1].messages.map(m => m.messageId), ['a', 'b', 'c']);
});
