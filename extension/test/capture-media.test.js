import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../extract.js';

const source = await readFile(new URL('../capture.js', import.meta.url), 'utf8');
const wait = () => new Promise(resolve => setTimeout(resolve, 40));

function harness({ changeOwner = false, firstSnapshotMissing = false, unsupported = false } = {}) {
  const sent = [];
  let reads = 0, snapshots = 0, rescan;
  const uid = 'u', kinId = 'k';
  const cache = { ownerUid: uid, client: { clientState: { queries: [{ queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } }] } } };
  const media = { kinId, sourceId: 's', kind: 'selfie', variant: 'preview', createdAt: '2026-01-01T00:00:00.000Z', url: 'https://img.kindroid.ai/a.webp' };
  const context = {
    document: { addEventListener() {} }, location: { pathname: '/v2/chat/k' }, localStorage: {}, indexedDB: {},
    setTimeout, clearTimeout, setInterval(fn) { rescan = fn; },
    chrome: {
      storage: { local: { get: async () => ({ settings: { enabled: true } }) }, onChanged: { addListener() {} } },
      runtime: { sendMessage: async message => {
        sent.push(message);
        if (message.type === 'mediaSnapshot') {
          snapshots++;
          if (unsupported) return { ok: false, reason: 'unsupported' };
          return { ok: true, images: firstSnapshotMissing && snapshots === 1 ? [] : [{ url: media.url, mime: 'image/webp', data: 'QUJD' }] };
        }
        return { ok: true };
      } },
    },
    KinexportCache: { firebaseUid: () => ({ state: 'ready', uid }), getAuthenticatedCaches: async () => {
      reads++;
      return [changeOwner && reads >= 2 ? { ...cache, ownerUid: 'other' } : cache];
    } },
    KinexportExtract: { extract: async () => ({ state: 'ready', account: { accountId: uid }, kins: [{ accountId: uid, kinId }], profiles: [], groups: [], journals: [] }), fingerprint: globalThis.KinexportExtract.fingerprint },
    KinexportDom: { extractVisible: async () => [], historyView: () => null },
    KinexportMediaCandidates: { read: () => [media] },
    KinexportPlaintext: { createTracker: () => ({ reset() {} }), read: () => null },
  };
  vm.runInNewContext(source, context);
  return { sent, rescan: () => rescan() };
}

test('scanner saves only matched image data without persisting its source URL', async () => {
  const { sent } = harness(); await wait();
  const payload = sent.find(message => message.type === 'mediaSave');
  assert.equal(payload?.items[0].sourceId, 's');
  assert.equal(payload.items[0].data, 'QUJD');
  assert.equal(Object.hasOwn(payload.items[0], 'url'), false);
});

test('scanner does not retry unsupported image capture or mark images as saved', async () => {
  const { sent, rescan } = harness({ unsupported: true }); await wait();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
  rescan(); await wait();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
});

test('scanner refuses media when account binding changes', async () => {
  const { sent } = harness({ changeOwner: true }); await wait();
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
});

test('scanner retries an incomplete image snapshot until the image is archived', async () => {
  const { sent, rescan } = harness({ firstSnapshotMissing: true }); await wait();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
  rescan(); await wait();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 2);
  assert.equal(sent.filter(message => message.type === 'mediaSave').length, 1);
  rescan(); await wait();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 2);
});
