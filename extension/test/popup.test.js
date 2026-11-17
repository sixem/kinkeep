import test from 'node:test';
import assert from 'node:assert/strict';

test('connection feedback distinguishes actionable failures without exposing secrets', async () => {
  const settings = { enabled: false, endpoint: 'http://127.0.0.1:8765', token: 'private-token' };
  const elements = Object.fromEntries(['settings-form', 'enabled', 'endpoint', 'token', 'test', 'open', 'feedback', 'status', 'indicator', 'capture-status', 'media-status'].map(id => [id, {
    value: '', textContent: '', checked: false, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    removeAttribute() {},
  }]));
  let result = { ok: true };
  let messages = 0;
  globalThis.document = { querySelector: selector => elements[selector.slice(1)] };
  globalThis.browser = {
    storage: { local: { get: async key => ({ [key]: key === 'settings' ? settings : undefined }), set: async () => {} }, onChanged: { addListener() {} } },
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
