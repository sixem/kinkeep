import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import '../cache-read.js';
import '../extract.js';

const source = await readFile(new URL('../capture.js', import.meta.url), 'utf8');

async function harness({ changeOwner = false, firstSnapshotMissing = false, partial = false, unsupported = false, imageArchiving = true } = {}) {
  const sent = [];
  let reads = 0, snapshots = 0, rescan, settingsChanged;
  const settings = { enabled: true, imageArchiving };
  const uid = 'u', kinId = 'k';
  const cache = { ownerUid: uid, client: { clientState: { queries: [{ queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } }] } } };
  const media = { kinId, sourceId: 's', kind: 'selfie', variant: 'preview', createdAt: '2026-01-01T00:00:00.000Z', url: 'https://img.kindroid.ai/a.webp' };
  const extra = { ...media, sourceId: 'extra', url: 'https://img.kindroid.ai/b.webp' };
  let now = 1;
  class ClockDate extends Date { static now() { return now; } }
  const context = {
    Date: ClockDate,
    document: { addEventListener() {} }, location: { pathname: '/v2/chat/k' }, localStorage: {}, indexedDB: {},
    setTimeout, clearTimeout, setInterval(fn) { rescan = fn; },
    chrome: {
      storage: { local: { get: async () => ({ settings }) }, onChanged: { addListener(fn) { settingsChanged = fn; } } },
      runtime: { sendMessage: async message => {
        sent.push(message);
        if (message.type === 'mediaSnapshot') {
          snapshots++;
          if (unsupported) return { ok: false, reason: 'unsupported' };
          const urls = message.urls.filter(url => !((firstSnapshotMissing || partial && url === extra.url) && snapshots === 1));
          return { ok: true, images: urls.map(url => ({ url, mime: 'image/webp', data: 'QUJD' })) };
        }
        return { ok: true };
      } },
    },
    KinKeepCache: { ...globalThis.KinKeepCache, firebaseUid: () => ({ state: 'ready', uid }), getAuthenticatedCaches: async () => {
      reads++;
      return [changeOwner && reads >= 2 ? { ...cache, ownerUid: 'other' } : cache];
    } },
    KinKeepExtract: { extract: async () => ({ state: 'ready', account: { accountId: uid }, kins: [{ accountId: uid, kinId }], profiles: [], groups: [], journals: [] }), fingerprint: globalThis.KinKeepExtract.fingerprint },
    KinKeepDom: { extractVisible: async () => [], historyView: () => null },
    KinKeepMediaCandidates: { read: () => partial ? [media, extra] : [media] },
    KinKeepPlaintext: { createTracker: () => ({ reset() {} }), read: () => null },
  };
  await vm.runInNewContext(source, context);
  return { sent, rescan: (ms = 15000) => { now += ms; return rescan(); }, setImages: value => { settings.imageArchiving = value; return settingsChanged({ settings: {} }, 'local'); } };
}

test('scanner skips images while disabled and resumes after re-enabling', async () => {
  const { sent, setImages } = await harness({ imageArchiving: false });
  assert.equal(sent.some(message => message.type === 'mediaSnapshot' || message.type === 'mediaSave'), false);
  assert.equal(sent.some(message => message.type === 'inventory'), true);
  await setImages(true);
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
  assert.equal(sent.filter(message => message.type === 'mediaSave').length, 1);
});

test('scanner saves only matched image data without persisting its source URL', async () => {
  const { sent } = await harness();
  const payload = sent.find(message => message.type === 'mediaSave');
  assert.equal(payload?.items[0].sourceId, 's');
  assert.equal(payload.items[0].data, 'QUJD');
  assert.equal(Object.hasOwn(payload.items[0], 'url'), false);
});

test('scanner does not retry unsupported image capture or mark images as saved', async () => {
  const { sent, rescan } = await harness({ unsupported: true });
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
  await rescan();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
});

test('scanner refuses media when account binding changes', async () => {
  const { sent } = await harness({ changeOwner: true });
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
});

test('scanner retries an incomplete image snapshot until the image is archived', async () => {
  const { sent, rescan } = await harness({ firstSnapshotMissing: true });
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 1);
  assert.equal(sent.some(message => message.type === 'mediaSave'), false);
  await rescan();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 2);
  assert.equal(sent.filter(message => message.type === 'mediaSave').length, 1);
  await rescan();
  assert.equal(sent.filter(message => message.type === 'mediaSnapshot').length, 2);
});

test('partial snapshots wait before retrying and request only missing images', async () => {
  const { sent, rescan } = await harness({ partial: true });
  await rescan(1000);
  assert.equal(sent.filter(m => m.type === 'mediaSnapshot').length, 1);
  await rescan(14000);
  assert.deepEqual(sent.filter(m => m.type === 'mediaSnapshot').map(m => [...m.urls]), [
    ['https://img.kindroid.ai/a.webp', 'https://img.kindroid.ai/b.webp'], ['https://img.kindroid.ai/b.webp'],
  ]);
  assert.deepEqual(sent.filter(m => m.type === 'mediaSave').map(m => m.items[0].sourceId), ['s', 'extra']);
});
