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
  let changeDuringHealth = null;
  let failure = null;
  let snapshots = 0;
  let duringSnapshot = null;
  globalThis.chrome = {
    storage: { local: {
      get: async key => ({ [key]: structuredClone(store[key]) }),
      set: async values => Object.assign(store, structuredClone(values)),
    } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
    notifications: { create: async (...args) => notices.push(args) },
    pageCapture: { saveAsMHTML: async () => { snapshots++; if (duringSnapshot) duringSnapshot(); return new Blob(['MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="x"\r\n\r\n--x\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-Location: https://img.kindroid.ai/a.png\r\n\r\nQUJD\r\n--x--\r\n']); } },
    permissions: { contains: async () => true },
    runtime: {
      id: 'extension-id', getURL: path => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener(fn) { listener = fn; } },
      onStartup: { addListener() {} }, onInstalled: { addListener() {} },
    },
  };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    if (failure && url.endsWith(failure.path)) {
      if (failure.error) throw failure.error;
      return failure.response;
    }
    if (!available) throw new Error('unreachable');
    if (url.endsWith('/api/health')) { if (changeDuringHealth) changeDuringHealth(); return { ok: true, json: async () => ({ status: 'ok' }) }; }
    assert.equal(options.headers.Authorization, 'Bearer secret');
    if (url.endsWith('/api/probe')) {
      const { messages } = JSON.parse(options.body);
      if (pauseDuringProbe) store.settings.enabled = false;
      return { ok: true, json: async () => ({ results: messages.map((_, i) => ({ status: i === 0 ? 'unchanged' : 'missing' })) }) };
    }
    if (url.endsWith('/api/inventory')) {
      const { account, kins } = JSON.parse(options.body);
      return { ok: true, json: async () => ({ accountId: account.accountId, kinCount: kins.length }) };
    }
    if (url.endsWith('/api/kins/profile')) return { ok: true, json: async () => ({ inserted: 1, updated: 0, unchanged: 0, historical: 0 }) };
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
  for (const [scenario, expected] of [
    [{ path: '/api/health', error: new TypeError('network private-token') }, 'Health check: Connection failed.'],
    [{ path: '/api/probe', error: new TypeError('network private-token') }, 'Authenticated probe: Connection failed.'],
    [{ path: '/api/health', error: Object.assign(new Error('private-token'), { name: 'TimeoutError' }) }, 'Health check: Connection timed out.'],
    [{ path: '/api/probe', response: { ok: false, status: 401 } }, 'Authenticated probe: Archive returned HTTP 401.'],
    [{ path: '/api/health', response: { ok: false, status: 503 } }, 'Health check: Archive returned HTTP 503.'],
    [{ path: '/api/probe', response: { ok: true, json: async () => { throw new SyntaxError('private-token'); } } }, 'Authenticated probe: Unexpected server response.'],
    [{ path: '/api/health', response: { ok: true, json: async () => ({ wrong: true }) } }, 'Health check: Unexpected server response.'],
    [{ path: '/api/probe', response: { ok: true, json: async () => ({ results: 'private-token' }) } }, 'Authenticated probe: Unexpected server response.'],
  ]) {
    failure = scenario;
    const result = await send({ type: 'checkConnection' }, popup);
    assert.deepEqual(result, { ok: false, reason: expected });
    assert.doesNotMatch(JSON.stringify(store.status), /private-token/);
  }
  failure = null;
  for (const change of [
    () => { store.settings.enabled = false; },
    () => { store.settings.endpoint = 'https://new.example'; },
    () => { store.settings.token = 'new-token'; },
  ]) {
    requests.length = 0;
    const original = structuredClone(store.settings);
    changeDuringHealth = change;
    assert.equal((await send({ type: 'checkConnection' }, popup)).ok, false);
    assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/health']);
    store.settings = original;
    changeDuringHealth = null;
  }
  // A manually requested connection test still works while archiving is paused.
  requests.length = 0;
  store.settings.enabled = false;
  assert.deepEqual(await send({ type: 'checkConnection' }, popup), { ok: true });
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/health', '/api/probe']);
  store.settings.enabled = true;
  requests.length = 0;
  assert.equal((await send({ type: 'settingsChanged' }, popup)).ok, true);
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/probe']);
  requests.length = 0;
  const account = { accountId: 'acct' };
  const kins = Array.from({ length: 101 }, (_, i) => ({ accountId: 'acct', kinId: 'kin-' + i }));
  const inventory = { type: 'inventory', account, kins };
  assert.equal((await send(inventory, tab)).ok, true);
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/inventory', '/api/inventory']);
  assert.deepEqual(requests.map(x => JSON.parse(x.body)), [{ account, kins: kins.slice(0, 100) }, { account, kins: kins.slice(100) }]);
  assert.ok(requests.every(x => x.redirect === 'error' && x.credentials === 'omit'));
  requests.length = 0;
  failure = { path: '/api/inventory', response: { ok: true, json: async () => ({ accountId: 'different', kinCount: 100 }) } };
  assert.equal((await send(inventory, tab)).ok, false);
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/api/inventory']);
  failure = null;
  requests.length = 0;
  store.settings.token = '';
  assert.equal((await send(inventory, tab)).ok, false);
  store.settings.token = 'secret';
  store.settings.endpoint = 'https://img.kindroid.ai/';
  assert.equal((await send(inventory, tab)).ok, false);
  assert.equal(requests.length, 0);
  store.settings.endpoint = 'http://127.0.0.1:8765';
  requests.length = 0;
  const profile = { accountId: 'acct', kinId: 'kin', fields: { ai_backstory: { value: '', observedAt: '2024-01-01T00:00:00.000Z' } } };
  assert.equal((await send({ type: 'profile', profile }, tab)).ok, true);
  assert.equal(new URL(requests[0].url).pathname, '/api/kins/profile');
  assert.deepEqual(JSON.parse(requests[0].body), profile);
  failure = { path: '/api/kins/profile', response: { ok: true, json: async () => ({ inserted: 0, updated: 0, unchanged: 0 }) } };
  assert.equal((await send({ type: 'profile', profile }, tab)).ok, false);
  failure = { path: '/api/kins/profile', response: { ok: true, json: async () => { throw new SyntaxError('sensitive-fragment'); } } };
  assert.deepEqual(await send({ type: 'profile', profile }, tab), { ok: false, reason: 'Unexpected server response.' });
  assert.doesNotMatch(JSON.stringify(store.status), /sensitive-fragment/);
  failure = null;
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
  for (const url of ['https://evil.example/a.png', 'http://img.kindroid.ai/a.png', 'https://user:pass@kindroid.ai/a.png']) {
    assert.equal((await send({ type: 'mediaSnapshot', urls: [url] }, tab)).ok, false);
  }
  assert.equal(snapshots, 0);
  assert.equal((await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.png'] }, tab)).ok, false);
  assert.equal(snapshots, 0);
  store.settings.imageArchiving = true;
  const captured = await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.png'] }, tab);
  assert.deepEqual(captured, { ok: true, images: [{ url: 'https://img.kindroid.ai/a.png', mime: 'image/png', data: 'QUJD' }] });
  assert.equal(snapshots, 1);
  store.settings.imageArchiving = false;
  assert.equal((await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.png'] }, tab)).ok, false);
  assert.equal(snapshots, 1);
  const beforeDisabledSave = requests.length;
  assert.equal((await send({ type: 'mediaSave', accountId: 'acct', kinId: 'kin', items: [{ sourceId: 's', kind: 'selfie', variant: 'preview', mime: 'image/png', data: 'QUJD' }] }, tab)).ok, false);
  assert.equal(requests.length, beforeDisabledSave);
  store.settings.imageArchiving = true;
  duringSnapshot = () => { store.settings.imageArchiving = false; };
  assert.equal((await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.png'] }, tab)).ok, false);
  duringSnapshot = null;
  store.settings.imageArchiving = true;
  assert.equal((await send({ type: 'mediaSave', accountId: 'acct', kinId: 'kin', items: [{ sourceId: 's', kind: 'selfie', variant: 'preview', mime: 'image/png', data: 'QUJD' }] }, tab)).ok, true);
  assert.equal(new URL(requests.at(-1).url).pathname, '/api/kins/media');
  failure = { path: '/api/kins/media', response: { ok: true, json: async () => ({ inserted: -1, unchanged: 2 }) } };
  assert.equal((await send({ type: 'mediaSave', accountId: 'acct', kinId: 'kin', items: [{ sourceId: 's', kind: 'selfie', variant: 'preview', mime: 'image/png', data: 'QUJD' }] }, tab)).ok, false);
  failure = null;
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
  const store = { settings: { enabled: true, imageArchiving: true, endpoint: 'http://127.0.0.1:8765', token: 'secret' } };
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
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    if (url.endsWith('/api/inventory')) return { ok: false, status: 404 };
    const record = JSON.parse(options.body);
    return { ok: true, json: async () => url.endsWith('/api/accounts') ? { account: record } : { kin: record } };
  };
  try {
    await import('../background.js?firefox');
    const send = (message, sender) => new Promise(resolve => { assert.equal(listener(message, sender, resolve), true); });
    const popup = { id: 'extension-id', url: 'moz-extension://extension-id/popup.html' };
    const tab = { id: 'extension-id', url: 'https://kindroid.ai/v2/chat/kin', frameId: 0, tab: { id: 12 } };
    assert.deepEqual(await send({ type: 'capabilities' }, popup), { imageCapture: false });
    assert.deepEqual(await send({ type: 'mediaSnapshot', urls: ['https://img.kindroid.ai/a.webp'] }, tab), { ok: false, reason: 'unsupported' });
    assert.equal((await send({ type: 'inventory', account: { accountId: 'acct' }, kins: [{ accountId: 'acct', kinId: 'kin' }] }, tab)).ok, true);
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/api/inventory', '/api/accounts', '/api/kins']);
    requests.length = 0;
    assert.equal((await send({ type: 'inventory', account: { accountId: 'acct' }, kins: [] }, tab)).ok, true);
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/api/accounts']);
    assert.equal(listener({ type: 'checkConnection' }, tab, () => {}), false);
    assert.equal(listener({ type: 'captureBatch' }, popup, () => {}), false);
    assert.equal(listener({ type: 'inventory' }, { ...tab, url: 'https://other.example/' }, () => {}), false);
    assert.equal(listener({ type: 'inventory' }, { ...tab, frameId: 2 }, () => {}), false);
    assert.equal(listener({ type: 'inventory' }, { ...tab, tab: { ...tab.tab, url: 'https://other.example/' } }, () => {}), false);
    globalThis.browser.storage.local.get = async () => { throw new Error('private storage details'); };
    assert.deepEqual(await send({ type: 'settingsChanged' }, popup), { ok: false, reason: 'Extension request failed.' });
  } finally { delete globalThis.browser; delete globalThis.chrome; }
});
