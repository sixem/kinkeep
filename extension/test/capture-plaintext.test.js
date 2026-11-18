import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../cache-read.js';
import '../plaintext.js';

const source = await readFile(new URL('../capture.js', import.meta.url), 'utf8');
async function harness({ flipOwner = false, displayName } = {}) {
  let now = 0, timerId = 0, cacheReads = 0;
  const timers = new Map(), sent = [];
  const uid = 'account', kinId = 'kin';
  const snapshot = { state: 'ready', account: { accountId: uid }, kins: [{ accountId: uid, kinId }], profiles: [], groups: [], conflicts: 0, incompleteFields: 0 };
  const element = { tagName: 'TEXTAREA', labels: [{ textContent: 'Personality' }], value: 'a draft', isConnected: true, hidden: false, disabled: false, closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }), ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } } };
  const document = { activeElement: null, querySelectorAll: () => [element], addEventListener: () => {} };
  const cache = { ownerUid: uid, client: { clientState: { queries: [{ queryKey: ['v2','user',uid], state: { data: { aiList: [kinId] } } }] } } };
  class ClockDate extends Date { static now() { return now; } }
  const context = { document, location: { pathname: '/v2/kin-settings/kin' }, localStorage: {}, indexedDB: {}, Date: ClockDate,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => 0,
    chrome: { storage: { local: { get: async () => ({ settings: { enabled: true } }) }, onChanged: { addListener: () => {} } }, runtime: { sendMessage: async message => { sent.push(message); return { ok: true }; } } },
    KinKeepCache: { ...globalThis.KinKeepCache, firebaseUid: () => ({ state: 'ready', uid, ...(displayName ? { displayName } : {}) }), getAuthenticatedCaches: async () => { cacheReads++; return [flipOwner && cacheReads >= 3 ? { ...cache, ownerUid: 'other' } : cache]; } },
    KinKeepExtract: { extract: async () => snapshot, fingerprint: async () => 'profile-hash' }, KinKeepDom: { extractVisible: async () => [] }, KinKeepPlaintext: globalThis.KinKeepPlaintext,
  };
  await vm.runInNewContext(source, context);
  return { sent, element, timers, async advance(ms) { now += ms; for (const [id, timer] of [...timers]) { timers.delete(id); await timer.fn(); } } };
}
test('scanner observes stable plaintext once without collecting encrypted-field replacements', async () => {
  const h = await harness();
  assert.equal(h.sent.filter(item => item.type === 'profile').length, 0);
  await h.advance(1600);
  const profiles = h.sent.filter(item => item.type === 'profile');
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].profile.fields.ai_backstory_plaintext.value, 'a draft');
  assert.equal(Object.hasOwn(profiles[0].profile.fields, 'ai_backstory'), false);
  await h.advance(15000);
  assert.equal(h.sent.filter(item => item.type === 'profile').length, 1);
});
test('scanner refuses plaintext if cache owner changes before submission', async () => {
  const h = await harness({ flipOwner: true });
  await h.advance(1600);
  assert.equal(h.sent.filter(item => item.type === 'profile').length, 0);
  assert.ok(h.sent.some(item => item.type === 'captureStatus' && item.state === 'identity-uncertain'));
});
test('scanner sends the verified account display name when available', async () => {
  const h = await harness({ displayName: 'Example Name' });
  const inventory = h.sent.find(item => item.type === 'inventory');
  assert.equal(inventory.account.accountId, 'account');
  assert.equal(inventory.account.displayName, 'Example Name');
});
