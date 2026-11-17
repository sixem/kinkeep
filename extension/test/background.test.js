import test from 'node:test';
import assert from 'node:assert/strict';

// Simulate extension APIs so the worker's wire protocol and failure behavior
// are checked without needing an installed browser extension.
test('background validates token, probes batches, and warns once per outage', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:8765', token: 'secret' } };
  const requests = [];
  const notices = [];
  let listener;
  let available = true;
  let pauseDuringProbe = false;
  globalThis.chrome = {
    storage: { local: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async values => Object.assign(store, structuredClone(values)),
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    notifications: { create: async (...args) => notices.push(args) },
    pageCapture: { saveAsMHTML: async () => new Blob(['MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n--x\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: https://img.kindroid.ai/a.png\r\n\r\nQUJD\r\n--x--\r\n']) },
    permissions: { contains: async () => true },
    runtime: {
      id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (!available) throw new Error('unreachable');
    if (url.endsWith('/api/health')) return { ok: true, json: async () => ({ status: 'ok' }) };
    assert.equal(options.headers.Authorization, 'Bearer secret');
    if (url.endsWith('/api/probe')) {
      const { messages } = JSON.parse(options.body);
      if (pauseDuringProbe) store.settings.enabled = false;
      return { ok: true, json: async () => ({ results: messages.map((_, i) => ({ status: i === 0 ? 'unchanged' : 'missing' })) }) };
    }
    if (url.endsWith('/api/accounts') || url.endsWith('/api/kins') || url.endsWith('/api/kins/profile')) return { ok: true, json: async () => ({ ok: true }) };
    if (url.endsWith('/api/kins/journal')) return { ok: true, json: async () => ({ inserted: 1, unchanged: 0, historical: 0 }) };
    if (url.endsWith('/api/kins/media')) return { ok: true, json: async () => ({ inserted: 1, unchanged: 0 }) };
    if (url.endsWith('/api/messages')) return { ok: true, json: async () => ({ inserted: 1, updated: 0, unchanged: 0 }) };
    throw new Error(`Unexpected URL ${url}`);
  };
  await import('../background.js');
  const send = (message, sender) => new Promise(resolve => { assert.equal(listener(message, sender, resolve), true); });
  const popup = { id: 'extension-id', url: 'chrome-extension://extension-id/popup.html' };
  const tab = { id: 'extension-id', tab: { id: 12, url: 'https://kindroid.ai/chat' } };
  assert.deepEqual(await send({ type: 'checkConnection' }, popup), { ok: true });
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/health', '/api/probe']);
  requests.length = 0;
  assert.equal((await send({ type: 'inventory', account: { accountId: 'acct' }, kins: [{ accountId: 'acct', kinId: 'kin', name: 'Alex' }] }, tab)).ok, true);
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/accounts', '/api/kins']);
  requests.length = 0;
  const profile = { accountId: 'acct', kinId: 'kin', fields: { ai_backstory: { value: '', observedAt: '2024-01-01T00:00:00.000Z' } } };
  assert.equal((await send({ type: 'profile', profile }, tab)).ok, true);
  assert.equal(new URL(requests[0].url).pathname, '/api/kins/profile');
  assert.deepEqual(JSON.parse(requests[0].body), profile);
  requests.length = 0;
  const entry = { entryId: 'journal-1', createdAt: '2024-01-01T00:00:00.000Z', description: 'Entry', keywords: ['one'], origin: 'ai', accessToken: 'do-not-send' };
  assert.equal((await send({ type: 'journal', accountId: 'acct', kinId: 'kin', entries: [entry] }, tab)).ok, true);
  assert.equal(new URL(requests[0].url).pathname, '/api/kins/journal');
  assert.deepEqual(JSON.parse(requests[0].body), { accountId: 'acct', kinId: 'kin', entries: [{ entryId: 'journal-1', createdAt: entry.createdAt, description: 'Entry', keywords: ['one'], origin: 'ai' }] });
  requests.length = 0;
  assert.equal((await send({ type: 'journal', accountId: 'acct', kinId: 'kin', entries: [{ ...entry, createdAt: 'invalid' }] }, tab)).ok, false);
  assert.equal(requests.length, 0);
  store.settings.enabled = false;
  assert.equal((await send({ type: 'journal', accountId: 'acct', kinId: 'kin', entries: [entry] }, tab)).ok, false);
  assert.equal(requests.length, 0);
  store.settings.enabled = true;
  const captured = await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.png'] }, tab);
  assert.deepEqual(captured, { ok: true, images: [{ url: 'https://img.kindroid.ai/a.png', mime: 'image/png', data: 'QUJD' }] });
  assert.equal((await send({ type: 'mediaSave', accountId: 'acct', kinId: 'kin', items: [{ sourceId: 's', kind: 'selfie', variant: 'preview', mime: 'image/png', data: 'QUJD' }] }, tab)).ok, true);
  assert.equal(new URL(requests.at(-1).url).pathname, '/api/kins/media');
  const messages = [{ conversationId: 'c', fingerprint: 'a', content: 'one' }, { conversationId: 'c', fingerprint: 'b', content: 'two' }];
  assert.equal((await send({ type: 'captureBatch', accountId: 'acct', kinId: 'kin', messages }, tab)).ok, true);
  assert.deepEqual(JSON.parse(requests.at(-1).body), { accountId: 'acct', kinId: 'kin', messages: [messages[1]] });
  requests.length = 0;
  pauseDuringProbe = true;
  assert.equal((await send({ type: 'captureBatch', accountId: 'acct', kinId: 'kin', messages }, tab)).ok, false);
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/probe']);
  pauseDuringProbe = false;
  store.settings.enabled = true;
  available = false;
  assert.equal((await send({ type: 'captureBatch', accountId: 'acct', kinId: 'kin', messages }, tab)).ok, false);
  assert.equal(store.status.state, 'offline');
  assert.equal(notices.length, 0);
  store.status.failureSince -= 16_000;
  await send({ type: 'captureBatch', accountId: 'acct', kinId: 'kin', messages }, tab);
  await send({ type: 'captureBatch', accountId: 'acct', kinId: 'kin', messages }, tab);
  assert.equal(notices.length, 1);
  available = true;
  assert.equal((await send({ type: 'checkConnection' }, popup)).ok, true);
  assert.equal(store.status.state, 'online');
  assert.ok(requests.every(request => request.url.startsWith('http://127.0.0.1:8765/')));
  delete globalThis.chrome;
});

test('Firefox promise APIs accept verified content senders and report unsupported media', async () => {
  const store = { settings: { enabled: true, endpoint: 'http://127.0.0.1:8765', token: 'secret' } };
  const requests = [];
  let listener;
  globalThis.chrome = {};
  globalThis.browser = {
    storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => Object.assign(store, structuredClone(values)) } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    notifications: { create: async () => {} }, permissions: { contains: async () => true },
    runtime: { id: 'extension-id', getURL: path => `moz-extension://extension-id/${path}`,
      onMessage: { addListener(fn) { listener = fn; } }, onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
  };
  globalThis.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ ok: true }) }; };
  try {
    await import('../background.js?firefox');
    const send = (message, sender) => new Promise(resolve => { assert.equal(listener(message, sender, resolve), true); });
    const popup = { id: 'extension-id', url: 'moz-extension://extension-id/popup.html' };
    const tab = { id: 'extension-id', url: 'https://kindroid.ai/v2/chat/kin', frameId: 0, tab: { id: 12 } };
    assert.deepEqual(await send({ type: 'capabilities' }, popup), { imageCapture: false });
    assert.deepEqual(await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.webp'] }, tab), { ok: false, reason: 'unsupported' });
    assert.equal((await send({ type: 'inventory', account: { accountId: 'acct' }, kins: [{ accountId: 'acct', kinId: 'kin' }] }, tab)).ok, true);
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/api/accounts', '/api/kins']);
    assert.equal(listener({ type: 'inventory' }, { ...tab, url: 'https://other.example/' }, () => {}), false);
    assert.equal(listener({ type: 'inventory' }, { ...tab, frameId: 2 }, () => {}), false);
    assert.equal(listener({ type: 'inventory' }, { ...tab, tab: { ...tab.tab, url: 'https://other.example/' } }, () => {}), false);
  } finally { delete globalThis.browser; delete globalThis.chrome; }
});
