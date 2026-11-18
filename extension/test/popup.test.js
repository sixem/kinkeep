import test from 'node:test';
import assert from 'node:assert/strict';

test('connection feedback distinguishes actionable failures without exposing secrets', async () => {
  const settings = { enabled: false, endpoint: 'http://127.0.0.1:8765', token: 'private-token' };
  const elements = Object.fromEntries(['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, {
    value: '', textContent: '', checked: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeAttribute() {},
  }]));
  let result = { ok: true };
  let messages = 0;
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: { local: { get: async key => ({ [key]: key === 'settings' ? settings : undefined }), set: async () => {} }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: { addListener() {} } },
    runtime: { sendMessage: async ({ type }) => { if (type === 'checkConnection') { messages++; if (result instanceof Error) throw result; return result; } return {}; } },
  };
  try {
    await import('../popup.js?feedback-test');
    const click = () => elements.test.handlers.click();
    const feedback = () => elements.feedback.textContent;
    await click();
    assert.equal(feedback(), 'Connected.');

    elements.token.value = 'unsaved';
    await click();
    assert.equal(feedback(), 'Save settings before testing the connection.');
    assert.equal(messages, 1);
    elements.token.value = settings.token;
    elements.endpoint.value = 'not a URL';
    await click();
    assert.match(feedback(), /valid archive server URL/);
    assert.equal(messages, 1);
    elements.endpoint.value = settings.endpoint;

    for (const [reason, expected] of [
      ['Archive endpoint permission has not been granted.', /Allow access/],
      ['Archive returned HTTP 401.', /token rejected/],
      ['Archive returned HTTP 503.', /HTTP 503/],
      ['Archive health check returned an unexpected response.', /Unexpected server response/],
      ['The operation timed out.', /timed out/],
      ['NetworkError when attempting to fetch resource.', /Could not reach/],
      ['Archiving settings changed.', /Settings changed/],
      ['Unrecognized error containing private-token', /Could not reach/],
      ['Health check: Connection failed.', /^Health check: Could not reach/],
      ['Authenticated probe: Archive returned HTTP 401.', /^Authenticated probe: Access token rejected/],
      ['Authenticated probe: Unexpected server response.', /^Authenticated probe: Unexpected server response/],
    ]) {
      result = { ok: false, reason };
      await click();
      assert.match(feedback(), expected);
      assert.doesNotMatch(feedback(), /private-token/);
    }
    result = undefined;
    await click();
    assert.match(feedback(), /Extension did not respond/);
    result = new Error('private-token');
    await click();
    assert.match(feedback(), /Extension did not respond/);
    assert.doesNotMatch(feedback(), /private-token/);
  } finally {
    delete globalThis.document;
    delete globalThis.browser;
  }
});

test('permission prompt preserves submitted settings without changing active configuration until approved', async () => {
  const saved = { enabled: true, endpoint: 'http://127.0.0.1:8765', token: 'old-token' };
  const local = { settings: saved };
  const session = {};
  let finishPrompt;
  let finishWrite;
  let granted = false;
  let calls = [];
  const makeElements = () => Object.fromEntries(['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, {
    value: '', textContent: '', checked: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeAttribute() {},
  }]));
  let elements = makeElements();
  const area = object => ({
    get: async key => ({ [key]: object[key] }),
    set: async values => { Object.assign(object, structuredClone(values)); },
    remove: async key => { delete object[key]; },
  });
  const sessionArea = area(session);
  const writeDraft = sessionArea.set;
  sessionArea.set = values => { calls.push('write draft'); return new Promise(resolve => { finishWrite = async () => { await writeDraft(values); resolve(); }; }); };
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: { local: area(local), session: sessionArea, onChanged: { addListener() {} } },
    permissions: {
      contains: async () => granted,
      request: () => { calls.push('request permission'); return new Promise(resolve => { finishPrompt = resolve; }); },
    },
    runtime: { sendMessage: async () => ({ ok: true }) },
  };
  try {
    await import('../popup.js?permission-before');
    elements.endpoint.value = 'http://localhost:9999';
    elements.token.value = 'new-token';
    const pending = elements['settings-form'].handlers.submit({ preventDefault() {} });
    assert.deepEqual(calls, ['write draft', 'request permission']);
    assert.deepEqual(local.settings, saved);
    assert.equal(session.pendingArchiveSettings, undefined);
    // The write may finish after the originating popup is closed.
    await finishWrite();
    assert.deepEqual(session.pendingArchiveSettings, { endpoint: 'http://localhost:9999', token: 'new-token' });

    // The permission prompt can close the popup, so its pending handler may
    // never resume. Reopening after approval must finish saving the draft.
    granted = true;
    elements = makeElements();
    await import('../popup.js?permission-after');
    assert.deepEqual(local.settings, { enabled: true, imageArchiving: false, endpoint: 'http://localhost:9999', token: 'new-token' });
    assert.equal(session.pendingArchiveSettings, undefined);
    assert.equal(elements.token.value, 'new-token');
    assert.equal(elements.feedback.textContent, 'Settings saved.');
    finishPrompt(true);
    await pending;
  } finally {
    delete globalThis.document;
    delete globalThis.browser;
  }
});

test('denying permission preserves the draft and keeps the active settings', async () => {
  const saved = { enabled: false, endpoint: 'http://127.0.0.1:8765', token: 'old-token' };
  const local = { settings: saved };
  const session = {};
  let finishPrompt;
  const area = object => ({ get: async key => ({ [key]: object[key] }), set: async values => Object.assign(object, structuredClone(values)), remove: async key => { delete object[key]; } });
  const makeElements = () => Object.fromEntries(['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, { value: '', textContent: '', checked: false, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; }, removeAttribute() {} }]));
  let elements = makeElements();
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: { local: area(local), session: area(session), onChanged: { addListener() {} } },
    permissions: { contains: async () => false, request: () => new Promise(resolve => { finishPrompt = resolve; }) },
    runtime: { sendMessage: async () => ({ ok: true }) },
  };
  try {
    await import('../popup.js?permission-denied-before');
    elements.endpoint.value = 'http://localhost:9999';
    elements.token.value = 'new-token';
    const pending = elements['settings-form'].handlers.submit({ preventDefault() {} });
    assert.deepEqual(local.settings, saved);
    elements = makeElements();
    await import('../popup.js?permission-denied-after');
    assert.deepEqual(local.settings, saved);
    assert.equal(elements.endpoint.value, 'http://localhost:9999');
    assert.equal(elements.token.value, 'new-token');
    assert.match(elements.feedback.textContent, /Allow access/);
    finishPrompt(false);
    await pending;
  } finally {
    delete globalThis.document;
    delete globalThis.browser;
  }
});

test('settings still save if temporary draft storage fails and permission is granted', async () => {
  const local = { settings: { enabled: false, endpoint: 'http://127.0.0.1:8765', token: 'old-token' } };
  const elements = Object.fromEntries(['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, { value: '', textContent: '', checked: false, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; }, removeAttribute() {} }]));
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: {
      local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, structuredClone(value)) },
      session: { get: async () => ({}), set: async () => { throw new Error('Session storage unavailable'); }, remove: async () => {} },
      onChanged: { addListener() {} },
    },
    permissions: { request: async () => true },
    runtime: { sendMessage: async () => ({ ok: true }) },
  };
  try {
    await import('../popup.js?session-write-failure');
    elements.endpoint.value = 'http://localhost:9999';
    elements.token.value = 'new-token';
    await elements['settings-form'].handlers.submit({ preventDefault() {} });
    assert.deepEqual(local.settings, { enabled: false, imageArchiving: false, endpoint: 'http://localhost:9999', token: 'new-token' });
    assert.equal(elements.feedback.textContent, 'Settings saved.');
  } finally {
    delete globalThis.document;
    delete globalThis.browser;
  }
});

test('failed recovery keeps the active configuration and reports the draft as unsaved', async () => {
  const saved = { enabled: true, endpoint: 'http://127.0.0.1:8765', token: 'old-token' };
  const draft = { endpoint: 'http://localhost:9999', token: 'new-token' };
  const elements = Object.fromEntries(['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, { value: '', textContent: '', checked: false, handlers: {}, addEventListener(type, handler) { this.handlers[type] = handler; }, removeAttribute() {} }]));
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: {
      local: { get: async key => ({ [key]: key === 'settings' ? saved : undefined }), set: async () => { throw new Error('Storage unavailable'); } },
      session: { get: async () => ({ pendingArchiveSettings: draft }), remove: async () => {} },
      onChanged: { addListener() {} },
    },
    permissions: { contains: async () => true },
    runtime: { sendMessage: async () => ({ ok: true }) },
  };
  try {
    await import('../popup.js?failed-recovery');
    assert.equal(elements.token.value, 'new-token');
    assert.match(elements.feedback.textContent, /Could not finish saving/);
    await elements.test.handlers.click();
    assert.match(elements.feedback.textContent, /Save settings before testing/);
  } finally {
    delete globalThis.document;
    delete globalThis.browser;
  }
});

test('image archiving defaults off, persists independently, and is unavailable in Firefox', async () => {
  const ids = ['settings-form', 'enabled', 'image-archiving', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'];
  const makeElements = () => Object.fromEntries(ids.map(id => [id, {
    value: '', textContent: '', checked: false, disabled: id === 'image-archiving', handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; }, removeAttribute() {},
  }]));
  const local = { settings: { enabled: true, endpoint: 'http://127.0.0.1:8765', token: 'secret' } };
  let elements = makeElements();
  let supported = true;
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: {
      local: { get: async key => ({ [key]: structuredClone(local[key]) }), set: async value => { await new Promise(resolve => setTimeout(resolve, 1)); Object.assign(local, structuredClone(value)); } },
      session: { get: async () => ({}) }, onChanged: { addListener() {} },
    },
    runtime: { sendMessage: async ({ type }) => type === 'capabilities' ? { imageCapture: supported } : { ok: true } },
  };
  try {
    await import('../popup.js?image-toggle');
    assert.equal(elements['image-archiving'].checked, false);
    assert.match(elements['media-status'].textContent, /stylesheet/);
    assert.equal(elements['image-archiving'].disabled, false);
    elements['image-archiving'].checked = false;
    const imageSave = elements['image-archiving'].handlers.change();
    elements.enabled.checked = false;
    const pauseSave = elements.enabled.handlers.change();
    await Promise.all([imageSave, pauseSave]);
    assert.equal(local.settings.imageArchiving, false);
    assert.equal(local.settings.enabled, false);
    assert.equal(local.settings.token, 'secret');
    elements['image-archiving'].checked = true;
    await elements['image-archiving'].handlers.change();
    assert.equal(local.settings.imageArchiving, true);
    assert.equal(local.settings.enabled, false);

    supported = false;
    elements = makeElements();
    await import('../popup.js?image-toggle-firefox');
    assert.equal(elements['image-archiving'].disabled, true);
    assert.equal(elements['image-archiving'].checked, false);
    assert.match(elements['media-status'].textContent, /unavailable/);
    assert.equal(local.settings.imageArchiving, true);
  } finally { delete globalThis.document; delete globalThis.browser; }
});
