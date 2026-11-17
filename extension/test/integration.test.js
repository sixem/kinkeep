import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../../server/server.js';
import '../profiles.js';
import '../extract.js';
import '../dom-extract.js';

test('extracted message is accepted by the real scoped archive and deduplicated', async () => {
  const uid = 'test-account';
  const cache = { ownerUid: uid, client: { clientState: { queries: [
    { queryKey: ['v2', 'user', uid], state: { data: { aiList: ['test-kin'] } } },
    { queryKey: ['v2', 'kins', uid, 'test-kin'], state: { data: { uid, ai_id: 'test-kin', ai_name: 'Test Kin' } } },
    { queryKey: ['v2', 'chat-messages', uid, 'test-kin'], state: { data: [{ id: 'message-id', text: 'Hello', isSelf: false, senderAiId: 'test-kin', timestamp: 1730000000000, reactions: { 'kin:test-kin': '❤️' }, reactionsRevision: 1, persona: '', chatHistoryRecordId: 'history-id' }] } },
  ] } } };
  const result = await globalThis.KinexportExtract.extract(uid, [cache]);
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    archive.upsertAccount(result.account);
    for (const kin of result.kins) archive.upsertKin(kin);
    const scope = { accountId: uid, kinId: 'test-kin' };
    const messages = result.groups[0].messages;
    const probe = messages.map(({ conversationId, messageId, fingerprint }) => ({ conversationId, messageId, fingerprint }));
    assert.equal(archive.scopedProbe(scope, probe).results[0].status, 'missing');
    assert.deepEqual(archive.scopedIngest(scope, messages), { inserted: 1, updated: 0, unchanged: 0 });
    assert.equal(archive.scopedProbe(scope, probe).results[0].status, 'unchanged');
    assert.equal(archive.scopedArchiveMessages(scope)[0].data.chatHistoryRecordId, 'history-id');
    assert.equal(archive.scopedArchiveMessages(scope)[0].data.reactions['kin:test-kin'], '❤️');
  } finally { archive.db.close(); }
});

test('two browsers skip an optimistic message and preserve genuinely repeated sends', async () => {
  const uid = 'test-account', kinId = 'test-kin';
  const temporary = 'local-01234567-89ab-cdef-0123-456789abcdef';
  const article = { parentElement: { id: `v2-msg-${temporary}`, dataset: { chatTimestamp: '1730000000000' } },
    classList: ['test_align-self'], querySelectorAll: () => [{ nodeType: 3, nodeValue: 'Repeated text' }] };
  const document = { querySelector: () => ({ querySelectorAll: () => [article] }) };
  const view = { state: 'ready', kins: [{ kinId }], groups: [] };
  assert.deepEqual(await globalThis.KinexportDom.extractVisible(document, `/v2/chat/${kinId}`, view), []);
  const cache = { ownerUid: uid, client: { clientState: { queries: [
    { queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } },
    { queryKey: ['v2', 'chat-messages', uid, kinId], state: { data: [
      { id: 'stable-one', text: 'Repeated text', isSelf: true, timestamp: 1730000005000 },
      { id: 'stable-two', text: 'Repeated text', isSelf: true, timestamp: 1730000010000 },
    ] } },
  ] } } };
  const result = await globalThis.KinexportExtract.extract(uid, [cache]);
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    archive.upsertAccount(result.account);
    for (const kin of result.kins) archive.upsertKin(kin);
    const scope = { accountId: uid, kinId };
    const messages = result.groups[0].messages;
    assert.deepEqual(archive.scopedIngest(scope, messages), { inserted: 2, updated: 0, unchanged: 0 });
    assert.deepEqual(archive.scopedIngest(scope, messages), { inserted: 0, updated: 0, unchanged: 2 });
    assert.equal(archive.scopedArchiveMessages(scope).length, 2);
  } finally { archive.db.close(); }
});

test('rendered DOM never downgrades cache; upgrade retains rendered observation with provenance', async () => {
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin({ accountId: 'a', kinId: 'k' });
    const scope = { accountId: 'a', kinId: 'k' };
    const dom = { conversationId: 'observed-main', messageId: 'id', fingerprint: 'dom', content: 'rendered', data: { captureSource: 'dom' } };
    const raw = { ...dom, fingerprint: 'cache', content: '*raw*', data: { captureSource: 'cache' } };
    archive.scopedIngest(scope, [dom]);
    const probe = message => ({ conversationId: message.conversationId, messageId: message.messageId, fingerprint: message.fingerprint, captureSource: message.data.captureSource });
    assert.equal(archive.scopedProbe(scope, [probe(raw)]).results[0].status, 'changed');
    archive.scopedIngest(scope, [raw]);
    let [stored] = archive.scopedArchiveMessages(scope);
    assert.equal(stored.content, '*raw*'); assert.equal(stored.revisions.length, 1); assert.equal(stored.revisions[0].data.captureSource, 'dom');
    assert.equal(archive.scopedProbe(scope, [probe(dom)]).results[0].status, 'unchanged');
    archive.scopedIngest(scope, [dom]);
    [stored] = archive.scopedArchiveMessages(scope); assert.equal(stored.content, '*raw*');
  } finally { archive.db.close(); }
});

test('a previously stored DOM observation updates when formatting reconstruction improves', () => {
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin({ accountId: 'a', kinId: 'k' });
    const scope = { accountId: 'a', kinId: 'k' };
    const previous = { conversationId: 'observed-main', messageId: 'id', fingerprint: 'old', content: 'smiles', data: { captureSource: 'dom' } };
    const fixed = { ...previous, fingerprint: 'new', content: '*smiles*' };
    archive.scopedIngest(scope, [previous]);
    assert.equal(archive.scopedProbe(scope, [{ conversationId: fixed.conversationId, messageId: fixed.messageId, fingerprint: fixed.fingerprint, captureSource: 'dom' }]).results[0].status, 'changed');
    assert.deepEqual(archive.scopedIngest(scope, [fixed]), { inserted: 0, updated: 1, unchanged: 0 });
    const [stored] = archive.scopedArchiveMessages(scope);
    assert.equal(stored.content, '*smiles*');
    assert.equal(stored.revisions[0].content, 'smiles');
    assert.equal(stored.revisions[0].data.captureSource, 'dom');
  } finally { archive.db.close(); }
});

test('observed profile fields integrate with SQLite without stale or missing-field overwrites', async () => {
  const uid = 'profile-account';
  const kinId = 'profile-kin';
  const observedMs = 1730000000000;
  const snapshot = { ownerUid: uid, client: { clientState: { queries: [
    { queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } },
    { queryKey: ['v2', 'kins', uid, kinId], state: { dataUpdatedAt: observedMs, data: { uid, ai_id: kinId, ai_name: 'A', ai_backstory: 'story', ai_memory: '', time_awareness: false, selected_voice: 0, user_set_temperature: null, proactive_engine: 'v1', voice_call_unified_context: true, background_settings: { background_url: 'https://example.invalid/private' } } } },
  ] } } };
  const extracted = await globalThis.KinexportExtract.extract(uid, [snapshot]);
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    archive.upsertAccount(extracted.account); archive.upsertKin(extracted.kins[0]);
    archive.upsertProfile(extracted.profiles[0]);
    let profile = archive.readProfile({ accountId: uid, kinId });
    assert.equal(profile.fields.ai_backstory.value, 'story'); assert.equal(profile.fields.ai_memory.value, '');
    assert.equal(profile.fields.time_awareness.value, false); assert.equal(profile.fields.selected_voice.value, 0);
    assert.equal(profile.fields.user_set_temperature.value, null); assert.equal(profile.fields.proactive_engine.value, 'v1');
    assert.equal(profile.fields.voice_call_unified_context.value, true); assert.equal(profile.fields.background_settings, undefined);
    archive.upsertProfile({ accountId: uid, kinId, fields: { ai_backstory: { value: 'old', observedAt: '2020-01-01T00:00:00.000Z' } } });
    profile = archive.readProfile({ accountId: uid, kinId });
    assert.equal(profile.fields.ai_backstory.value, 'story'); assert.equal(profile.fields.ai_memory.value, '');
  } finally { archive.db.close(); }
});

test('plaintext editor observations do not replace cached encrypted profile fields', () => {
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    const scope = { accountId: 'a', kinId: 'k' };
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    archive.upsertProfile({ ...scope, fields: { ai_backstory: { value: 'encrypted-placeholder', observedAt: '2024-01-01T00:00:00.000Z' } } });
    archive.upsertProfile({ ...scope, fields: { ai_backstory_plaintext: { value: 'observed draft', observedAt: '2024-01-02T00:00:00.000Z' } } });
    const { fields } = archive.readProfile(scope);
    assert.equal(fields.ai_backstory.value, 'encrypted-placeholder');
    assert.equal(fields.ai_backstory_plaintext.value, 'observed draft');
  } finally { archive.db.close(); }
});

test('owner-verified cached journals round-trip through the scoped archive without duplicates', async () => {
  const uid = 'journal-account', kinId = 'journal-kin';
  const snapshot = { ownerUid: uid, client: { clientState: { queries: [
    { queryKey: ['v2', 'user', uid], state: { data: { aiList: [kinId] } } },
    { queryKey: ['v2', 'journal-entries', 'kin', uid, kinId], state: { data: { pages: [{ entries: [
      { id: 'journal-id', created: 1730000000000, description: 'A remembered day', keywords: ['day'], origin: 'ai' },
    ] }] } } },
  ] } } };
  const extracted = await globalThis.KinexportExtract.extract(uid, [snapshot]);
  const archive = createArchive({ databasePath: ':memory:', token: 'test-token' });
  const scope = { accountId: uid, kinId };
  try {
    archive.upsertAccount(extracted.account); archive.upsertKin(scope);
    const batch = { ...scope, entries: extracted.journals[0].entries };
    assert.equal(archive.upsertJournal(batch).inserted, 1);
    assert.equal(archive.upsertJournal(batch).unchanged, 1);
    const page = archive.journalPage(scope);
    assert.equal(page.total, 1);
    assert.equal(page.entries[0].description, 'A remembered day');
    assert.equal(page.entries[0].createdAt, '2024-10-27T03:33:20.000Z');
    assert.deepEqual(page.entries[0].keywords, ['day']);
  } finally { archive.db.close(); }
});
