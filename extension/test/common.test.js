import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, permissionFor, selectMissing, isCaptureMessage } from '../common.js';

test('normalizes archive endpoints and requests only the configured host', () => {
  assert.equal(normalizeEndpoint(' http://127.0.0.1:8765/base/ '), 'http://127.0.0.1:8765/base');
  assert.equal(permissionFor('http://127.0.0.1:8765'), 'http://127.0.0.1/*');
  for (const url of ['file:///etc/passwd', 'https://user:secret@example.com', 'http://localhost/?query=1', 'https://localhost/#hash']) {
    assert.throws(() => normalizeEndpoint(url));
  }
});

test('probe forwards missing and changed messages in order', () => {
  const messages = [{ id: 1 }, { id: 2 }, { id: 3 }];
  assert.deepEqual(selectMissing(messages, { results: [{ status: 'unchanged' }, { status: 'changed' }, { status: 'missing' }] }), messages.slice(1));
  assert.throws(() => selectMissing(messages, { results: [] }));
  assert.throws(() => selectMissing(messages, { results: [{}, {}, {}] }));
});

test('capture validates required fields without inventing message ids', () => {
  assert.equal(isCaptureMessage({ conversationId: 'kin', fingerprint: 'hash', content: 'hello' }), true);
  assert.equal(isCaptureMessage({ conversationId: '', fingerprint: 'hash', content: 'hello' }), false);
  assert.equal(isCaptureMessage({ conversationId: 'kin', fingerprint: 'hash' }), false);
});
