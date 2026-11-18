import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../server.js';

const create = () => createArchive({ databasePath: ':memory:', token: 'test-token' });
const sample = { conversationId: 'conversation-1', kinId: 'kin-1', kinName: 'Person1', messageId: 'message-1', fingerprint: 'hash-a', sender: 'Person1', timestamp: '2026-01-01T12:00:00Z', content: 'Hello' };

test('live capture skips optimistic IDs across all sources and older archives still restore', () => {
  const archive = create(), restored = create();
  const scope = { accountId: 'account', kinId: 'kin' };
  const temporary = { conversationId: 'observed-main', messageId: 'local-01234567-89ab-cdef-0123-456789abcdef', fingerprint: 'pending', content: 'same text', data: { captureSource: 'dom' } };
  try {
    archive.upsertAccount({ accountId: scope.accountId }); archive.upsertKin(scope);
    for (const captureSource of ['dom', 'history', 'cache']) {
      const probe = { conversationId: temporary.conversationId, messageId: temporary.messageId, fingerprint: temporary.fingerprint, captureSource };
      assert.deepEqual(archive.scopedProbe(scope, [probe]), { results: [{ status: 'unchanged' }] });
      assert.deepEqual(archive.scopedIngest(scope, [{ ...temporary, data: { captureSource } }]), { inserted: 0, updated: 0, unchanged: 1 });
    }
    assert.equal(archive.scopedArchiveMessages(scope).length, 0);
    const stable = { ...temporary, messageId: 'stable-id', fingerprint: 'stable', data: { captureSource: 'cache' } };
    assert.equal(archive.scopedIngest(scope, [stable]).inserted, 1);
    assert.equal(archive.scopedIngest(scope, [{ ...stable, messageId: 'another-id', fingerprint: 'another' }]).inserted, 1);
    // Emulate an older archive that already contains the provisional record.
    archive.db.prepare('INSERT INTO scoped_messages(account_id,kin_id,conversation_id,source_id,fingerprint,content,data,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(scope.accountId, scope.kinId, temporary.conversationId, temporary.messageId, temporary.fingerprint, temporary.content, JSON.stringify(temporary.data), '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    restored.importArchive(archive.exportArchive());
    assert.equal(restored.scopedArchiveMessages(scope).length, 3);
    assert.ok(restored.scopedArchiveMessages(scope).some(message => message.messageId === temporary.messageId));
  } finally { archive.db.close(); restored.db.close(); }
});

test('probe, ingest, deduplicate, and retain earlier versions on update', () => {
  const archive = create();
  try {
    assert.deepEqual(archive.probe([]), { results: [] });
    assert.deepEqual(archive.probe([sample]).results.map((r) => r.status), ['missing']);
    assert.deepEqual(archive.ingest([sample]), { inserted: 1, updated: 0, unchanged: 0 });
    assert.deepEqual(archive.probe([sample]).results.map((r) => r.status), ['unchanged']);
    assert.deepEqual(archive.ingest([sample]), { inserted: 0, updated: 0, unchanged: 1 });
    const edit = { ...sample, fingerprint: 'hash-b', content: 'Edited' };
    assert.equal(archive.probe([edit]).results[0].status, 'changed');
    assert.deepEqual(archive.ingest([edit]), { inserted: 0, updated: 1, unchanged: 0 });
    const [message] = archive.archiveMessages('conversation-1');
    assert.equal(message.content, 'Edited');
    assert.equal(message.revisions[0].content, 'Hello');
    assert.equal(archive.digest().messages, 1);
    assert.equal(archive.digest().revisions, 1);
    assert.equal(archive.search('dit').length, 1);
  } finally { archive.db.close(); }
});

test('portable export imports message metadata and revisions and is idempotent', () => {
  const first = create(); const second = create();
  try {
    first.ingest([{ ...sample, firstSeen: '2025-01-01T00:00:00Z', lastSeen: '2025-01-02T00:00:00Z' }]);
    first.ingest([{ ...sample, fingerprint: 'hash-b', content: 'Edited' }]);
    const snapshot = first.exportArchive();
    assert.equal(second.importArchive(snapshot).inserted, 1);
    assert.equal(second.importArchive(snapshot).unchanged, 1);
    const original = snapshot.legacy.messages[0]; const restored = second.exportArchive().legacy.messages[0];
    assert.deepEqual(restored, original);
    assert.throws(() => second.importArchive({ ...snapshot, messages: [...snapshot.messages, { content: 'bad' }] }), /Invalid/);
    assert.equal(second.digest().messages, 1);
  } finally { first.db.close(); second.db.close(); }
});

test('fallback fingerprints deduplicate only within each conversation', () => {
  const archive = create();
  try {
    const noId = { ...sample, messageId: null };
    assert.equal(archive.ingest([noId, { ...noId, conversationId: 'conversation-2' }]).inserted, 2);
    assert.equal(archive.probe([noId]).results[0].status, 'unchanged');
    assert.equal(archive.probe([{ ...noId, fingerprint: 'other' }]).results[0].status, 'missing');
  } finally { archive.db.close(); }
});

test('HTTP interface requires a token and rejects foreign hosts', async () => {
  const { createHttpServer } = await import('../server.js');
  const { Readable } = await import('node:stream');
  const archive = create();
  const server = createHttpServer({ archive, token: 'secret-token' });
  async function request(path, { token, host = '127.0.0.1:8765', method = 'GET', body, binary = false } = {}) {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = Readable.from(data ? [Buffer.from(data)] : []);
    Object.assign(req, { url: path, method, headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) } });
    return new Promise((resolve) => {
      const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(content) { resolve({ status: this.status, body: binary ? content : JSON.parse(content), headers: this.headers }); } };
      server.emit('request', req, res);
    });
  }
  try {
    assert.equal((await request('/api/health')).status, 200);
    for (const path of ['/fonts/InterVariable.woff2', '/fonts/InterVariable-Italic.woff2']) {
      const font = await request(path, { binary: true });
      assert.equal(font.status, 200);
      assert.equal(font.headers['Content-Type'], 'font/woff2');
      assert.equal(font.body.subarray(0, 4).toString('ascii'), 'wOF2');
    }
    for (const name of ['messages', 'personality', 'journal', 'images', 'settings', 'download', 'upload', 'refresh', 'search', 'lock', 'arrow-up']) {
      const icon = await request(`/icons/${name}.svg`, { binary: true });
      assert.equal(icon.status, 200);
      assert.equal(icon.headers['Content-Type'], 'image/svg+xml');
      assert.match(icon.body.toString('utf8'), /<svg\b/);
    }
    assert.equal((await request('/api/digest')).status, 401);
    assert.equal((await request('/api/digest', { token: 'wrong' })).status, 401);
    assert.equal((await request('/api/digest', { token: 'secret-token' })).status, 200);
    assert.equal((await request('/api/digest', { token: 'secret-token', host: 'attacker.example' })).status, 403);
    const probe = await request('/api/probe', { method: 'POST', token: 'secret-token', body: { messages: [] } });
    assert.equal(probe.status, 200);
    assert.deepEqual(probe.body, { results: [] });
    assert.equal(probe.headers['Access-Control-Allow-Origin'], undefined);
    const inventory = { account: { accountId: 'batch', displayName: 'Original' }, kins: [{ accountId: 'batch', kinId: 'first' }] };
    const postInventory = body => request('/api/inventory', { method: 'POST', token: 'secret-token', body });
    assert.equal((await request('/api/inventory', { method: 'POST', body: inventory })).status, 401);
    assert.deepEqual((await postInventory(inventory)).body, { accountId: 'batch', kinCount: 1 });
    assert.deepEqual((await postInventory(inventory)).body, { accountId: 'batch', kinCount: 1 });
    assert.equal((await postInventory({ account: { accountId: 'batch', displayName: 'Changed' }, kins: [
      { accountId: 'batch', kinId: 'second' }, { accountId: 'other', kinId: 'third' },
    ] })).status, 400);
    assert.equal(archive.accounts().find(row => row.accountId === 'batch').displayName, 'Original');
    assert.deepEqual(archive.kins('batch').map(row => row.kinId), ['first']);
    assert.equal((await request('/api/accounts', { method: 'POST', token: 'secret-token', body: { accountId: 'a', displayName: 'User' } })).status, 200);
    assert.equal((await request('/api/kins', { method: 'POST', token: 'secret-token', body: { accountId: 'a', kinId: 'k', name: 'Kin' } })).status, 200);
    assert.equal((await request('/api/kins/profile', { method: 'POST', token: 'secret-token', body: { accountId: 'a', kinId: 'k', fields: { ai_backstory: { value: 'A story', observedAt: '2026-01-01T00:00:00.000Z' } } } })).status, 200);
    const profile = await request('/api/kins/profile?accountId=a&kinId=k', { token: 'secret-token' });
    assert.equal(profile.body.fields.ai_backstory.value, 'A story');
    assert.equal((await request('/api/kins/profile?accountId=a&kinId=k')).status, 401);
    const journal = { accountId: 'a', kinId: 'k', entries: [{ entryId: 'journal-1', createdAt: '2026-01-01T00:00:00.000Z', description: 'Entry', keywords: ['memory'], origin: 'manual' }] };
    assert.equal((await request('/api/kins/journal', { method: 'POST', body: journal })).status, 401);
    assert.equal((await request('/api/kins/journal', { method: 'POST', token: 'secret-token', body: journal })).body.inserted, 1);
    assert.equal((await request('/api/kins/journal?accountId=a&kinId=k', { token: 'secret-token' })).body.entries[0].description, 'Entry');
    assert.equal((await request('/api/kins/journal?accountId=a&kinId=k&limit=101', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/kins/journal?accountId=a&kinId=k&offset=-1', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/kins/journal?accountId=a', { token: 'secret-token' })).status, 400);
    const image = { sourceId:'s', kind:'selfie', variant:'preview', createdAt:'2026-01-01T00:00:00.000Z', mime:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAABQAAAAeAQMAAAAW3KwoAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURQAA/////3vcmSwAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gsQEg0c4s+h1gAAAAxJREFUCNdjYBgYAAAAeAAB2u2iVwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xNlQxODoxMzoyOCswMDowMISgOgkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTZUMTg6MTM6MjgrMDA6MDD1/YK1AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTExLTE2VDE4OjEzOjI4KzAwOjAwouijagAAAABJRU5ErkJggg==' };
    assert.equal((await request('/api/kins/media', {method:'POST',token:'secret-token',body:{accountId:'a',kinId:'k',items:[image]}})).status, 200);
    const sha=(await request('/api/kins/media?accountId=a&kinId=k', {token:'secret-token'})).body.items[0].sha256;
    assert.equal((await request(`/api/media/thumbnail?sha256=${sha}`)).status, 401);
    const thumb=await request(`/api/media/thumbnail?sha256=${sha}`, {token:'secret-token',binary:true});
    assert.equal(thumb.status, 200);assert.equal(thumb.headers['Content-Type'], 'image/webp');assert.equal(thumb.body.subarray(8,12).toString(),'WEBP');
    const message = { conversationId: 'synthetic', messageId: 'id', fingerprint: 'hash', content: 'hello', data: { chatHistoryRecordId: 'record' } };
    const sent = await request('/api/messages', { method: 'POST', token: 'secret-token', body: { accountId: 'a', kinId: 'k', messages: [message] } });
    assert.equal(sent.status, 200); assert.equal(sent.body.inserted, 1);
    const scoped = await request('/api/messages?accountId=a&kinId=k&conversationId=synthetic', { token: 'secret-token' });
    assert.equal(scoped.body.messages[0].content, 'hello');
    assert.equal(Object.hasOwn(scoped.body, 'nextCursor'), false);
    const scopedPage = await request('/api/messages?accountId=a&kinId=k&conversationId=synthetic&limit=1', { token: 'secret-token' });
    assert.equal(scopedPage.status, 200); assert.equal(scopedPage.body.nextCursor, null);
    assert.equal(scopedPage.body.total, 1);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&limit=0', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&limit=101', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&cursor=bad', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&cursor=', { token: 'secret-token' })).status, 400);
    const oldest = await request('/api/messages?accountId=a&kinId=k&conversationId=synthetic&direction=oldest', { token: 'secret-token' });
    assert.equal(oldest.status, 200); assert.equal(oldest.body.messages.length, 1);
    assert.equal(oldest.body.nextCursor, null); assert.equal(oldest.body.newerCursor, null);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&direction=newer', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&direction=oldest&cursor=bad', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a&kinId=k&direction=invalid', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages?accountId=a', { token: 'secret-token' })).status, 400);
    assert.equal((await request('/api/messages', { method: 'POST', token: 'secret-token', body: { accountId: 'a', kinId: 'k', messages: [{ ...message, accountId: 'other' }] } })).status, 400);
    assert.equal((await request('/api/messages', { method: 'POST', token: 'secret-token', body: { messages: [{ ...message, accountId: 'a' }] } })).status, 400);
  } finally { archive.db.close(); }
});

test('journal entries are scoped, paginated, enriched and preserve unordered observations', () => {
  const archive = create();
  try {
    archive.upsertAccount({ accountId: 'a' });
    archive.upsertKin({ accountId: 'a', kinId: 'k1' });
    archive.upsertKin({ accountId: 'a', kinId: 'k2' });
    const scope = { accountId: 'a', kinId: 'k1' };
    const entry = { entryId: 'same-id', createdAt: '2026-01-02T12:00:00Z', description: 'Original' };
    assert.deepEqual(archive.upsertJournal({ ...scope, entries: [entry] }), { inserted: 1, unchanged: 0, historical: 0 });
    assert.deepEqual(archive.upsertJournal({ ...scope, entries: [entry] }), { inserted: 0, unchanged: 1, historical: 0 });
    assert.equal(archive.upsertJournal({ ...scope, entries: [{ ...entry, keywords: [], origin: 'manual' }] }).unchanged, 1);
    archive.upsertJournal({ ...scope, entries: [entry] });
    let record = archive.journalPage(scope).entries[0];
    assert.deepEqual(record.keywords, []); assert.equal(record.origin, 'manual');
    const different = { ...entry, description: 'Another observation' };
    assert.equal(archive.upsertJournal({ ...scope, entries: [different] }).historical, 1);
    assert.equal(archive.upsertJournal({ ...scope, entries: [different] }).unchanged, 1);
    record = archive.journalPage(scope).entries[0];
    assert.equal(record.description, 'Original'); assert.equal(record.revisions[0].description, 'Another observation');
    assert.equal(record.revisions[0].origin, null);
    assert.equal(archive.upsertJournal({ accountId: 'a', kinId: 'k2', entries: [entry] }).inserted, 1);
    const earlier = { ...entry, entryId: 'earlier', createdAt: '2026-01-01T00:00:00Z' };
    archive.upsertJournal({ ...scope, entries: [earlier] });
    const page = archive.journalPage(scope, 1, 0);
    assert.equal(page.total, 2); assert.equal(page.entries[0].entryId, 'same-id'); assert.equal(page.nextOffset, 1);
    assert.equal(archive.journalPage(scope, 1, 1).entries[0].entryId, 'earlier');
    assert.equal(archive.journalPage(scope, 1, 1).nextOffset, null);
    assert.throws(() => archive.upsertJournal({ ...scope, entries: [earlier, { ...entry, entryId: 'bad', keywords: [123] }] }), /Invalid/);
    assert.equal(archive.journalPage(scope).total, 2);
  } finally { archive.db.close(); }
});

test('v4 journal export preserves conflicts and supports safe transactional restores', () => {
  const first = create(); const second = create(); const empty = create();
  try {
    first.upsertAccount({ accountId: 'a' }); first.upsertKin({ accountId: 'a', kinId: 'k' });
    const scope = { accountId: 'a', kinId: 'k' };
    const entry = { entryId: 'j', createdAt: '2026-01-01T00:00:00Z', description: 'First', keywords: ['word'] };
    first.upsertJournal({ ...scope, entries: [entry] });
    first.upsertJournal({ ...scope, entries: [{ ...entry, description: 'Changed' }] });
    const snapshot = first.exportArchive(4);
    assert.equal(snapshot.version, 4); assert.equal(snapshot.journalEntries.length, 1);
    assert.equal(snapshot.journalEntries[0].revisions.length, 1);
    assert.throws(() => first.exportArchive(3), /cannot represent journal entries/);
    second.importArchive(snapshot); second.importArchive(snapshot);
    assert.deepEqual(second.exportArchive(4).journalEntries, snapshot.journalEntries);
    assert.throws(() => second.importArchive({ ...snapshot, version: 3 }), /require a version 4/);
    const broken = structuredClone(snapshot); broken.journalEntries[0].kinId = 'missing';
    assert.throws(() => empty.importArchive(broken), /does not exist/);
    assert.equal(empty.accounts().length, 0);
    const v3 = { ...snapshot, version: 3 }; delete v3.journalEntries;
    empty.importArchive(v3);
    assert.equal(empty.journalPage(scope).total, 0);
  } finally { first.db.close(); second.db.close(); empty.db.close(); }
});

test('older or undated import never replaces newer current message', () => {
  const archive = create();
  try {
    archive.ingest([{ ...sample, fingerprint: 'new', content: 'Current' }]);
    const earlier = { ...sample, fingerprint: 'old', content: 'Old', firstSeen: '2025-01-01T00:00:00Z', lastSeen: '2025-01-02T00:00:00Z' };
    const snapshot = { format: 'kinexport', version: 1, messages: [earlier] };
    assert.deepEqual(archive.importArchive(snapshot), { inserted: 0, updated: 0, unchanged: 1 });
    let [message] = archive.archiveMessages('conversation-1');
    assert.equal(message.content, 'Current');
    assert.deepEqual(message.revisions.map((r) => r.content), ['Old']);
    const undated = { ...sample, fingerprint: 'undated', content: 'Undated' };
    assert.equal(archive.importArchive({ ...snapshot, messages: [undated] }).unchanged, 1);
    [message] = archive.archiveMessages('conversation-1');
    assert.equal(message.content, 'Current');
    assert.deepEqual(message.revisions.map((r) => r.content), ['Old', 'Undated']);
    const later = { ...sample, fingerprint: 'newer', content: 'Newer', lastSeen: '9999-01-01T00:00:00Z' };
    assert.equal(archive.importArchive({ ...snapshot, messages: [later] }).updated, 1);
    [message] = archive.archiveMessages('conversation-1');
    assert.equal(message.content, 'Newer');
    assert.equal(message.lastSeen, later.lastSeen);
    assert.equal(message.revisions.some((r) => r.content === 'Current'), true);
  } finally { archive.db.close(); }
});

test('migrates real v1 schema without assigning legacy messages to an account or Kin', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'kinexport-migration-')); const path = join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, kin_id TEXT, kin_name TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), source_id TEXT, fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL);
    CREATE UNIQUE INDEX messages_source_id ON messages(conversation_id, source_id) WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX messages_fallback ON messages(conversation_id, fingerprint) WHERE source_id IS NULL;
    CREATE INDEX messages_conversation ON messages(conversation_id);
    CREATE TABLE revisions (message_id INTEGER NOT NULL REFERENCES messages(id), fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(message_id, fingerprint));
    INSERT INTO conversations VALUES ('legacy-chat','old-kin','Original', '2020-01-01', '2020-01-02');
    INSERT INTO messages VALUES (42,'legacy-chat','same-id','fp','Me','2020-01-01','Legacy content','2020-01-01','2020-01-02');
    INSERT INTO revisions VALUES(42,'fp-old','Me','2020-01-01','Earlier','2020-01-02');`);
  old.close();
  const archive = createArchive({ databasePath: path, token: 'test-token' });
  try {
    assert.equal(archive.accounts().length, 0);
    assert.equal(archive.kins().length, 0);
    assert.equal(archive.archiveMessages()[0].content, 'Legacy content');
    assert.equal(archive.archiveMessages()[0].revisions[0].content, 'Earlier');
    const migratedSnapshot = archive.exportArchive();
    assert.equal(migratedSnapshot.legacy.messages.length, 1);
    const restored = create();
    try {
      restored.importArchive(migratedSnapshot);
      assert.deepEqual(restored.exportArchive().legacy.messages, migratedSnapshot.legacy.messages);
      assert.deepEqual(restored.exportArchive().legacy.conversations, migratedSnapshot.legacy.conversations);
    } finally { restored.db.close(); }
    assert.equal(archive.exportArchive(1).messages[0].messageId, 'same-id');
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin({ accountId: 'a', kinId: 'old-kin' });
    assert.equal(archive.scopedArchiveMessages({ accountId: 'a', kinId: 'old-kin' }).length, 0);
    assert.throws(() => archive.exportArchive(1), /cannot represent/);
    assert.equal(archive.archiveMessages()[0].content, 'Legacy content');
  } finally { archive.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('isolates identical source IDs by account, Kin and conversation; v2 export round-trips', () => {
  const archive = create(); const restored = create();
  const a = { accountId: 'account-1', kinId: 'kin' };
  const b = { accountId: 'account-2', kinId: 'kin' };
  const c = { accountId: 'account-1', kinId: 'other' };
  try {
    for (const accountId of ['account-1', 'account-2']) archive.upsertAccount({ accountId });
    for (const scope of [a, b, c]) archive.upsertKin({ ...scope, name: 'Person' });
    const base = { conversationId: 'observed-main', messageId: 'shared-id', fingerprint: 'hash-a', sender: 'Me', timestamp: '2026-01-01T00:00:00Z', content: 'First', data: { chatHistoryRecordId: 'record', senderAiId: 'ai', reactionsRevision: 1, reactions: ['heart'] } };
    for (const scope of [a, b, c]) assert.equal(archive.scopedIngest(scope, [base]).inserted, 1);
    assert.equal(archive.scopedIngest(a, [{ ...base, conversationId: 'another' }]).inserted, 1);
    const probe = { conversationId: base.conversationId, messageId: base.messageId, fingerprint: base.fingerprint };
    assert.equal(archive.scopedProbe(a, [probe]).results[0].status, 'unchanged');
    assert.equal(archive.scopedProbe(b, [{ ...probe, fingerprint: 'changed' }]).results[0].status, 'changed');
    assert.equal(archive.scopedIngest(a, [{ ...base, fingerprint: 'hash-b', content: 'Edited' }]).updated, 1);
    assert.equal(archive.scopedArchiveMessages(b)[0].content, 'First');
    assert.equal(archive.scopedArchiveMessages(a, 'observed-main')[0].revisions[0].content, 'First');
    archive.ingest([sample]);
    const snapshot = archive.exportArchive();
    assert.equal(snapshot.version, 5);
    assert.equal(restored.importArchive(snapshot).inserted, 5);
    assert.equal(restored.importArchive(snapshot).unchanged, 5);
    const copy = restored.exportArchive();
    assert.deepEqual(copy.accounts, snapshot.accounts); assert.deepEqual(copy.kins, snapshot.kins);
    assert.deepEqual(copy.legacy.messages, snapshot.legacy.messages);
    assert.deepEqual(copy.legacy.conversations, snapshot.legacy.conversations);
    assert.deepEqual(copy.conversations, snapshot.conversations);
    assert.deepEqual(copy.messages, snapshot.messages);
    assert.equal(restored.search('Edited')[0].accountId, 'account-1');
  } finally { archive.db.close(); restored.db.close(); }
});

test('v2 import rolls back all records on invalid references and refuses credential-like fields', () => {
  const archive = create();
  try {
    const incomplete = { format: 'kinexport', version: 2, accounts: [{ accountId: 'a' }], kins: [{ accountId: 'missing', kinId: 'k' }], legacy: { format: 'kinexport', version: 1, messages: [sample] }, messages: [] };
    assert.throws(() => archive.importArchive(incomplete), /Account does not exist/);
    assert.equal(archive.accounts().length, 0); assert.equal(archive.archiveMessages().length, 0);
    assert.throws(() => archive.upsertAccount({ accountId: 'a', token: 'secret' }), /Unexpected/);
    assert.throws(() => archive.upsertKin({ accountId: 'missing', kinId: 'k' }), /Account does not exist/);
    assert.throws(() => archive.scopedProbe({ accountId: 'a', kinId: 'k' }, []), /does not exist/);
  } finally { archive.db.close(); }
});

test('cache capture supersedes DOM rendering and later DOM cannot downgrade it', () => {
  const archive = create();
  const scope = { accountId: 'a', kinId: 'k' };
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    const dom = { conversationId: 'observed-main', messageId: 'id', fingerprint: 'dom-hash', content: 'Rendered…', data: { captureSource: 'dom' } };
    const cache = { ...dom, fingerprint: 'cache-hash', content: 'Complete source', data: { captureSource: 'cache', reactions: { 'kin:k': '❤️' } } };
    archive.scopedIngest(scope, [dom]);
    assert.equal(archive.scopedProbe(scope, [{ conversationId: dom.conversationId, messageId: dom.messageId, fingerprint: cache.fingerprint, captureSource: 'cache' }]).results[0].status, 'changed');
    assert.equal(archive.scopedIngest(scope, [cache]).updated, 1);
    let [message] = archive.scopedArchiveMessages(scope);
    assert.equal(message.content, 'Complete source'); assert.equal(message.revisions.length, 1);
    assert.equal(message.revisions[0].content, 'Rendered…'); assert.equal(message.revisions[0].data.captureSource, 'dom');
    assert.deepEqual({ ...message.data.reactions }, { 'kin:k': '❤️' });
    assert.equal(archive.scopedProbe(scope, [{ conversationId: dom.conversationId, messageId: dom.messageId, fingerprint: dom.fingerprint, captureSource: 'dom' }]).results[0].status, 'unchanged');
    assert.equal(archive.scopedIngest(scope, [dom]).unchanged, 1);
    [message] = archive.scopedArchiveMessages(scope);
    assert.equal(message.content, 'Complete source'); assert.equal(message.revisions.length, 1);
  } finally { archive.db.close(); }
});

test('source upgrades retain missing metadata and skip equivalent earlier versions', () => {
  const archive = create();
  const scope = { accountId: 'a', kinId: 'k' };
  const history = { conversationId: 'main', messageId: 'one', content: 'Same text', fingerprint: 'history', data: { captureSource: 'history', reactions: { a: 'heart', b: 'star' } } };
  const cache = { ...history, fingerprint: 'cache', data: { captureSource: 'cache', reactions: { b: 'star', a: 'heart' } } };
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    archive.scopedIngest(scope, [history, { ...history, messageId: 'two' }]);
    archive.scopedIngest(scope, [cache, { ...cache, messageId: 'two', data: { captureSource: 'cache' } }]);
    const records = archive.scopedArchiveMessages(scope);
    assert.deepEqual(records.find(m => m.messageId === 'one').revisions, []);
    const [previous] = records.find(m => m.messageId === 'two').revisions;
    assert.deepEqual(previous.data, history.data);
  } finally { archive.db.close(); }
});

test('JSON and SQLite merges preserve distinct lower-priority observations once', () => {
  const source = create();
  const scope = { accountId: 'a', kinId: 'k' };
  const history = { conversationId: 'main', messageId: 'one', content: 'Earlier text', fingerprint: 'history', data: { captureSource: 'history' } };
  const cache = { ...history, fingerprint: 'cache', content: 'Latest text', data: { captureSource: 'cache' } };
  try {
    source.upsertAccount({ accountId: 'a' }); source.upsertKin(scope);
    source.scopedIngest(scope, [history]);
    for (const merge of [target => target.importArchive(source.exportArchive()), target => target.mergeSnapshot(source.db)]) {
      const target = create();
      try {
        target.upsertAccount({ accountId: 'a' }); target.upsertKin(scope);
        target.scopedIngest(scope, [cache]);
        merge(target);
        merge(target);
        const [message] = target.scopedArchiveMessages(scope);
        assert.equal(message.fingerprint, cache.fingerprint);
        assert.equal(message.revisions.length, 1);
        assert.equal(message.revisions[0].content, history.content);
        assert.deepEqual(message.revisions[0].data, history.data);
        assert.equal(message.revisions[0].recordedAt, source.scopedArchiveMessages(scope)[0].lastSeen);
      } finally { target.db.close(); }
    }
  } finally { source.db.close(); }
});

test('original history upgrades rendered messages but does not displace cache or imported originals', () => {
  const archive = create(); const restored = create();
  const scope = { accountId: 'a', kinId: 'k' };
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    const dom = { conversationId: 'observed-main', messageId: 'id', fingerprint: 'dom', content: 'Rendered', data: { captureSource: 'dom' } };
    const history = { ...dom, fingerprint: 'history', content: '*Original*', data: { captureSource: 'history', persona: 'P', reactions: { 'kin:k': '❤️' } } };
    const cache = { ...dom, fingerprint: 'cache', content: 'Authoritative', data: { captureSource: 'cache' } };
    const probe = item => ({ conversationId: item.conversationId, messageId: item.messageId, fingerprint: item.fingerprint, captureSource: item.data.captureSource });
    assert.equal(archive.scopedIngest(scope, [dom]).inserted, 1);
    assert.equal(archive.scopedProbe(scope, [probe(history)]).results[0].status, 'changed');
    assert.equal(archive.scopedIngest(scope, [history]).updated, 1);
    assert.equal(archive.scopedProbe(scope, [probe(dom)]).results[0].status, 'unchanged');
    assert.equal(archive.scopedIngest(scope, [dom]).unchanged, 1);
    let [message] = archive.scopedArchiveMessages(scope);
    assert.equal(message.content, '*Original*'); assert.equal(message.revisions[0].content, 'Rendered');
    restored.importArchive(archive.exportArchive());
    assert.equal(restored.scopedArchiveMessages(scope)[0].data.captureSource, 'history');
    assert.equal(archive.scopedProbe(scope, [probe(cache)]).results[0].status, 'changed');
    assert.equal(archive.scopedIngest(scope, [cache]).updated, 1);
    assert.equal(archive.scopedProbe(scope, [probe(history)]).results[0].status, 'unchanged');
    assert.equal(archive.scopedIngest(scope, [history]).unchanged, 1);
    [message] = archive.scopedArchiveMessages(scope);
    assert.equal(message.content, 'Authoritative');
  } finally { archive.db.close(); restored.db.close(); }
});

test('partial profile fields preserve explicit empty/null/false/zero and history', () => {
  const archive = create(); const scope = { accountId: 'a', kinId: 'k' };
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    const fields = { ai_backstory: { value: 'First', observedAt: '2026-01-01T00:00:00.000Z' }, ai_memory: { value: '' }, ai_reactions_enabled: { value: false }, user_set_temperature: { value: 0 }, custom_avatar_face_prompt: { value: null } };
    assert.deepEqual(archive.upsertProfile({ ...scope, fields }), { inserted: 5, updated: 0, unchanged: 0, historical: 0 });
    assert.deepEqual(archive.upsertProfile({ ...scope, fields }), { inserted: 0, updated: 0, unchanged: 5, historical: 0 });
    archive.upsertProfile({ ...scope, fields: { ai_backstory: { value: 'Second', observedAt: '2026-02-01T00:00:00.000Z' } } });
    let p = archive.readProfile(scope).fields;
    assert.equal(p.ai_backstory.value, 'Second'); assert.equal(p.ai_backstory.history[0].value, 'First');
    assert.equal(p.ai_memory.value, ''); assert.equal(p.ai_reactions_enabled.value, false); assert.equal(p.user_set_temperature.value, 0); assert.equal(p.custom_avatar_face_prompt.value, null);
    assert.equal(Object.hasOwn(p, 'ai_directive'), false);
    const old = { ...scope, fields: { ai_backstory: { value: 'Earlier alternative', observedAt: '2025-12-01T00:00:00.000Z' } } };
    assert.equal(archive.upsertProfile(old).historical, 1);
    assert.equal(archive.upsertProfile(old).historical, 0);
    archive.upsertProfile({ ...scope, fields: { ai_backstory: { value: 'No timestamp' } } });
    archive.upsertProfile({ ...scope, fields: { ai_backstory: { value: 'Equal timestamp', observedAt: '2026-02-01T00:00:00.000Z' } } });
    p = archive.readProfile(scope).fields;
    assert.equal(p.ai_backstory.value, 'Second');
    assert.deepEqual(p.ai_backstory.history.map((h) => h.value), ['Earlier alternative', 'First', 'Equal timestamp', 'No timestamp']);
    assert.throws(() => archive.upsertProfile({ ...scope, fields: { session_token: { value: 'secret' } } }), /Unsupported profile field/);
    assert.throws(() => archive.upsertProfile({ ...scope, fields: { ai_backstory: { value: { accessToken: 'secret' } } } }), /Invalid value/);
    assert.throws(() => archive.upsertProfile({ ...scope, fields: { ai_name: { value: 'Name' }, selected_voice: { value: 'bad' } } }), /Invalid value/);
    assert.equal(Object.hasOwn(archive.readProfile(scope).fields, 'ai_name'), false);
  } finally { archive.db.close(); }
});

test('profile export restores history, rejects v2 downgrade, and old imports cannot overwrite newer fields', () => {
  const a = create(); const b = create(); const scope = { accountId: 'a', kinId: 'k' };
  try {
    a.upsertAccount({ accountId: 'a' }); a.upsertKin(scope);
    const legacyV2 = a.exportArchive(2);
    a.upsertProfile({ ...scope, fields: { ai_name: { value: 'First', observedAt: '2025-01-01T00:00:00.000Z' } } });
    const older = a.exportArchive();
    a.upsertProfile({ ...scope, fields: { ai_name: { value: 'Second', observedAt: '2026-01-01T00:00:00.000Z' } } });
    const snapshot = a.exportArchive();
    assert.throws(() => a.exportArchive(2), /cannot represent Kin profiles/);
    b.importArchive(legacyV2); b.importArchive(snapshot);
    assert.deepEqual(b.readProfile(scope), a.readProfile(scope));
    assert.equal(b.importArchive(older).unchanged, 0);
    assert.equal(b.readProfile(scope).fields.ai_name.value, 'Second');
    assert.deepEqual(b.readProfile(scope), a.readProfile(scope));
    assert.equal(b.importArchive(snapshot).unchanged, 0);
    assert.deepEqual(b.readProfile(scope), a.readProfile(scope));
  } finally { a.db.close(); b.db.close(); }
});

test('existing v2 SQLite archive migrates additively without losing scoped or legacy data', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'kinexport-v2-')); const path = join(dir, 'v2.sqlite');
  const before = createArchive({ databasePath: path, token: 'test-token' }); const scope = { accountId: 'a', kinId: 'k' };
  before.upsertAccount({ accountId: 'a' }); before.upsertKin(scope);
  before.ingest([sample]); before.scopedIngest(scope, [{ conversationId: 'chat', messageId: 'id', fingerprint: 'fingerprint', content: 'content' }]);
  const v2 = before.exportArchive(2);
  // Strip only the newly introduced profile tables, leaving the actual pre-profile v2 schema and data.
  before.db.exec('DROP TABLE kin_profile_history; DROP TABLE kin_profile_fields'); before.db.close();
  const migrated = createArchive({ databasePath: path, token: 'test-token' });
  try {
    const now = migrated.exportArchive(2);
    assert.deepEqual(now.accounts, v2.accounts); assert.deepEqual(now.kins, v2.kins); assert.deepEqual(now.messages, v2.messages);
    assert.deepEqual(now.legacy.messages, v2.legacy.messages); assert.deepEqual(now.conversations, v2.conversations);
    assert.deepEqual(migrated.readProfile(scope).fields, {});
  } finally { migrated.db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('scoped and legacy message pages use stable newest-first keysets with invalid timestamp fallback', () => {
  const archive = create(); const scope = { accountId: 'a', kinId: 'k' };
  try {
    archive.upsertAccount({ accountId: 'a' }); archive.upsertKin(scope);
    const entries = [
      { messageId: 'same-a', timestamp: '2026-01-02T00:00:00.000Z', firstSeen: '2025-01-01T00:00:00.000Z' },
      { messageId: 'unknown', timestamp: 'not-a-date', firstSeen: 'invalid' },
      { messageId: 'same-b', timestamp: '2026-01-02T00:00:00.000Z', firstSeen: '2025-01-01T00:00:00.000Z' },
      { messageId: 'fallback', timestamp: 'now', firstSeen: '2026-01-01T00:00:00.000Z' },
      { messageId: 'newest', timestamp: '2026-01-03T00:00:00.000Z', firstSeen: '2025-01-01T00:00:00.000Z' },
    ].map((m) => ({ ...m, conversationId: 'chat', fingerprint: `fp-${m.messageId}`, sender: 'Me', content: m.messageId }));
    archive.scopedIngest(scope, entries);
    archive.ingest(entries.map((m) => ({ ...sample, ...m })));
    archive.scopedIngest(scope, [{ conversationId: 'other-chat', messageId: 'other', fingerprint: 'other', content: 'other' }]);
    archive.ingest([{ ...sample, conversationId: 'other-chat', messageId: 'other', fingerprint: 'other', content: 'other' }]);
    archive.upsertAccount({ accountId: 'other-account' }); archive.upsertKin({ accountId: 'other-account', kinId: 'k' });
    archive.scopedIngest({ accountId: 'other-account', kinId: 'k' }, [{ conversationId: 'chat', messageId: 'other', fingerprint: 'other', content: 'other' }]);
    archive.scopedIngest(scope, [{ ...entries[0], fingerprint: 'edited', content: 'edited' }]);
    archive.ingest([{ ...sample, ...entries[0], fingerprint: 'edited', content: 'edited' }]);
    for (const target of [scope, null]) {
      let cursor = null; const all = [];
      do {
        const page = archive.archiveMessagePage(target, 'chat', { limit: 2, cursor });
        assert.ok(page.messages.length <= 2); assert.equal(page.total, 5); all.push(...page.messages); cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(all.map((m) => m.messageId), ['newest', 'same-b', 'same-a', 'fallback', 'unknown']);
      assert.equal(new Set(all.map((m) => m.messageId)).size, 5);
      assert.equal(all.find((m) => m.messageId === 'same-a').revisions[0].content, 'same-a');
      const first = archive.archiveMessagePage(target, 'chat', { limit: 2, cursor: null });
      assert.equal(first.newerCursor, null);
      const oldest = archive.archiveMessagePage(target, 'chat', { limit: 2, direction: 'oldest' });
      assert.deepEqual(oldest.messages.map(m => m.messageId), ['unknown']);
      assert.equal(oldest.nextCursor, null); assert.ok(oldest.newerCursor);
      const middle = archive.archiveMessagePage(target, 'chat', { limit: 2, direction: 'newer', cursor: oldest.newerCursor });
      assert.deepEqual(middle.messages.map(m => m.messageId), ['same-a', 'fallback']);
      assert.ok(middle.nextCursor); assert.ok(middle.newerCursor);
      const latest = archive.archiveMessagePage(target, 'chat', { limit: 2, direction: 'newer', cursor: middle.newerCursor });
      assert.deepEqual(latest.messages.map(m => m.messageId), ['newest', 'same-b']);
      assert.equal(latest.newerCursor, null); assert.ok(latest.nextCursor);
      const back = archive.archiveMessagePage(target, 'chat', { limit: 2, cursor: latest.nextCursor });
      assert.deepEqual(back.messages.map(m => m.messageId), middle.messages.map(m => m.messageId));
      assert.throws(() => archive.archiveMessagePage(target, 'different-chat', { limit: 2, direction: 'newer', cursor: oldest.newerCursor }), /Invalid message cursor/);
      assert.throws(() => archive.archiveMessagePage(target, 'chat', { limit: 2, cursor: oldest.newerCursor }), /Invalid message cursor/);
      assert.throws(() => archive.archiveMessagePage(target, 'chat', { limit: 2, direction: 'newer', cursor: first.nextCursor }), /Invalid message cursor/);
      assert.throws(() => archive.archiveMessagePage(target, 'different-chat', { limit: 2, cursor: first.nextCursor }), /Invalid message cursor/);
      assert.throws(() => archive.archiveMessagePage(target, 'chat', { limit: 2, cursor: '%%%bad' }), /Invalid message cursor/);
    }
    const empty = archive.archiveMessagePage(scope, 'does-not-exist', { limit: 2, direction: 'oldest' });
    assert.deepEqual(empty.messages, []); assert.equal(empty.total, 0); assert.equal(empty.nextCursor, null); assert.equal(empty.newerCursor, null);
    assert.equal(archive.archiveMessages('chat').length, 5);
    assert.equal(archive.scopedArchiveMessages(scope, 'chat').length, 5);
    const scopedCursor = archive.archiveMessagePage(scope, 'chat', { limit: 2, cursor: null }).nextCursor;
    assert.throws(() => archive.archiveMessagePage(null, 'chat', { limit: 2, cursor: scopedCursor }), /Invalid message cursor/);
    archive.scopedIngest(scope, [{ conversationId: 'chat', messageId: 'concurrent', fingerprint: 'new', content: 'new', timestamp: '2027-01-01T00:00:00.000Z' }]);
    const evenOldest = archive.archiveMessagePage(scope, 'chat', { limit: 2, direction: 'oldest' });
    assert.equal(evenOldest.total, 6); assert.deepEqual(evenOldest.messages.map(m => m.messageId), ['fallback', 'unknown']);
    const singlePage = archive.archiveMessagePage(scope, 'chat', { limit: 10, direction: 'oldest' });
    assert.equal(singlePage.messages.length, 6); assert.equal(singlePage.nextCursor, null); assert.equal(singlePage.newerCursor, null);
    assert.throws(() => archive.archiveMessagePage({ accountId: 'other-account', kinId: 'k' }, 'chat', { limit: 2, direction: 'newer', cursor: evenOldest.newerCursor }), /Invalid message cursor/);
    const rest = []; let cursor = scopedCursor;
    while (cursor) { const page = archive.archiveMessagePage(scope, 'chat', { limit: 2, cursor }); assert.equal(page.total, 6); rest.push(...page.messages.map((m) => m.messageId)); cursor = page.nextCursor; }
    assert.deepEqual(rest, ['same-a', 'fallback', 'unknown']);
  } finally { archive.db.close(); }
});

test('editor plaintext fields remain separate from original fields and round-trip with history', () => {
  const a = create(); const b = create(); const scope = { accountId: 'a', kinId: 'k' };
  try {
    a.upsertAccount({ accountId: 'a' }); a.upsertKin(scope);
    const originals = ['ai_backstory', 'ai_memory', 'ai_directive', 'ai_example_message', 'current_scene'];
    const raw = Object.fromEntries(originals.map((field) => [field, { value: `encrypted:${field}`, observedAt: '2026-01-01T00:00:00.000Z' }]));
    const plaintext = Object.fromEntries(originals.map((field) => [`${field}_plaintext`, { value: `visible:${field}`, observedAt: '2026-01-02T00:00:00.000Z' }]));
    a.upsertProfile({ ...scope, fields: raw }); a.upsertProfile({ ...scope, fields: plaintext });
    a.upsertProfile({ ...scope, fields: { ai_backstory_plaintext: { value: 'edited text', observedAt: '2026-01-03T00:00:00.000Z' } } });
    const source = a.readProfile(scope);
    for (const field of originals) assert.equal(source.fields[field].value, `encrypted:${field}`);
    assert.equal(source.fields.ai_backstory.history.length, 0);
    assert.equal(source.fields.ai_backstory_plaintext.history[0].value, 'visible:ai_backstory');
    for (const field of originals.slice(1)) assert.equal(source.fields[`${field}_plaintext`].value, `visible:${field}`);
    const snapshot = a.exportArchive();
    assert.equal(snapshot.version, 5);
    b.importArchive(snapshot);
    assert.deepEqual(b.readProfile(scope), source);
  } finally { a.db.close(); b.db.close(); }
});
