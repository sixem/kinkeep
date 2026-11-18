import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createMediaStore } from './media-store.js';
import {
  MAX_BATCH, accountInput, conversationInput, error, journalValue, kinInput,
  messageData, object, onlyKeys, optionalString, profileFieldsInput, requiredString,
  scopeFrom, scopedBatch, scopedMessage,
} from './validation.js';

const isProvisionalCapture = message => (message.captureSource ?? message.data?.captureSource) != null &&
  typeof message.messageId === 'string' && /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.messageId);
// Unknown sources have the same precedence as cache data.
const sourceRank = source => source === 'dom' ? 0 : source === 'history' ? 1 : 2;
function upgradeRetainsObservation(old, oldData, incoming, nextData) {
  if (old.content !== incoming.content || (old.sender != null && old.sender !== incoming.sender) ||
      (old.timestamp != null && old.timestamp !== incoming.timestamp)) return false;
  return Object.entries(oldData ?? {}).every(([key, value]) => key === 'captureSource' || isDeepStrictEqual(value, nextData[key]));
}
function withoutReactions(data) {
  const { reactions, reactionsRevision, ...details } = data ?? {};
  return details;
}
function sameMessageExceptReactions(old, oldData, incoming, upgrade) {
  const previous = withoutReactions(oldData);
  const next = withoutReactions(incoming.data);
  if (upgrade) return upgradeRetainsObservation(old, previous, incoming, next);
  return old.content === incoming.content && old.sender === incoming.sender && old.timestamp === incoming.timestamp &&
    isDeepStrictEqual(previous, next);
}
function keepUnobservedReactions(previous, incoming) {
  if (incoming?.reactions !== undefined || previous?.reactions === undefined) return incoming;
  const data = { ...withoutReactions(incoming), reactions: previous.reactions };
  if (previous.reactionsRevision !== undefined) data.reactionsRevision = previous.reactionsRevision;
  return data;
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
  if (data?.v !== 1 || data.direction !== direction ||
      data.accountId !== expected.accountId || data.kinId !== expected.kinId || data.conversationId !== expected.conversationId ||
      !Number.isFinite(data.orderTime) || !Number.isSafeInteger(data.id) || data.id < 1) throw error(400, 'Invalid message cursor');
  return data;
}

// The portable ZIP and SQLite backup share the release schema.
const ARCHIVE_SCHEMA_V1 = 'ba211f2f98e97d3142cd2de3ec8e09c8c3a7073bd776341936df538664455218';
export function archiveSchema(db) {
  return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")
    .all().map(row => [row.type, row.name, row.tbl_name, row.sql]);
}
export function matchesArchiveSchema(db) {
  return createHash('sha256').update(JSON.stringify(archiveSchema(db))).digest('hex') === ARCHIVE_SCHEMA_V1;
}

export function createArchive({ databasePath, token }) {
  requiredString(token, 'server token', 4096);
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  let media;
  try {
    if (archiveSchema(db).length && !matchesArchiveSchema(db)) throw new Error('Unsupported SQLite archive schema.');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    media = transact(() => {
      db.exec(`
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
      return createMediaStore(db, { requireScope, transact });
    });
  } catch (error) {
    db.close();
    throw error;
  }
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
    }
    return counts;
  }
  function upsertJournal(raw) {
    const scope = scopeFrom(raw); onlyKeys(raw, ['accountId', 'kinId', 'entries'], 'journal batch');
    if (!Array.isArray(raw.entries) || raw.entries.length > MAX_BATCH) throw error(400, `Expected up to ${MAX_BATCH} journal entries`);
    const entries = raw.entries.map(entry => journalValue(entry));
    return transact(() => mergeJournalInside(scope, entries));
  }
  function journalEntries(scope, limit, offset) {
    const rows = db.prepare(`SELECT * FROM journal_entries WHERE account_id=? AND kin_id=?
      ORDER BY created_at DESC,entry_id ASC LIMIT ? OFFSET ?`).all(scope.accountId, scope.kinId, limit, offset);
    const revisions = db.prepare('SELECT * FROM journal_revisions WHERE account_id=? AND kin_id=? AND entry_id=? ORDER BY recorded_at,fingerprint');
    return rows.map(row => ({ accountId: row.account_id, kinId: row.kin_id, entryId: row.entry_id, ...journalRowValue(row), firstSeen: row.first_seen, lastSeen: row.last_seen,
      revisions: revisions.all(row.account_id, row.kin_id, row.entry_id).map(revision => ({ ...journalRowValue(revision), recordedAt: revision.recorded_at })) }));
  }
  function journalPage(scope, limit = 50, offset = 0) {
    scope = requireScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 250000) throw error(400, 'Invalid journal page');
    const total = db.prepare('SELECT COUNT(*) AS count FROM journal_entries WHERE account_id=? AND kin_id=?').get(scope.accountId, scope.kinId).count;
    return { ...scope, entries: journalEntries(scope, limit, offset), total, nextOffset: offset + limit < total ? offset + limit : null };
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
      // Skip temporary IDs before checking for an archived message.
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
      if (isProvisionalCapture(m)) {
        if (importing) throw error(400, 'Imported message has a temporary ID');
        counts.unchanged++;
        continue;
      }
      if (importing) db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(scope.accountId,scope.kinId,m.conversationId,m.firstSeen || now,m.lastSeen || now);
      else db.prepare(`INSERT INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)
        ON CONFLICT(account_id,kin_id,id) DO UPDATE SET last_seen=excluded.last_seen`).run(scope.accountId, scope.kinId, m.conversationId, m.firstSeen || now, m.lastSeen || now);
      const old = findScoped(scope, m);
      const data = m.data == null ? null : JSON.stringify(m.data);
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
        const coalesceReactions = !importing && sameMessageExceptReactions(old, oldData, m, upgrade);
        if (!coalesceReactions && (!upgrade || !upgradeRetainsObservation(old, oldData, m, JSON.parse(data)))) {
          scopedRevisionInsert.run(old.id, old.fingerprint, old.sender, old.timestamp, old.content, old.data, now);
        }
        const nextData = coalesceReactions ? keepUnobservedReactions(oldData, m.data) : m.data;
        const nextJson = nextData === m.data ? data : JSON.stringify(nextData);
        db.prepare('UPDATE scoped_messages SET fingerprint=?,sender=?,timestamp=?,content=?,data=?,last_seen=? WHERE id=?')
          .run(m.fingerprint, m.sender, m.timestamp, m.content, nextJson, importing && m.lastSeen ? m.lastSeen : now, old.id);
        counts.updated++;
      } else counts.unchanged++;
    }
    return counts;
  }
  function scopedIngest(scope, messages) {
    const batch = scopedBatch(scope, messages);
    return transact(() => scopedIngestInside(scope, batch));
  }
  function digest() {
    const messages = db.prepare('SELECT COUNT(*) AS count, MAX(last_seen) AS latest FROM scoped_messages').get();
    return {
      accounts: db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count,
      conversations: db.prepare('SELECT COUNT(*) AS count FROM scoped_conversations').get().count,
      kins: db.prepare('SELECT COUNT(*) AS count FROM kins').get().count,
      messages: messages.count,
      revisions: db.prepare('SELECT COUNT(*) AS count FROM scoped_revisions').get().count,
      lastArchivedAt: messages.latest,
    };
  }
  function scopedConversations(scope) {
    scope = requireScope(scope);
    return db.prepare(`SELECT c.account_id AS accountId,c.kin_id AS kinId,c.id,c.first_seen AS firstSeen,c.last_seen AS lastSeen,COUNT(m.id) AS messageCount
      FROM scoped_conversations c LEFT JOIN scoped_messages m ON m.account_id=c.account_id AND m.kin_id=c.kin_id AND m.conversation_id=c.id
      WHERE c.account_id=? AND c.kin_id=? GROUP BY c.account_id,c.kin_id,c.id ORDER BY c.last_seen DESC`).all(scope.accountId,scope.kinId);
  }
  function scopedArchiveMessages(scope, conversationId = null) {
    scope = requireScope(scope);
    const sql = `SELECT m.account_id AS accountId,m.kin_id AS kinId,m.conversation_id AS conversationId,m.source_id AS messageId,m.fingerprint,m.sender,m.timestamp,m.content,m.data,m.first_seen AS firstSeen,m.last_seen AS lastSeen,m.id AS internalId FROM scoped_messages m WHERE m.account_id=? AND m.kin_id=?`;
    const rows = conversationId == null
      ? db.prepare(`${sql} ORDER BY m.id`).all(scope.accountId, scope.kinId)
      : db.prepare(`${sql} AND m.conversation_id=? ORDER BY COALESCE(m.timestamp,m.first_seen),m.id`).all(scope.accountId, scope.kinId, conversationId);
    const rev = db.prepare('SELECT fingerprint,sender,timestamp,content,data,recorded_at AS recordedAt FROM scoped_revisions WHERE message_id=? ORDER BY recorded_at');
    return rows.map(({ internalId, data, ...m }) => ({ ...m, data: data == null ? null : JSON.parse(data), revisions: rev.all(internalId).map((r) => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) })) }));
  }
  function archiveMessagePage(scope, conversationId, { limit, cursor, direction = 'older' }) {
    scope = requireScope(scope);
    if (conversationId != null) requiredString(conversationId, 'conversationId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['older', 'newer', 'oldest'].includes(direction) ||
        (direction === 'oldest' && cursor != null) || (direction === 'newer' && cursor == null)) throw error(400, 'Invalid message page');
    const expected = { v: 1, accountId: scope.accountId, kinId: scope.kinId, conversationId: conversationId ?? null };
    const after = cursor ? decodeMessageCursor(cursor, expected, direction) : null;
    const sort = messageOrderTime('m.');
    const filters = ['m.account_id=?', 'm.kin_id=?'];
    const params = [scope.accountId, scope.kinId];
    if (conversationId != null) { filters.push('m.conversation_id=?'); params.push(conversationId); }
    const total = db.prepare(`SELECT COUNT(*) AS count FROM scoped_messages m WHERE ${filters.join(' AND ')}`).get(...params).count;
    const ascending = direction !== 'older';
    if (after) {
      const op = direction === 'newer' ? '>' : '<';
      filters.push(`(${sort} ${op} ? OR (${sort} = ? AND m.id ${op} ?))`);
      params.push(after.orderTime, after.orderTime, after.id);
    }
    const sql = `SELECT m.account_id AS accountId,m.kin_id AS kinId,m.conversation_id AS conversationId,
      m.source_id AS messageId,m.fingerprint,m.sender,m.timestamp,m.content,m.first_seen AS firstSeen,m.last_seen AS lastSeen,
      m.id AS internalId,${sort} AS orderTime,m.data FROM scoped_messages m WHERE ${filters.join(' AND ')}`;
    // The newest page always contains up to `limit` rows. The oldest page may
    // therefore be shorter; align a direct jump with the same page boundaries.
    const pageSize = direction === 'oldest' ? (total % limit || limit) : limit;
    const order = ascending ? 'ASC' : 'DESC';
    const rows = db.prepare(`${sql} ORDER BY ${sort} ${order},m.id ${order} LIMIT ?`).all(...params, pageSize + 1);
    const more = rows.length > pageSize;
    if (more) rows.pop();
    if (ascending) rows.reverse();
    const revisionMap = new Map(rows.map((row) => [row.internalId, []]));
    if (rows.length) {
      const placeholders = rows.map(() => '?').join(',');
      const revisionSql = `SELECT message_id AS internalId,fingerprint,sender,timestamp,content,data,recorded_at AS recordedAt
        FROM scoped_revisions WHERE message_id IN (${placeholders}) ORDER BY recorded_at,rowid`;
      for (const { internalId, ...revision } of db.prepare(revisionSql).all(...rows.map((row) => row.internalId))) {
        revision.data = revision.data == null ? null : JSON.parse(revision.data);
        revisionMap.get(internalId).push(revision);
      }
    }
    const last = rows.at(-1), first = rows[0];
    const hasOlder = direction === 'older' ? more : direction === 'newer' && !!after;
    const hasNewer = direction === 'older' ? !!after : more;
    const nextCursor = hasOlder && last ? Buffer.from(JSON.stringify({ ...expected, direction: 'older', orderTime: last.orderTime, id: last.internalId })).toString('base64url') : null;
    const newerCursor = hasNewer && first ? Buffer.from(JSON.stringify({ ...expected, direction: 'newer', orderTime: first.orderTime, id: first.internalId })).toString('base64url') : null;
    const messages = rows.map(({ internalId, orderTime: _sortTime, ...message }) => {
      message.data = message.data == null ? null : JSON.parse(message.data);
      return { ...message, revisions: revisionMap.get(internalId) };
    });
    return { messages, nextCursor, newerCursor, total };
  }
  function search(query) {
    return db.prepare(`SELECT m.account_id AS accountId,m.kin_id AS kinId,k.name AS kinName,m.conversation_id AS conversationId,
      m.source_id AS messageId,m.sender,m.timestamp,m.content
      FROM scoped_messages m JOIN kins k ON k.account_id=m.account_id AND k.kin_id=m.kin_id
      WHERE instr(lower(m.content),lower(?)) > 0 ORDER BY m.id DESC LIMIT 100`).all(query);
  }
  // Merge a validated SQLite snapshot a record at a time. The surrounding
  // transaction keeps a failed import from changing the live archive.
  function mergeSnapshot(source) {
    return transact(() => {
      const counts = { inserted: 0, updated: 0, unchanged: 0 };
      const addCounts = value => { for (const key of Object.keys(counts)) counts[key] += value[key] || 0; };
      for (const a of source.prepare('SELECT * FROM accounts').iterate()) upsertAccount({ accountId:a.account_id, displayName:a.display_name, sourceTimestamp:a.source_timestamp, firstSeen:a.first_seen, lastSeen:a.last_seen }, { importing:true });
      for (const k of source.prepare('SELECT * FROM kins').iterate()) upsertKin({ accountId:k.account_id, kinId:k.kin_id, name:k.name, sourceTimestamp:k.source_timestamp, firstSeen:k.first_seen, lastSeen:k.last_seen }, { importing:true });
      for (const c of source.prepare('SELECT * FROM scoped_conversations').iterate()) {
        const v = conversationInput({ accountId:c.account_id, kinId:c.kin_id, id:c.id, firstSeen:c.first_seen, lastSeen:c.last_seen });
        requireScope(v); db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(v.accountId,v.kinId,v.id,v.firstSeen,v.lastSeen);
      }
      for (const b of source.prepare('SELECT sha256,mime,bytes FROM media_blobs').iterate()) media.importBlob(b.sha256,b.mime,b.bytes);
      for (const item of source.prepare('SELECT account_id AS accountId,kin_id AS kinId,kind,source_id AS sourceId,variant,sha256,created_at AS createdAt,prompt,message_id AS messageId,first_seen AS firstSeen,last_seen AS lastSeen FROM media_items').iterate()) media.importItem(item);
      const history = source.prepare('SELECT * FROM kin_profile_history WHERE account_id=? AND kin_id=? AND field=? ORDER BY id');
      for (const row of source.prepare('SELECT * FROM kin_profile_fields').iterate()) {
        const scope = scopeFrom({accountId:row.account_id,kinId:row.kin_id}); requireScope(scope);
        const field = requiredString(row.field, 'profile field');
        const parseEntry = r => profileFieldsInput({ [field]: { value:JSON.parse(r.value_json), observedAt:r.observed_at, recordedAt:r.recorded_at, eventId:r.event_id } }, { importing:true })[0];
        for (const old of history.iterate(scope.accountId,scope.kinId,field)) saveProfileHistory(scope,field,parseEntry(old));
        mergeProfileInside(scope,[parseEntry(row)],{ importing:true });
      }
      const journalHistory = source.prepare('SELECT * FROM journal_revisions WHERE account_id=? AND kin_id=? AND entry_id=?');
      for (const row of source.prepare('SELECT * FROM journal_entries').iterate()) {
        const scope = scopeFrom({accountId:row.account_id,kinId:row.kin_id});
        const entry = journalValue({ entryId:row.entry_id, createdAt:row.created_at, description:row.description, keywords:row.keywords_json == null ? null : JSON.parse(row.keywords_json), origin:row.origin, firstSeen:row.first_seen, lastSeen:row.last_seen }, { importing:true });
        mergeJournalInside(scope,[entry],{ importing:true });
        for (const old of journalHistory.iterate(scope.accountId,scope.kinId,entry.entryId)) {
          const revision = journalValue({ createdAt:old.created_at,description:old.description,keywords:old.keywords_json == null ? null : JSON.parse(old.keywords_json),origin:old.origin,recordedAt:old.recorded_at }, { revision:true });
          const active = journalGet.get(scope.accountId,scope.kinId,entry.entryId);
          if (journalFingerprint(revision) !== journalFingerprint(journalRowValue(active))) journalRevisionInsert.run(scope.accountId,scope.kinId,entry.entryId,journalFingerprint(revision),revision.createdAt,revision.description,revision.keywords == null ? null : JSON.stringify(revision.keywords),revision.origin,revision.recordedAt);
        }
      }
      const scopedRevisions = source.prepare('SELECT * FROM scoped_revisions WHERE message_id=?');
      for (const row of source.prepare('SELECT * FROM scoped_messages').iterate()) {
        const scope=scopeFrom({accountId:row.account_id,kinId:row.kin_id});
        const m=scopedMessage({conversationId:row.conversation_id,messageId:row.source_id,fingerprint:row.fingerprint,sender:row.sender,timestamp:row.timestamp,content:row.content,data:row.data == null ? null : JSON.parse(row.data),firstSeen:row.first_seen,lastSeen:row.last_seen});
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
    const order = ['accounts','kins','scoped_conversations','media_blobs','kin_profile_fields','kin_profile_history','journal_entries','journal_revisions','scoped_messages','scoped_revisions','media_items','media_thumbnails'];
    try {
      return transact(() => {
        if (beforeBackup !== changeStamp()) throw error(409, 'Archive changed during the recovery backup. Retry restore when capture is idle.');
        for (const table of order.slice().reverse()) db.exec(`DELETE FROM main.${table}`);
        for (const table of order) db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`);
      });
    } finally { db.exec('DETACH DATABASE restore_source'); }
  }
  return { db, databasePath, digest, archiveMessagePage, mergeSnapshot, changeStamp, replaceSnapshot, search, upsertAccount, upsertKin, upsertInventory, accounts, kins, scopedProbe, scopedIngest, scopedConversations, scopedArchiveMessages, upsertProfile, readProfile, upsertJournal, journalPage, media };
}
