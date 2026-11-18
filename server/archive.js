import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createMediaStore } from './media-store.js';
import {
  MAX_BATCH, MAX_BODY, accountInput, conversationInput, error, journalValue, kinInput,
  messageData, object, onlyKeys, optionalString, profileFieldsInput, requiredString,
  scopeFrom, scopedBatch, scopedMessage, validateMessage,
} from './validation.js';

const isProvisionalCapture = message => (message.captureSource ?? message.data?.captureSource) != null &&
  typeof message.messageId === 'string' && /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.messageId);
// Older messages without a source have the same precedence as cache data.
const sourceRank = source => source === 'dom' ? 0 : source === 'history' ? 1 : 2;
function upgradeRetainsObservation(old, oldData, incoming, data) {
  if (old.content !== incoming.content || (old.sender != null && old.sender !== incoming.sender) ||
      (old.timestamp != null && old.timestamp !== incoming.timestamp)) return false;
  const nextData = JSON.parse(data);
  return Object.entries(oldData ?? {}).every(([key, value]) => key === 'captureSource' || isDeepStrictEqual(value, nextData[key]));
}
// Ignore malformed/non-date expressions (notably SQLite's dynamic "now").
const messageOrderTime = (alias = '') => `COALESCE(CASE WHEN substr(${alias}timestamp,5,1)='-' AND substr(${alias}timestamp,8,1)='-' THEN julianday(${alias}timestamp) END, CASE WHEN substr(${alias}first_seen,5,1)='-' AND substr(${alias}first_seen,8,1)='-' THEN julianday(${alias}first_seen) END, 0)`;

function journalFingerprint(entry) {
  return createHash('sha256').update(JSON.stringify([entry.createdAt, entry.description, entry.keywords, entry.origin])).digest('hex');
}

function decodeMessageCursor(encoded, expected, direction = 'older') {
  if (typeof encoded !== 'string' || !encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw error(400, 'Invalid message cursor');
  let data;
  try { data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw error(400, 'Invalid message cursor'); }
  const validMode = direction === 'older' ? data?.v === 1 : data?.v === 2 && data?.direction === 'newer';
  if (!data || typeof data !== 'object' || Array.isArray(data) || !validMode || data.kind !== expected.kind ||
      data.accountId !== expected.accountId || data.kinId !== expected.kinId || data.conversationId !== expected.conversationId ||
      !Number.isFinite(data.orderTime) || !Number.isSafeInteger(data.id) || data.id < 1) throw error(400, 'Invalid message cursor');
  return data;
}

export function createArchive({ databasePath, token }) {
  requiredString(token, 'server token', 4096);
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, kin_id TEXT, kin_name TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      source_id TEXT, fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_source_id ON messages(conversation_id, source_id) WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS messages_fallback ON messages(conversation_id, fingerprint) WHERE source_id IS NULL;
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS messages_page ON messages(conversation_id, ${messageOrderTime()} DESC, id DESC);
    CREATE TABLE IF NOT EXISTS revisions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL,
      recorded_at TEXT NOT NULL, UNIQUE(message_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY, display_name TEXT, source_timestamp TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kins (
      account_id TEXT NOT NULL REFERENCES accounts(account_id), kin_id TEXT NOT NULL,
      name TEXT, source_timestamp TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      PRIMARY KEY(account_id, kin_id)
    );
    CREATE TABLE IF NOT EXISTS kin_profile_fields (
      account_id TEXT NOT NULL, kin_id TEXT NOT NULL, field TEXT NOT NULL, value_json TEXT NOT NULL,
      observed_at TEXT, recorded_at TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(account_id,kin_id,field),
      FOREIGN KEY(account_id,kin_id) REFERENCES kins(account_id,kin_id)
    );
    CREATE TABLE IF NOT EXISTS kin_profile_history (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kin_id TEXT NOT NULL, field TEXT NOT NULL,
      value_json TEXT NOT NULL, observed_at TEXT, recorded_at TEXT NOT NULL, event_id TEXT NOT NULL,
      FOREIGN KEY(account_id,kin_id) REFERENCES kins(account_id,kin_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS kin_profile_history_dedupe ON kin_profile_history(account_id,kin_id,field,event_id);
    CREATE TABLE IF NOT EXISTS journal_entries (
      account_id TEXT NOT NULL, kin_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      created_at TEXT NOT NULL, description TEXT NOT NULL, keywords_json TEXT, origin TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      PRIMARY KEY(account_id,kin_id,entry_id), FOREIGN KEY(account_id,kin_id) REFERENCES kins(account_id,kin_id)
    );
    CREATE INDEX IF NOT EXISTS journal_entries_page ON journal_entries(account_id,kin_id,created_at DESC,entry_id ASC);
    CREATE TABLE IF NOT EXISTS journal_revisions (
      account_id TEXT NOT NULL, kin_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, description TEXT NOT NULL,
      keywords_json TEXT, origin TEXT, recorded_at TEXT NOT NULL,
      PRIMARY KEY(account_id,kin_id,entry_id,fingerprint),
      FOREIGN KEY(account_id,kin_id,entry_id) REFERENCES journal_entries(account_id,kin_id,entry_id)
    );
    CREATE TABLE IF NOT EXISTS scoped_conversations (
      account_id TEXT NOT NULL, kin_id TEXT NOT NULL, id TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      PRIMARY KEY(account_id, kin_id, id), FOREIGN KEY(account_id,kin_id) REFERENCES kins(account_id,kin_id)
    );
    CREATE TABLE IF NOT EXISTS scoped_messages (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, kin_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      source_id TEXT, fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL,
      data TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      FOREIGN KEY(account_id,kin_id,conversation_id) REFERENCES scoped_conversations(account_id,kin_id,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scoped_messages_source ON scoped_messages(account_id,kin_id,conversation_id,source_id) WHERE source_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS scoped_messages_fallback ON scoped_messages(account_id,kin_id,conversation_id,fingerprint) WHERE source_id IS NULL;
    CREATE INDEX IF NOT EXISTS scoped_messages_page ON scoped_messages(account_id,kin_id,conversation_id, ${messageOrderTime()} DESC, id DESC);
    CREATE TABLE IF NOT EXISTS scoped_revisions (
      message_id INTEGER NOT NULL REFERENCES scoped_messages(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, sender TEXT, timestamp TEXT, content TEXT NOT NULL, data TEXT,
      recorded_at TEXT NOT NULL, UNIQUE(message_id, fingerprint)
    );`);
  const byId = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND source_id = ?');
  const byFingerprint = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND source_id IS NULL AND fingerprint = ?');
  const find = (m) => m.messageId ? byId.get(m.conversationId, m.messageId) : byFingerprint.get(m.conversationId, m.fingerprint);
  const upsertConversation = db.prepare(`INSERT INTO conversations (id, kin_id, kin_name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kin_id=COALESCE(excluded.kin_id, kin_id), kin_name=COALESCE(excluded.kin_name, kin_name), last_seen=excluded.last_seen`);
  const insert = db.prepare('INSERT INTO messages (conversation_id, source_id, fingerprint, sender, timestamp, content, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const update = db.prepare('UPDATE messages SET fingerprint=?, sender=?, timestamp=?, content=?, last_seen=? WHERE id=?');
  const saveRevision = db.prepare('INSERT OR IGNORE INTO revisions (message_id, fingerprint, sender, timestamp, content, recorded_at) VALUES (?, ?, ?, ?, ?, ?)');

  function transact(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const accountGet = db.prepare('SELECT account_id AS accountId, display_name AS displayName, source_timestamp AS sourceTimestamp, first_seen AS firstSeen, last_seen AS lastSeen FROM accounts WHERE account_id=?');
  const kinGet = db.prepare('SELECT account_id AS accountId, kin_id AS kinId, name, source_timestamp AS sourceTimestamp, first_seen AS firstSeen, last_seen AS lastSeen FROM kins WHERE account_id=? AND kin_id=?');
  function newerSnapshot(existing, incoming) {
    const oldTime = Date.parse(existing?.lastSeen || ''); const newTime = Date.parse(incoming.lastSeen || '');
    return Number.isFinite(oldTime) && Number.isFinite(newTime) && newTime > oldTime;
  }
  function upsertAccount(raw, { importing = false } = {}) {
    const a = accountInput(raw); const now = new Date().toISOString(); const old = accountGet.get(a.accountId);
    if (!old) db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(a.accountId, a.displayName, a.sourceTimestamp, a.firstSeen || now, a.lastSeen || now);
    else if (!importing || newerSnapshot(old, a)) db.prepare('UPDATE accounts SET display_name=COALESCE(?,display_name), source_timestamp=COALESCE(?,source_timestamp), last_seen=? WHERE account_id=?').run(a.displayName, a.sourceTimestamp, importing ? a.lastSeen : now, a.accountId);
    return accountGet.get(a.accountId);
  }
  function upsertKin(raw, { importing = false } = {}) {
    const k = kinInput(raw); const now = new Date().toISOString();
    if (!accountGet.get(k.accountId)) throw error(400, 'Account does not exist');
    const old = kinGet.get(k.accountId, k.kinId);
    if (!old) db.prepare('INSERT INTO kins VALUES(?,?,?,?,?,?)').run(k.accountId, k.kinId, k.name, k.sourceTimestamp, k.firstSeen || now, k.lastSeen || now);
    else if (!importing || newerSnapshot(old, k)) db.prepare('UPDATE kins SET name=COALESCE(?,name), source_timestamp=COALESCE(?,source_timestamp), last_seen=? WHERE account_id=? AND kin_id=?').run(k.name, k.sourceTimestamp, importing ? k.lastSeen : now, k.accountId, k.kinId);
    return kinGet.get(k.accountId, k.kinId);
  }
  function upsertInventory(raw) {
    object(raw, 'inventory');
    onlyKeys(raw, ['account', 'kins'], 'inventory');
    if (!Array.isArray(raw.kins) || raw.kins.length > MAX_BATCH) throw error(400, 'Invalid inventory batch');
    return transact(() => {
      const { accountId } = upsertAccount(raw.account);
      for (const kin of raw.kins) {
        if (kin?.accountId !== accountId) throw error(400, 'Inventory account mismatch');
        upsertKin(kin);
      }
      return { accountId, kinCount: raw.kins.length };
    });
  }
  function accounts() { return db.prepare('SELECT account_id AS accountId, display_name AS displayName, source_timestamp AS sourceTimestamp, first_seen AS firstSeen, last_seen AS lastSeen FROM accounts ORDER BY account_id').all(); }
  function kins(accountId = null) {
    const sql = 'SELECT account_id AS accountId, kin_id AS kinId, name, source_timestamp AS sourceTimestamp, first_seen AS firstSeen, last_seen AS lastSeen FROM kins';
    return accountId === null ? db.prepare(`${sql} ORDER BY account_id,kin_id`).all() : db.prepare(`${sql} WHERE account_id=? ORDER BY kin_id`).all(requiredString(accountId, 'accountId'));
  }
  function requireScope(scope) {
    const value = scopeFrom(scope);
    if (!kinGet.get(value.accountId, value.kinId)) throw error(400, 'Account or Kin does not exist');
    return value;
  }
  const media = createMediaStore(db, { requireScope, transact });
  const profileGet = db.prepare('SELECT * FROM kin_profile_fields WHERE account_id=? AND kin_id=? AND field=?');
  const profileHistoryById = db.prepare('SELECT * FROM kin_profile_history WHERE account_id=? AND kin_id=? AND field=? AND event_id=?');
  const profileHistoryByValue = db.prepare('SELECT 1 FROM kin_profile_history WHERE account_id=? AND kin_id=? AND field=? AND value_json=? AND observed_at IS ?');
  const profileHistoryInsert = db.prepare('INSERT INTO kin_profile_history(account_id,kin_id,field,value_json,observed_at,recorded_at,event_id) VALUES(?,?,?,?,?,?,?)');
  function saveProfileHistory(scope, field, entry, { dedupeValue = false } = {}) {
    const json = JSON.stringify(entry.value);
    const current = profileGet.get(scope.accountId, scope.kinId, field);
    if (current?.event_id === entry.eventId && (current.value_json !== json || current.observed_at !== entry.observedAt || current.recorded_at !== entry.recordedAt)) throw error(409, 'Conflicting profile event');
    const prior = profileHistoryById.get(scope.accountId, scope.kinId, field, entry.eventId);
    if (prior) {
      if (prior.value_json !== json || prior.observed_at !== entry.observedAt || prior.recorded_at !== entry.recordedAt) throw error(409, 'Conflicting profile history event');
      return false;
    }
    if (dedupeValue && profileHistoryByValue.get(scope.accountId, scope.kinId, field, json, entry.observedAt)) return false;
    profileHistoryInsert.run(scope.accountId, scope.kinId, field, json, entry.observedAt, entry.recordedAt, entry.eventId);
    return true;
  }
  function readProfile(scope) {
    scope = requireScope(scope);
    const rows = db.prepare('SELECT * FROM kin_profile_fields WHERE account_id=? AND kin_id=? ORDER BY field').all(scope.accountId, scope.kinId);
    const history = db.prepare('SELECT * FROM kin_profile_history WHERE account_id=? AND kin_id=? AND field=? ORDER BY COALESCE(observed_at,recorded_at),recorded_at,id');
    const fields = {};
    for (const row of rows) fields[row.field] = { value: JSON.parse(row.value_json), observedAt: row.observed_at, recordedAt: row.recorded_at, eventId: row.event_id,
      history: history.all(scope.accountId, scope.kinId, row.field).map((r) => ({ value: JSON.parse(r.value_json), observedAt: r.observed_at, recordedAt: r.recorded_at, eventId: r.event_id })) };
    return { ...scope, fields };
  }
  function mergeProfileInside(scope, entries, { importing = false } = {}) {
    scope = requireScope(scope);
    const counts = { inserted: 0, updated: 0, unchanged: 0, historical: 0 };
    for (const entry of entries) {
      const current = profileGet.get(scope.accountId, scope.kinId, entry.field);
      const candidate = { ...entry, recordedAt: entry.recordedAt || new Date().toISOString(), eventId: entry.eventId || randomUUID() };
      const json = JSON.stringify(candidate.value);
      if (current && current.event_id === candidate.eventId && (current.value_json !== json || current.observed_at !== candidate.observedAt || current.recorded_at !== candidate.recordedAt)) throw error(409, 'Conflicting profile event');
      const priorEvent = profileHistoryById.get(scope.accountId,scope.kinId,entry.field,candidate.eventId);
      if (priorEvent && (priorEvent.value_json !== json || priorEvent.observed_at !== candidate.observedAt || priorEvent.recorded_at !== candidate.recordedAt)) throw error(409, 'Conflicting profile event');
      for (const historical of entry.history) if (saveProfileHistory(scope, entry.field, historical)) counts.historical++;
      if (!current) {
        db.prepare('INSERT INTO kin_profile_fields(account_id,kin_id,field,value_json,observed_at,recorded_at,event_id) VALUES(?,?,?,?,?,?,?)').run(scope.accountId, scope.kinId, entry.field, json, candidate.observedAt, candidate.recordedAt, candidate.eventId);
        counts.inserted++; continue;
      }
      const olderImport = importing && Date.parse(candidate.recordedAt) <= Date.parse(current.recorded_at);
      const olderObservation = current.observed_at && (!candidate.observedAt || candidate.observedAt <= current.observed_at);
      if (current.value_json === json) {
        // Identical observations never create a revision. Update provenance only
        // when it is strictly newer and does not come from an older import.
        if (!olderImport && candidate.observedAt && (!current.observed_at || candidate.observedAt > current.observed_at)) db.prepare('UPDATE kin_profile_fields SET observed_at=?,recorded_at=?,event_id=? WHERE account_id=? AND kin_id=? AND field=?').run(candidate.observedAt,candidate.recordedAt,candidate.eventId,scope.accountId,scope.kinId,entry.field);
        counts.unchanged++; continue;
      }
      if (olderImport || olderObservation) {
        if (saveProfileHistory(scope, entry.field, candidate, { dedupeValue: !importing })) counts.historical++;
        counts.unchanged++; continue;
      }
      saveProfileHistory(scope, entry.field, { value: JSON.parse(current.value_json), observedAt: current.observed_at, recordedAt: current.recorded_at, eventId: current.event_id });
      db.prepare('UPDATE kin_profile_fields SET value_json=?,observed_at=?,recorded_at=?,event_id=? WHERE account_id=? AND kin_id=? AND field=?').run(json,candidate.observedAt,candidate.recordedAt,candidate.eventId,scope.accountId,scope.kinId,entry.field);
      counts.updated++;
    }
    return counts;
  }
  function upsertProfile(raw) {
    const scope = scopeFrom(raw); onlyKeys(raw, ['accountId', 'kinId', 'fields'], 'profile');
    const fields = profileFieldsInput(raw.fields);
    return transact(() => mergeProfileInside(scope, fields));
  }
  const journalGet = db.prepare('SELECT * FROM journal_entries WHERE account_id=? AND kin_id=? AND entry_id=?');
  const journalInsert = db.prepare('INSERT INTO journal_entries(account_id,kin_id,entry_id,created_at,description,keywords_json,origin,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?)');
  const journalRevisionInsert = db.prepare('INSERT OR IGNORE INTO journal_revisions(account_id,kin_id,entry_id,fingerprint,created_at,description,keywords_json,origin,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)');
  function journalRowValue(row) {
    return { createdAt: row.created_at, description: row.description, keywords: row.keywords_json == null ? null : JSON.parse(row.keywords_json), origin: row.origin };
  }
  function mergeJournalInside(scope, entries, { importing = false } = {}) {
    scope = requireScope(scope);
    const counts = { inserted: 0, unchanged: 0, historical: 0 };
    for (const entry of entries) {
      const now = new Date().toISOString();
      const current = journalGet.get(scope.accountId, scope.kinId, entry.entryId);
      if (!current) {
        journalInsert.run(scope.accountId, scope.kinId, entry.entryId, entry.createdAt, entry.description, entry.keywords == null ? null : JSON.stringify(entry.keywords), entry.origin, importing ? entry.firstSeen : now, importing ? entry.lastSeen : now);
        counts.inserted++;
      } else {
        const first = importing && entry.firstSeen < current.first_seen ? entry.firstSeen : current.first_seen;
        const incomingLast = importing ? entry.lastSeen : now;
        const last = incomingLast > current.last_seen ? incomingLast : current.last_seen;
        db.prepare('UPDATE journal_entries SET first_seen=?,last_seen=? WHERE account_id=? AND kin_id=? AND entry_id=?').run(first, last, scope.accountId, scope.kinId, entry.entryId);
        const old = journalRowValue(current);
        // Missing optional metadata means unknown, not deletion. Safe enrichment
        // fills gaps only when all previously known fields still agree.
        const sameCore = entry.createdAt === old.createdAt && entry.description === old.description;
        const candidate = sameCore ? { ...entry, keywords: entry.keywords ?? old.keywords, origin: entry.origin ?? old.origin } : entry;
        const compatible = sameCore && (old.keywords == null || JSON.stringify(old.keywords) === JSON.stringify(candidate.keywords)) && (old.origin == null || old.origin === candidate.origin);
        if (compatible && (old.keywords == null && candidate.keywords != null || old.origin == null && candidate.origin != null)) {
          db.prepare('UPDATE journal_entries SET keywords_json=?,origin=? WHERE account_id=? AND kin_id=? AND entry_id=?').run(candidate.keywords == null ? null : JSON.stringify(candidate.keywords), candidate.origin, scope.accountId, scope.kinId, entry.entryId);
          counts.unchanged++;
        } else if (journalFingerprint(candidate) !== journalFingerprint(old)) {
          const result = journalRevisionInsert.run(scope.accountId, scope.kinId, entry.entryId, journalFingerprint(candidate), candidate.createdAt, candidate.description, candidate.keywords == null ? null : JSON.stringify(candidate.keywords), candidate.origin, importing ? entry.firstSeen : now);
          if (result.changes) counts.historical++;
          else counts.unchanged++;
        } else counts.unchanged++;
      }
      for (const revision of entry.revisions || []) {
        const active = journalGet.get(scope.accountId, scope.kinId, entry.entryId);
        if (journalFingerprint(revision) === journalFingerprint(journalRowValue(active))) continue;
        const result = journalRevisionInsert.run(scope.accountId, scope.kinId, entry.entryId, journalFingerprint(revision), revision.createdAt, revision.description, revision.keywords == null ? null : JSON.stringify(revision.keywords), revision.origin, revision.recordedAt);
        if (result.changes) counts.historical++;
      }
    }
    return counts;
  }
  function upsertJournal(raw) {
    const scope = scopeFrom(raw); onlyKeys(raw, ['accountId', 'kinId', 'entries'], 'journal batch');
    if (!Array.isArray(raw.entries) || raw.entries.length > MAX_BATCH) throw error(400, `Expected up to ${MAX_BATCH} journal entries`);
    const entries = raw.entries.map(entry => journalValue(entry));
    return transact(() => mergeJournalInside(scope, entries));
  }
  function journalEntries(scope = null, { limit, offset = 0 } = {}) {
    if (scope) scope = requireScope(scope);
    const where = scope ? 'WHERE account_id=? AND kin_id=?' : '';
    const params = scope ? [scope.accountId, scope.kinId] : [];
    const rows = limit == null
      ? db.prepare(`SELECT * FROM journal_entries ${where} ORDER BY created_at DESC,entry_id ASC,account_id ASC,kin_id ASC`).all(...params)
      : db.prepare(`SELECT * FROM journal_entries ${where} ORDER BY created_at DESC,entry_id ASC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const revisions = db.prepare('SELECT * FROM journal_revisions WHERE account_id=? AND kin_id=? AND entry_id=? ORDER BY recorded_at,fingerprint');
    return rows.map(row => ({ accountId: row.account_id, kinId: row.kin_id, entryId: row.entry_id, ...journalRowValue(row), firstSeen: row.first_seen, lastSeen: row.last_seen,
      revisions: revisions.all(row.account_id, row.kin_id, row.entry_id).map(revision => ({ ...journalRowValue(revision), recordedAt: revision.recorded_at })) }));
  }
  function journalPage(scope, limit = 50, offset = 0) {
    scope = requireScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 250000) throw error(400, 'Invalid journal page');
    const total = db.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE account_id=? AND kin_id=?').get(scope.accountId, scope.kinId).count;
    return { ...scope, entries: journalEntries(scope, { limit, offset }), total, nextOffset: offset + limit < total ? offset + limit : null };
  }
  function scopedLookup(columns) {
    const query = `SELECT ${columns} FROM scoped_messages WHERE account_id=? AND kin_id=? AND conversation_id=?`;
    const byId = db.prepare(`${query} AND source_id=?`);
    const byFingerprint = db.prepare(`${query} AND source_id IS NULL AND fingerprint=?`);
    return (scope, message) => (message.messageId ? byId : byFingerprint).get(
      scope.accountId, scope.kinId, message.conversationId, message.messageId ?? message.fingerprint);
  }
  const findScoped = scopedLookup('*');
  const probeScoped = scopedLookup("fingerprint, json_extract(data, '$.captureSource') AS source");
  function scopedProbe(scope, messages) {
    scope = requireScope(scope);
    messages = scopedBatch(scope, messages, true);
    return { results: messages.map((m) => {
      // Older extensions may still report optimistic IDs. Tell them no
      // upload is needed instead of persisting a temporary duplicate.
      if (isProvisionalCapture(m)) return { status: 'unchanged' };
      const row = probeScoped(scope, m);
      if (!row) return { status: 'missing' };
      if (m.captureSource && sourceRank(m.captureSource) < sourceRank(row.source)) return { status: 'unchanged' };
      if (m.captureSource && sourceRank(m.captureSource) > sourceRank(row.source)) return { status: 'changed' };
      return { status: row.fingerprint === m.fingerprint ? 'unchanged' : 'changed' };
    }) };
  }
  const scopedRevisionInsert = db.prepare('INSERT OR IGNORE INTO scoped_revisions (message_id,fingerprint,sender,timestamp,content,data,recorded_at) VALUES(?,?,?,?,?,?,?)');
  function scopedIngestInside(scope, messages, { importing = false } = {}) {
    scope = requireScope(scope); const counts = { inserted: 0, updated: 0, unchanged: 0 }; const now = new Date().toISOString();
    for (const m of messages) {
      // Keep archived imports intact, including observations from old versions.
      if (!importing && isProvisionalCapture(m)) { counts.unchanged++; continue; }
      if (importing) db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(scope.accountId,scope.kinId,m.conversationId,m.firstSeen || now,m.lastSeen || now);
      else db.prepare(`INSERT INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)
        ON CONFLICT(account_id,kin_id,id) DO UPDATE SET last_seen=excluded.last_seen`).run(scope.accountId, scope.kinId, m.conversationId, m.firstSeen || now, m.lastSeen || now);
      const old = findScoped(scope, m); const data = m.data == null ? null : JSON.stringify(m.data);
      const oldData = old?.data ? JSON.parse(old.data) : null;
      const newSource = m.data?.captureSource;
      const priority = sourceRank(newSource) - sourceRank(oldData?.captureSource);
      const upgrade = newSource && priority > 0;
      if (!old) {
        db.prepare('INSERT INTO scoped_messages(account_id,kin_id,conversation_id,source_id,fingerprint,sender,timestamp,content,data,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(scope.accountId, scope.kinId, m.conversationId, m.messageId, m.fingerprint, m.sender, m.timestamp, m.content, data, m.firstSeen || now, m.lastSeen || now); counts.inserted++;
      } else if ((newSource && priority < 0) || (importing && !newerSnapshot({ lastSeen: old.last_seen }, m))) {
        // Preserve alternate versions from an archive even when their source
        // or age keeps them from replacing the current observation.
        if (importing && old.fingerprint !== m.fingerprint) scopedRevisionInsert.run(old.id, m.fingerprint, m.sender, m.timestamp, m.content, data, m.lastSeen || now);
        counts.unchanged++;
      } else if (old.fingerprint !== m.fingerprint || upgrade) {
        if (!upgrade || !upgradeRetainsObservation(old, oldData, m, data)) scopedRevisionInsert.run(old.id, old.fingerprint, old.sender, old.timestamp, old.content, old.data, now);
        db.prepare('UPDATE scoped_messages SET fingerprint=?,sender=?,timestamp=?,content=?,data=?,last_seen=? WHERE id=?').run(m.fingerprint, m.sender, m.timestamp, m.content, data, importing && m.lastSeen ? m.lastSeen : now, old.id); counts.updated++;
      } else counts.unchanged++;
    }
    return counts;
  }
  function scopedIngest(scope, messages) {
    const batch = scopedBatch(scope, messages);
    return transact(() => scopedIngestInside(scope, batch));
  }
  function ingestInsideTransaction(messages, { importing = false } = {}) {
      const counts = { inserted: 0, updated: 0, unchanged: 0 };
      const now = new Date().toISOString();
      for (const m of messages) {
        const existing = find(m);
        const importedAt = Date.parse(m.lastSeen || '');
        const existingAt = existing ? Date.parse(existing.last_seen) : NaN;
        // A snapshot with an unknown or older observation time cannot safely replace
        // a live record. Preserve its alternate content as a revision instead.
        const retainCurrent = importing && existing &&
          (!Number.isFinite(importedAt) || !Number.isFinite(existingAt) || importedAt <= existingAt);
        if (importing) db.prepare('INSERT OR IGNORE INTO conversations(id,kin_id,kin_name,first_seen,last_seen) VALUES(?,?,?,?,?)').run(m.conversationId,m.kinId,m.kinName,m.firstSeen || now,m.lastSeen || now);
        else upsertConversation.run(m.conversationId, retainCurrent ? null : m.kinId, retainCurrent ? null : m.kinName, now, now);
        if (!existing) {
          insert.run(m.conversationId, m.messageId, m.fingerprint, m.sender, m.timestamp, m.content, m.firstSeen || now, m.lastSeen || now);
          counts.inserted++;
        } else if (existing.fingerprint !== m.fingerprint) {
          if (retainCurrent) {
            saveRevision.run(existing.id, m.fingerprint, m.sender, m.timestamp, m.content, m.lastSeen || now);
            counts.unchanged++;
          } else {
            saveRevision.run(existing.id, existing.fingerprint, existing.sender, existing.timestamp, existing.content, now);
            update.run(m.fingerprint, m.sender, m.timestamp, m.content, importing && m.lastSeen ? m.lastSeen : now, existing.id);
            counts.updated++;
          }
        } else {
          counts.unchanged++;
        }
      }
      return counts;
  }
  function ingest(messages) { return transact(() => ingestInsideTransaction(messages)); }
  function probe(messages) {
    return { results: messages.map((m) => { const found = find(m); return { status: !found ? 'missing' : found.fingerprint === m.fingerprint ? 'unchanged' : 'changed' }; }) };
  }
  function digest() {
    const legacy = { conversations: db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count, messages: db.prepare('SELECT COUNT(*) AS count FROM messages').get().count };
    const scoped = db.prepare('SELECT COUNT(*) AS count, MAX(last_seen) AS latest FROM scoped_messages').get();
    const legacyLatest = db.prepare('SELECT MAX(last_seen) AS value FROM messages').get().value;
    return {
      accounts: db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
      conversations: legacy.conversations + db.prepare('SELECT COUNT(*) AS count FROM scoped_conversations').get().count,
      kins: db.prepare('SELECT COUNT(*) AS count FROM kins').get().count + db.prepare('SELECT COUNT(DISTINCT COALESCE(kin_id, kin_name)) AS count FROM conversations').get().count,
      messages: legacy.messages + scoped.count,
      revisions: db.prepare('SELECT COUNT(*) AS count FROM revisions').get().count + db.prepare('SELECT COUNT(*) AS count FROM scoped_revisions').get().count,
      legacyMessages: legacy.messages, legacyConversations: legacy.conversations,
      lastArchivedAt: [legacyLatest, scoped.latest].filter(Boolean).sort().at(-1) || null,
    };
  }
  function conversations() {
    return db.prepare(`SELECT c.id, c.kin_id AS kinId, c.kin_name AS kinName, c.first_seen AS firstSeen, c.last_seen AS lastSeen,
      COUNT(m.id) AS messageCount FROM conversations c LEFT JOIN messages m ON c.id=m.conversation_id
      GROUP BY c.id ORDER BY c.last_seen DESC`).all();
  }
  function archiveMessages(conversationId = null) {
    const sql = `SELECT m.conversation_id AS conversationId, c.kin_id AS kinId, c.kin_name AS kinName,
      m.source_id AS messageId, m.fingerprint, m.sender, m.timestamp, m.content,
      m.first_seen AS firstSeen, m.last_seen AS lastSeen, m.id AS internalId
      FROM messages m JOIN conversations c ON c.id=m.conversation_id`;
    const rows = conversationId == null ? db.prepare(`${sql} ORDER BY m.id`).all() : db.prepare(`${sql} WHERE m.conversation_id=? ORDER BY COALESCE(m.timestamp, m.first_seen), m.id`).all(conversationId);
    const revisionQuery = db.prepare('SELECT fingerprint, sender, timestamp, content, recorded_at AS recordedAt FROM revisions WHERE message_id=? ORDER BY recorded_at');
    return rows.map(({ internalId, ...m }) => ({ ...m, revisions: revisionQuery.all(internalId) }));
  }
  function scopedConversations(scope) {
    scope = requireScope(scope);
    return db.prepare(`SELECT c.account_id AS accountId,c.kin_id AS kinId,c.id,c.first_seen AS firstSeen,c.last_seen AS lastSeen,COUNT(m.id) AS messageCount
      FROM scoped_conversations c LEFT JOIN scoped_messages m ON m.account_id=c.account_id AND m.kin_id=c.kin_id AND m.conversation_id=c.id
      WHERE c.account_id=? AND c.kin_id=? GROUP BY c.account_id,c.kin_id,c.id ORDER BY c.last_seen DESC`).all(scope.accountId,scope.kinId);
  }
  function scopedArchiveMessages(scope = null, conversationId = null) {
    const sql = `SELECT m.account_id AS accountId,m.kin_id AS kinId,m.conversation_id AS conversationId,m.source_id AS messageId,m.fingerprint,m.sender,m.timestamp,m.content,m.data,m.first_seen AS firstSeen,m.last_seen AS lastSeen,m.id AS internalId FROM scoped_messages m`;
    let rows;
    if (scope === null) rows = db.prepare(`${sql} ORDER BY m.id`).all();
    else {
      scope = requireScope(scope);
      rows = conversationId == null ? db.prepare(`${sql} WHERE m.account_id=? AND m.kin_id=? ORDER BY m.id`).all(scope.accountId,scope.kinId)
        : db.prepare(`${sql} WHERE m.account_id=? AND m.kin_id=? AND m.conversation_id=? ORDER BY COALESCE(m.timestamp,m.first_seen),m.id`).all(scope.accountId,scope.kinId,conversationId);
    }
    const rev = db.prepare('SELECT fingerprint,sender,timestamp,content,data,recorded_at AS recordedAt FROM scoped_revisions WHERE message_id=? ORDER BY recorded_at');
    return rows.map(({ internalId, data, ...m }) => ({ ...m, data: data == null ? null : JSON.parse(data), revisions: rev.all(internalId).map((r) => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) })) }));
  }
  function archiveMessagePage(scope, conversationId, { limit, cursor, direction = 'older' }) {
    if (scope) scope = requireScope(scope);
    if (conversationId != null) requiredString(conversationId, 'conversationId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['older', 'newer', 'oldest'].includes(direction) ||
        (direction === 'oldest' && cursor != null) || (direction === 'newer' && cursor == null)) throw error(400, 'Invalid message page');
    const expected = { v: 1, kind: scope ? 'scoped' : 'legacy', accountId: scope?.accountId ?? null, kinId: scope?.kinId ?? null, conversationId: conversationId ?? null };
    const after = cursor ? decodeMessageCursor(cursor, expected, direction) : null;
    const sort = messageOrderTime('m.');
    const filters = []; const params = [];
    if (scope) { filters.push('m.account_id=?', 'm.kin_id=?'); params.push(scope.accountId, scope.kinId); }
    if (conversationId != null) { filters.push('m.conversation_id=?'); params.push(conversationId); }
    const countWhere = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const countFrom = scope ? 'scoped_messages m' : 'messages m JOIN conversations c ON c.id=m.conversation_id';
    const total = db.prepare(`SELECT COUNT(*) AS count FROM ${countFrom}${countWhere}`).get(...params).count;
    const ascending = direction !== 'older';
    if (after) {
      const op = direction === 'newer' ? '>' : '<';
      filters.push(`(${sort} ${op} ? OR (${sort} = ? AND m.id ${op} ?))`);
      params.push(after.orderTime, after.orderTime, after.id);
    }
    const common = `m.conversation_id AS conversationId,m.source_id AS messageId,m.fingerprint,m.sender,m.timestamp,m.content,m.first_seen AS firstSeen,m.last_seen AS lastSeen,m.id AS internalId,${sort} AS orderTime`;
    const sql = scope
      ? `SELECT m.account_id AS accountId,m.kin_id AS kinId,${common},m.data FROM scoped_messages m`
      : `SELECT ${common},c.kin_id AS kinId,c.kin_name AS kinName FROM messages m JOIN conversations c ON c.id=m.conversation_id`;
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    // The newest page always contains up to `limit` rows. The oldest page may
    // therefore be shorter; align a direct jump with the same page boundaries.
    const pageSize = direction === 'oldest' ? (total % limit || limit) : limit;
    const order = ascending ? 'ASC' : 'DESC';
    const rows = db.prepare(`${sql}${where} ORDER BY ${sort} ${order},m.id ${order} LIMIT ?`).all(...params, pageSize + 1);
    const more = rows.length > pageSize;
    if (more) rows.pop();
    if (ascending) rows.reverse();
    const revisionMap = new Map(rows.map((row) => [row.internalId, []]));
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',');
      const revisionSql = scope
        ? `SELECT message_id AS internalId,fingerprint,sender,timestamp,content,data,recorded_at AS recordedAt FROM scoped_revisions WHERE message_id IN (${placeholders}) ORDER BY recorded_at,rowid`
        : `SELECT message_id AS internalId,fingerprint,sender,timestamp,content,recorded_at AS recordedAt FROM revisions WHERE message_id IN (${placeholders}) ORDER BY recorded_at,rowid`;
      for (const { internalId, ...revision } of db.prepare(revisionSql).all(...rows.map((row) => row.internalId))) {
        if (scope) revision.data = revision.data == null ? null : JSON.parse(revision.data);
        revisionMap.get(internalId).push(revision);
      }
    }
    const last = rows.at(-1), first = rows[0];
    const hasOlder = direction === 'older' ? more : direction === 'newer' && !!after;
    const hasNewer = direction === 'older' ? !!after : more;
    const nextCursor = hasOlder && last ? Buffer.from(JSON.stringify({ ...expected, orderTime: last.orderTime, id: last.internalId })).toString('base64url') : null;
    const newerCursor = hasNewer && first ? Buffer.from(JSON.stringify({ ...expected, v: 2, direction: 'newer', orderTime: first.orderTime, id: first.internalId })).toString('base64url') : null;
    const messages = rows.map(({ internalId, orderTime: _sortTime, ...message }) => {
      if (scope) message.data = message.data == null ? null : JSON.parse(message.data);
      return { ...message, revisions: revisionMap.get(internalId) };
    });
    return { messages, nextCursor, newerCursor, total };
  }
  function exportArchive(version = 5) {
    const legacy = { format: 'kinexport', version: 1, exportedAt: new Date().toISOString(), messages: archiveMessages() };
    if (version === 1) {
      if (accounts().length || kins().length) throw error(409, 'Version 1 cannot represent accounts or Kins; use version 2 export');
      return legacy;
    }
    if (![2, 3, 4, 5].includes(version)) throw error(400, 'Unsupported export version');
    if (version < 5 && media.count()) throw error(409, `Version ${version} cannot represent media; use version 5 export`);
    const journalCount = db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get().count;
    if (version < 4 && journalCount) throw error(409, `Version ${version} cannot represent journal entries; use version 4 export`);
    const profileCount = db.prepare('SELECT COUNT(*) AS count FROM kin_profile_fields').get().count;
    if (version === 2 && profileCount) throw error(409, 'Version 2 cannot represent Kin profiles; use version 3 export');
    legacy.conversations = conversations();
    const scopedConversationsList = db.prepare(`SELECT c.account_id AS accountId,c.kin_id AS kinId,c.id,c.first_seen AS firstSeen,c.last_seen AS lastSeen,COUNT(m.id) AS messageCount
      FROM scoped_conversations c LEFT JOIN scoped_messages m ON m.account_id=c.account_id AND m.kin_id=c.kin_id AND m.conversation_id=c.id
      GROUP BY c.account_id,c.kin_id,c.id ORDER BY c.account_id,c.kin_id,c.id`).all();
    const archive = { format: 'kinexport', version, exportedAt: legacy.exportedAt, accounts: accounts(), kins: kins(), legacy, conversations: scopedConversationsList, messages: scopedArchiveMessages() };
    if (version >= 3) archive.kinProfiles = kins().map((kin) => readProfile(kin)).filter((profile) => Object.keys(profile.fields).length);
    if (version >= 4) archive.journalEntries = journalEntries();
    if (version === 5) archive.media = media.exportData();
    if (version === 5 && Buffer.byteLength(JSON.stringify(archive), 'utf8') > MAX_BODY) throw error(413, 'Archive exceeds the current import limit.');
    return archive;
  }
  function search(query) {
    const legacy = db.prepare(`SELECT m.conversation_id AS conversationId, c.kin_name AS kinName,
      m.source_id AS messageId, m.sender, m.timestamp, m.content
      FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE instr(lower(m.content), lower(?)) > 0 ORDER BY m.id DESC LIMIT 100`).all(query);
    const scoped = db.prepare(`SELECT m.account_id AS accountId,m.kin_id AS kinId,k.name AS kinName,m.conversation_id AS conversationId,m.source_id AS messageId,m.sender,m.timestamp,m.content
      FROM scoped_messages m JOIN kins k ON k.account_id=m.account_id AND k.kin_id=m.kin_id
      WHERE instr(lower(m.content),lower(?)) > 0 ORDER BY m.id DESC LIMIT 100`).all(query);
    return [...scoped, ...legacy.map((m) => ({ ...m, accountId: null, kinId: null }))].slice(0, 100);
  }
  function validateLegacy(body) {
    if (!body || body.format !== 'kinexport' || body.version !== 1) throw error(400, 'Unsupported archive format');
    if (!Array.isArray(body.messages) || body.messages.length > 250000) throw error(400, 'Invalid archive messages (maximum 250000 per import)');
    return body.messages.map((raw) => {
      const message = validateMessage(raw);
      if (raw.revisions != null && (!Array.isArray(raw.revisions) || raw.revisions.length > 1000)) throw error(400, 'Invalid revisions');
      const revisions = (raw.revisions ?? []).map((r) => {
        if (!r || typeof r !== 'object' || typeof r.content !== 'string' || r.content.length > 1_000_000) throw error(400, 'Invalid revision');
        return { fingerprint: requiredString(r.fingerprint, 'revision fingerprint'), sender: optionalString(r.sender, 'revision sender'), timestamp: optionalString(r.timestamp, 'revision timestamp'), content: r.content, recordedAt: requiredString(r.recordedAt, 'revision recordedAt') };
      });
      return { message, revisions };
    });
  }
  function importLegacyInside(validated) {
      const counts = ingestInsideTransaction(validated.map((x) => x.message), { importing: true });
      for (const { message, revisions } of validated) {
        const row = find(message);
        for (const r of revisions) saveRevision.run(row.id, r.fingerprint, r.sender, r.timestamp, r.content, r.recordedAt);
      }
      return counts;
  }
  function importArchive(body) {
    object(body, 'archive');
    if (body.format !== 'kinexport') throw error(400, 'Unsupported archive format');
    if (body.version === 1) {
      const legacy = validateLegacy(body);
      return transact(() => importLegacyInside(legacy));
    }
    if (body.version < 4 && Object.hasOwn(body, 'journalEntries')) throw error(400, 'Journal entries require a version 4 archive');
    if (body.version < 5 && Object.hasOwn(body, 'media')) throw error(400, 'Media requires a version 5 archive');
    if (![2, 3, 4, 5].includes(body.version) || !Array.isArray(body.accounts) || !Array.isArray(body.kins) || !Array.isArray(body.messages) || body.messages.length > 250000 || (body.version >= 3 && !Array.isArray(body.kinProfiles)) || (body.version >= 4 && (!Array.isArray(body.journalEntries) || body.journalEntries.length > 250000))) throw error(400, 'Invalid version 2, 3, 4 or 5 archive');
    const mediaArchive = body.version === 5 ? media.validateArchive(body.media) : null;
    const legacy = validateLegacy(body.legacy);
    if (body.legacy.conversations != null && !Array.isArray(body.legacy.conversations)) throw error(400, 'Invalid legacy conversations');
    if (body.conversations != null && !Array.isArray(body.conversations)) throw error(400, 'Invalid scoped conversations');
    const legacyConversations = (body.legacy.conversations || []).map((raw) => conversationInput(raw));
    const scopedConversationsList = (body.conversations || []).map((raw) => conversationInput(raw, true));
    const accountList = body.accounts.map(accountInput); const kinList = body.kins.map(kinInput);
    const profiles = (body.version >= 3 ? body.kinProfiles : []).map((raw) => {
      const scope = scopeFrom(raw); onlyKeys(raw, ['accountId', 'kinId', 'fields'], 'profile');
      return { scope, fields: profileFieldsInput(raw.fields, { importing: true }) };
    });
    const journals = (body.version >= 4 ? body.journalEntries : []).map(raw => ({ scope: scopeFrom(raw), entry: journalValue(raw, { importing: true }) }));
    const scopedList = body.messages.map((raw) => {
      const scope = scopeFrom(raw);
      const message = scopedMessage(raw, false, true);
      if (raw.revisions != null && (!Array.isArray(raw.revisions) || raw.revisions.length > 1000)) throw error(400, 'Invalid revisions');
      const revisions = (raw.revisions || []).map((r) => {
        object(r, 'revision'); onlyKeys(r, ['fingerprint', 'sender', 'timestamp', 'content', 'data', 'recordedAt'], 'revision');
        if (typeof r.content !== 'string' || r.content.length > 1_000_000) throw error(400, 'Invalid revision content');
        return { fingerprint: requiredString(r.fingerprint, 'revision fingerprint'), sender: optionalString(r.sender, 'revision sender'), timestamp: optionalString(r.timestamp, 'revision timestamp'), content: r.content, data: messageData(r.data), recordedAt: requiredString(r.recordedAt, 'revision recordedAt') };
      });
      return { scope, message, revisions };
    });
    // Validate and merge the whole snapshot in a single transaction.
    return transact(() => {
      for (const a of accountList) upsertAccount(a, { importing: true });
      for (const k of kinList) upsertKin(k, { importing: true });
      if (mediaArchive) media.importInside(mediaArchive);
      for (const profile of profiles) mergeProfileInside(profile.scope, profile.fields, { importing: true });
      for (const journal of journals) mergeJournalInside(journal.scope, [journal.entry], { importing: true });
      const existingLegacy = new Set(conversations().map((c) => c.id));
      const scopedExists = db.prepare('SELECT 1 FROM scoped_conversations WHERE account_id=? AND kin_id=? AND id=?');
      const existingScoped = new Set(scopedConversationsList.filter((c) => scopedExists.get(c.accountId,c.kinId,c.id)).map((c) => JSON.stringify([c.accountId,c.kinId,c.id])));
      for (const c of legacyConversations) db.prepare('INSERT OR IGNORE INTO conversations(id,kin_id,kin_name,first_seen,last_seen) VALUES(?,?,?,?,?)').run(c.id,c.kinId,c.kinName,c.firstSeen,c.lastSeen);
      for (const c of scopedConversationsList) {
        requireScope(c);
        db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(c.accountId,c.kinId,c.id,c.firstSeen,c.lastSeen);
      }
      const counts = importLegacyInside(legacy);
      for (const { scope, message, revisions } of scopedList) {
        const scopedCounts = scopedIngestInside(scope, [message], { importing: true });
        for (const key of Object.keys(counts)) counts[key] += scopedCounts[key];
        const row = findScoped(scope, message);
        for (const r of revisions) scopedRevisionInsert.run(row.id, r.fingerprint, r.sender, r.timestamp, r.content, r.data == null ? null : JSON.stringify(r.data), r.recordedAt);
      }
      // Fresh restores preserve conversation metadata exactly; existing archives
      // keep their metadata rather than having it overwritten by older snapshots.
      for (const c of legacyConversations) if (!existingLegacy.has(c.id)) db.prepare('UPDATE conversations SET kin_id=?,kin_name=?,first_seen=?,last_seen=? WHERE id=?').run(c.kinId,c.kinName,c.firstSeen,c.lastSeen,c.id);
      for (const c of scopedConversationsList) if (!existingScoped.has(JSON.stringify([c.accountId,c.kinId,c.id]))) db.prepare('UPDATE scoped_conversations SET first_seen=?,last_seen=? WHERE account_id=? AND kin_id=? AND id=?').run(c.firstSeen,c.lastSeen,c.accountId,c.kinId,c.id);
      return counts;
    });
  }
  // Merge a validated SQLite snapshot a record at a time. The surrounding
  // transaction keeps a failed import from changing the live archive.
  function mergeSnapshot(source) {
    return transact(() => {
      const counts = { inserted: 0, updated: 0, unchanged: 0 };
      const addCounts = value => { for (const key of Object.keys(counts)) counts[key] += value[key] || 0; };
      for (const a of source.prepare('SELECT * FROM accounts').iterate()) upsertAccount({ accountId:a.account_id, displayName:a.display_name, sourceTimestamp:a.source_timestamp, firstSeen:a.first_seen, lastSeen:a.last_seen }, { importing:true });
      for (const k of source.prepare('SELECT * FROM kins').iterate()) upsertKin({ accountId:k.account_id, kinId:k.kin_id, name:k.name, sourceTimestamp:k.source_timestamp, firstSeen:k.first_seen, lastSeen:k.last_seen }, { importing:true });
      for (const c of source.prepare('SELECT * FROM conversations').iterate()) {
        const v = conversationInput({ id:c.id, kinId:c.kin_id, kinName:c.kin_name, firstSeen:c.first_seen, lastSeen:c.last_seen });
        db.prepare('INSERT OR IGNORE INTO conversations(id,kin_id,kin_name,first_seen,last_seen) VALUES(?,?,?,?,?)').run(v.id,v.kinId,v.kinName,v.firstSeen,v.lastSeen);
      }
      for (const c of source.prepare('SELECT * FROM scoped_conversations').iterate()) {
        const v = conversationInput({ accountId:c.account_id, kinId:c.kin_id, id:c.id, firstSeen:c.first_seen, lastSeen:c.last_seen }, true);
        requireScope(v); db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(v.accountId,v.kinId,v.id,v.firstSeen,v.lastSeen);
      }
      for (const b of source.prepare('SELECT sha256,mime,bytes FROM media_blobs').iterate()) media.importBlob(b.sha256,b.mime,b.bytes);
      for (const item of source.prepare('SELECT account_id AS accountId,kin_id AS kinId,kind,source_id AS sourceId,variant,sha256,created_at AS createdAt,prompt,message_id AS messageId,first_seen AS firstSeen,last_seen AS lastSeen FROM media_items').iterate()) media.importItem(item);
      const history = source.prepare('SELECT * FROM kin_profile_history WHERE account_id=? AND kin_id=? AND field=? ORDER BY id');
      for (const row of source.prepare('SELECT * FROM kin_profile_fields').iterate()) {
        const scope = scopeFrom({accountId:row.account_id,kinId:row.kin_id}); requireScope(scope);
        const field = requiredString(row.field, 'profile field');
        const parseEntry = r => profileFieldsInput({ [field]: { value:JSON.parse(r.value_json), observedAt:r.observed_at, recordedAt:r.recorded_at, eventId:r.event_id, history:[] } }, { importing:true })[0];
        for (const old of history.iterate(scope.accountId,scope.kinId,field)) saveProfileHistory(scope,field,parseEntry(old));
        mergeProfileInside(scope,[parseEntry(row)],{ importing:true });
      }
      const journalHistory = source.prepare('SELECT * FROM journal_revisions WHERE account_id=? AND kin_id=? AND entry_id=?');
      for (const row of source.prepare('SELECT * FROM journal_entries').iterate()) {
        const scope = scopeFrom({accountId:row.account_id,kinId:row.kin_id});
        const entry = journalValue({ entryId:row.entry_id, createdAt:row.created_at, description:row.description, keywords:row.keywords_json == null ? null : JSON.parse(row.keywords_json), origin:row.origin, firstSeen:row.first_seen, lastSeen:row.last_seen, revisions:[] }, { importing:true });
        mergeJournalInside(scope,[entry],{ importing:true });
        for (const old of journalHistory.iterate(scope.accountId,scope.kinId,entry.entryId)) {
          const revision = journalValue({ createdAt:old.created_at,description:old.description,keywords:old.keywords_json == null ? null : JSON.parse(old.keywords_json),origin:old.origin,recordedAt:old.recorded_at }, { revision:true });
          const active = journalGet.get(scope.accountId,scope.kinId,entry.entryId);
          if (journalFingerprint(revision) !== journalFingerprint(journalRowValue(active))) journalRevisionInsert.run(scope.accountId,scope.kinId,entry.entryId,journalFingerprint(revision),revision.createdAt,revision.description,revision.keywords == null ? null : JSON.stringify(revision.keywords),revision.origin,revision.recordedAt);
        }
      }
      const legacyRevisions = source.prepare('SELECT * FROM revisions WHERE message_id=?');
      for (const row of source.prepare('SELECT m.*,c.kin_id,c.kin_name FROM messages m JOIN conversations c ON c.id=m.conversation_id').iterate()) {
        const m = validateMessage({ conversationId:row.conversation_id,kinId:row.kin_id,kinName:row.kin_name,messageId:row.source_id,fingerprint:row.fingerprint,sender:row.sender,timestamp:row.timestamp,content:row.content,firstSeen:row.first_seen,lastSeen:row.last_seen });
        addCounts(ingestInsideTransaction([m],{ importing:true })); const current=find(m);
        for (const old of legacyRevisions.iterate(row.id)) {
          if (typeof old.content !== 'string' || old.content.length > 1_000_000) throw error(400,'Invalid revision');
          saveRevision.run(current.id,requiredString(old.fingerprint,'revision fingerprint'),optionalString(old.sender,'revision sender'),optionalString(old.timestamp,'revision timestamp'),old.content,requiredString(old.recorded_at,'revision recordedAt'));
        }
      }
      const scopedRevisions = source.prepare('SELECT * FROM scoped_revisions WHERE message_id=?');
      for (const row of source.prepare('SELECT * FROM scoped_messages').iterate()) {
        const scope=scopeFrom({accountId:row.account_id,kinId:row.kin_id});
        const m=scopedMessage({conversationId:row.conversation_id,messageId:row.source_id,fingerprint:row.fingerprint,sender:row.sender,timestamp:row.timestamp,content:row.content,data:row.data == null ? null : JSON.parse(row.data),firstSeen:row.first_seen,lastSeen:row.last_seen},false,true);
        addCounts(scopedIngestInside(scope,[m],{ importing:true })); const current=findScoped(scope,m);
        for (const old of scopedRevisions.iterate(row.id)) {
          if (typeof old.content !== 'string' || old.content.length > 1_000_000) throw error(400,'Invalid revision');
          const data=old.data == null ? null : messageData(JSON.parse(old.data));
          scopedRevisionInsert.run(current.id,requiredString(old.fingerprint,'revision fingerprint'),optionalString(old.sender,'revision sender'),optionalString(old.timestamp,'revision timestamp'),old.content,data == null ? null : JSON.stringify(data),requiredString(old.recorded_at,'revision recordedAt'));
        }
      }
      return counts;
    });
  }
  // total_changes covers this connection. data_version covers commits from other connections.
  const localChanges = db.prepare('SELECT total_changes() AS n');
  const externalChanges = db.prepare('PRAGMA main.data_version');
  function changeStamp() {
    return [localChanges.get().n, externalChanges.get().data_version].join('/');
  }
  function replaceSnapshot(path, beforeBackup) {
    db.prepare('ATTACH DATABASE ? AS restore_source').run(path);
    const order = ['accounts','kins','conversations','scoped_conversations','media_blobs','kin_profile_fields','kin_profile_history','journal_entries','journal_revisions','messages','revisions','scoped_messages','scoped_revisions','media_items','media_thumbnails'];
    try {
      return transact(() => {
        if (beforeBackup !== changeStamp()) throw error(409, 'Archive changed during the recovery backup. Retry restore when capture is idle.');
        for (const table of order.slice().reverse()) db.exec(`DELETE FROM main.${table}`);
        for (const table of order) db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`);
      });
    } finally { db.exec('DETACH DATABASE restore_source'); }
  }
  return { db, databasePath, probe, ingest, digest, conversations, archiveMessages, archiveMessagePage, exportArchive, importArchive, mergeSnapshot, changeStamp, replaceSnapshot, search, upsertAccount, upsertKin, upsertInventory, accounts, kins, scopedProbe, scopedIngest, scopedConversations, scopedArchiveMessages, upsertProfile, readProfile, upsertJournal, journalPage, media };
}
