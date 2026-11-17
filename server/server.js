import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual, randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMediaStore } from './media-store.js';
import { streamPortable, streamBackup, importPortable, restoreBackup } from './portable.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 128 * 1024 * 1024;
const MAX_BATCH = 500;
// Ignore malformed/non-date expressions (notably SQLite's dynamic "now").
const messageOrderTime = (alias = '') => `COALESCE(CASE WHEN substr(${alias}timestamp,5,1)='-' AND substr(${alias}timestamp,8,1)='-' THEN julianday(${alias}timestamp) END, CASE WHEN substr(${alias}first_seen,5,1)='-' AND substr(${alias}first_seen,8,1)='-' THEN julianday(${alias}first_seen) END, 0)`;

function error(status, message) { return Object.assign(new Error(message), { status }); }
function requiredString(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(400, `Invalid ${name}`);
  return value;
}
function optionalString(value, name, max = 2048) {
  return value == null ? null : requiredString(value, name, max);
}
function validateMessage(raw, probe = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error(400, 'Invalid message');
  const base = {
    conversationId: requiredString(raw.conversationId, 'conversationId'),
    messageId: optionalString(raw.messageId, 'messageId'),
    fingerprint: requiredString(raw.fingerprint, 'fingerprint'),
  };
  if (probe) return base;
  if (typeof raw.content !== 'string' || raw.content.length > 1_000_000) throw error(400, 'Invalid content');
  return { ...base, kinId: optionalString(raw.kinId, 'kinId'), kinName: optionalString(raw.kinName, 'kinName'), sender: optionalString(raw.sender, 'sender'), timestamp: optionalString(raw.timestamp, 'timestamp'), content: raw.content,
    firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen') };
}
function parseBatch(body, probe = false) {
  if (!body || !Array.isArray(body.messages) || body.messages.length > MAX_BATCH) throw error(400, `Expected up to ${MAX_BATCH} messages`);
  return body.messages.map((message) => {
    if (message?.accountId != null) throw error(400, 'Scoped messages require accountId and kinId on the batch');
    return validateMessage(message, probe);
  });
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, `Invalid ${name}`);
  return value;
}
function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw error(400, `Unexpected ${name} field: ${key}`);
}
function downloadTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:Z|([+-])(\d{2})-(\d{2}))$/.exec(value);
  if (!match) throw error(400, 'Invalid download timestamp');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
      (sign && (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)))) {
    throw error(400, 'Invalid download timestamp');
  }
  return value;
}
function accountInput(raw) {
  object(raw, 'account');
  onlyKeys(raw, ['accountId', 'displayName', 'sourceTimestamp', 'firstSeen', 'lastSeen'], 'account');
  return { accountId: requiredString(raw.accountId, 'accountId'), displayName: optionalString(raw.displayName, 'displayName'), sourceTimestamp: optionalString(raw.sourceTimestamp, 'sourceTimestamp'), firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen') };
}
function kinInput(raw) {
  object(raw, 'Kin');
  onlyKeys(raw, ['accountId', 'kinId', 'name', 'sourceTimestamp', 'firstSeen', 'lastSeen'], 'Kin');
  return { accountId: requiredString(raw.accountId, 'accountId'), kinId: requiredString(raw.kinId, 'kinId'), name: optionalString(raw.name, 'name'), sourceTimestamp: optionalString(raw.sourceTimestamp, 'sourceTimestamp'), firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen') };
}
function conversationInput(raw, scoped = false) {
  object(raw, 'conversation');
  onlyKeys(raw, scoped ? ['accountId', 'kinId', 'id', 'firstSeen', 'lastSeen', 'messageCount'] : ['id', 'kinId', 'kinName', 'firstSeen', 'lastSeen', 'messageCount'], 'conversation');
  const value = { id: requiredString(raw.id, 'conversation id'), firstSeen: requiredString(raw.firstSeen, 'conversation firstSeen'), lastSeen: requiredString(raw.lastSeen, 'conversation lastSeen') };
  if (scoped) return { ...scopeFrom(raw), ...value };
  return { ...value, kinId: optionalString(raw.kinId, 'conversation kinId'), kinName: optionalString(raw.kinName, 'conversation kinName') };
}
function messageData(value) {
  if (value == null) return null;
  object(value, 'message data');
  onlyKeys(value, ['persona', 'reactions', 'chatHistoryRecordId', 'senderAiId', 'reactionsRevision', 'captureSource'], 'message data');
  const data = {};
  if (value.persona != null) data.persona = requiredString(value.persona, 'persona', 100_000);
  if (value.chatHistoryRecordId != null) data.chatHistoryRecordId = requiredString(value.chatHistoryRecordId, 'chatHistoryRecordId');
  if (value.senderAiId != null) data.senderAiId = requiredString(value.senderAiId, 'senderAiId');
  if (value.reactionsRevision != null) {
    if (!Number.isSafeInteger(value.reactionsRevision) || value.reactionsRevision < 0) throw error(400, 'Invalid reactionsRevision');
    data.reactionsRevision = value.reactionsRevision;
  }
  if (value.captureSource != null) {
    if (!['dom', 'history', 'cache'].includes(value.captureSource)) throw error(400, 'Invalid captureSource');
    data.captureSource = value.captureSource;
  }
  if (value.reactions != null) {
    if (!Array.isArray(value.reactions)) {
      object(value.reactions, 'reactions');
      const entries = Object.entries(value.reactions);
      if (entries.length > 1000) throw error(400, 'Invalid reactions');
      data.reactions = Object.create(null);
      for (const [actor, emoji] of entries) {
        requiredString(actor, 'reaction actor', 2048);
        if (/token|password|cookie|authorization|secret/i.test(actor)) throw error(400, 'Invalid reaction actor');
        data.reactions[actor] = requiredString(emoji, 'reaction emoji', 128);
      }
    } else {
      if (value.reactions.length > 1000) throw error(400, 'Invalid reactions');
      data.reactions = value.reactions.map((reaction) => {
      if (typeof reaction === 'string') return requiredString(reaction, 'reaction', 2048);
      object(reaction, 'reaction'); onlyKeys(reaction, ['name', 'emoji', 'count'], 'reaction');
      const out = {};
      if (reaction.name != null) out.name = requiredString(reaction.name, 'reaction name');
      if (reaction.emoji != null) out.emoji = requiredString(reaction.emoji, 'reaction emoji');
      if (reaction.count != null) {
        if (!Number.isSafeInteger(reaction.count) || reaction.count < 0) throw error(400, 'Invalid reaction count');
        out.count = reaction.count;
      }
      return out;
      });
    }
  }
  return data;
}
function scopedMessage(raw, probe = false, importing = false) {
  object(raw, 'message');
  onlyKeys(raw, ['accountId', 'kinId', 'conversationId', 'messageId', 'fingerprint', ...(probe ? ['captureSource'] : ['sender', 'timestamp', 'content', 'data', 'firstSeen', 'lastSeen', ...(importing ? ['revisions'] : [])])], 'message');
  const { kinId: _kinId, kinName: _kinName, ...m } = validateMessage(raw, probe);
  if (probe && raw.captureSource != null) {
    if (!['dom', 'history', 'cache'].includes(raw.captureSource)) throw error(400, 'Invalid captureSource');
    m.captureSource = raw.captureSource;
  }
  if (!probe) m.data = messageData(raw.data);
  return m;
}
function scopeFrom(body, { allowLegacy = false } = {}) {
  object(body, 'scope');
  if (!Object.hasOwn(body, 'accountId') && !Object.hasOwn(body, 'kinId') && allowLegacy) return null;
  return { accountId: requiredString(body.accountId, 'accountId'), kinId: requiredString(body.kinId, 'kinId') };
}
const PROFILE_FIELDS = Object.freeze({
  ai_backstory: 'string', ai_memory: 'string', ai_directive: 'string', ai_example_message: 'string',
  ai_backstory_plaintext: 'string', ai_memory_plaintext: 'string', ai_directive_plaintext: 'string',
  ai_example_message_plaintext: 'string', current_scene_plaintext: 'string',
  developed_context_v1: 'string', developed_context_previous_v1: 'string', ai_name: 'string', voice_model: 'string',
  voice_call_directive: 'string', llm_flair: 'string', reasoning_effort: 'string', custom_avatar_description: 'string',
  custom_avatar_face_prompt: 'string', current_scene: 'string', default_room_bio: 'string', legacy_llm_model: 'string',
  legacy_selfies_model: 'string', video_model: 'string', auto_journal_day: 'string', proactive_engine: 'string',
  selected_voice: 'number', user_set_temperature: 'number', custom_avatar_fidelity: 'number', custom_avatar_face_detail: 'number',
  time_awareness: 'boolean', ai_reactions_enabled: 'boolean', avatar_is_anime: 'boolean', proactive_mode: 'boolean',
  live_tool_mode: 'boolean', disable_ltm_recall: 'boolean', disable_ltm_consolidate: 'boolean', has_cascade_memory: 'boolean',
  voice_call_use_fast_voice: 'boolean', voice_call_unified_context: 'boolean',
});
function profileValue(field, value) {
  if (!Object.hasOwn(PROFILE_FIELDS, field)) throw error(400, `Unsupported profile field: ${field}`);
  const type = PROFILE_FIELDS[field];
  if (value === null) return null;
  if (typeof value !== type || (type === 'string' && value.length > 1_000_000) || (type === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000))) throw error(400, `Invalid value for ${field}`);
  return value;
}
function profileDate(value, field, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw error(400, `Invalid ${field}`);
  return new Date(value).toISOString();
}
function journalValue(raw, { importing = false, revision = false } = {}) {
  object(raw, 'journal entry');
  onlyKeys(raw, ['createdAt', 'description', 'keywords', 'origin', ...(revision ? ['recordedAt'] : ['entryId', ...(importing ? ['accountId', 'kinId', 'firstSeen', 'lastSeen', 'revisions'] : [])])], 'journal entry');
  const createdAt = profileDate(raw.createdAt, 'journal createdAt');
  const description = requiredString(raw.description, 'journal description', 1_000_000);
  let keywords = null;
  if (raw.keywords != null) {
    if (!Array.isArray(raw.keywords) || raw.keywords.length > 1000) throw error(400, 'Invalid journal keywords');
    keywords = raw.keywords.map(word => requiredString(word, 'journal keyword', 2048));
  }
  const origin = optionalString(raw.origin, 'journal origin', 2048);
  const value = { createdAt, description, keywords, origin };
  if (revision) return { ...value, recordedAt: profileDate(raw.recordedAt, 'journal recordedAt') };
  const entry = { entryId: requiredString(raw.entryId, 'journal entryId'), ...value };
  if (importing) {
    entry.firstSeen = profileDate(raw.firstSeen, 'journal firstSeen');
    entry.lastSeen = profileDate(raw.lastSeen, 'journal lastSeen');
    if (entry.firstSeen > entry.lastSeen) throw error(400, 'Invalid journal observation range');
    if (!Array.isArray(raw.revisions) || raw.revisions.length > 10000) throw error(400, 'Invalid journal revisions');
    entry.revisions = raw.revisions.map(item => journalValue(item, { revision: true }));
  }
  return entry;
}
function journalFingerprint(entry) {
  return createHash('sha256').update(JSON.stringify([entry.createdAt, entry.description, entry.keywords, entry.origin])).digest('hex');
}
function profileFieldsInput(raw, { importing = false } = {}) {
  object(raw, 'profile fields');
  const fields = Object.entries(raw);
  if (fields.length > Object.keys(PROFILE_FIELDS).length) throw error(400, 'Too many profile fields');
  return fields.map(([field, input]) => {
    object(input, `profile ${field}`);
    onlyKeys(input, importing ? ['value', 'observedAt', 'recordedAt', 'eventId', 'history'] : ['value', 'observedAt'], `profile ${field}`);
    if (!Object.hasOwn(input, 'value')) throw error(400, `Missing value for ${field}`);
    const value = profileValue(field, input.value);
    const observedAt = profileDate(input.observedAt, 'observedAt', { optional: true });
    const recordedAt = importing ? profileDate(input.recordedAt, 'recordedAt') : null;
    const eventId = importing ? requiredString(input.eventId, 'profile eventId', 128) : null;
    if (importing && input.history != null && (!Array.isArray(input.history) || input.history.length > 10000)) throw error(400, 'Invalid profile history');
    const history = !importing ? [] : (input.history || []).map((entry) => {
      object(entry, 'profile history'); onlyKeys(entry, ['value', 'observedAt', 'recordedAt', 'eventId'], 'profile history');
      if (!Object.hasOwn(entry, 'value')) throw error(400, 'Missing profile history value');
      return { value: profileValue(field, entry.value), observedAt: profileDate(entry.observedAt, 'observedAt', { optional: true }), recordedAt: profileDate(entry.recordedAt, 'recordedAt'), eventId: requiredString(entry.eventId, 'profile history eventId', 128) };
    });
    return { field, value, observedAt, recordedAt, eventId, history };
  });
}
function scopedBatch(body, probe) {
  const scope = scopeFrom(body);
  if (!Array.isArray(body.messages) || body.messages.length > MAX_BATCH) throw error(400, `Expected up to ${MAX_BATCH} messages`);
  const messages = body.messages.map((raw) => {
    if ((raw?.accountId != null && raw.accountId !== scope.accountId) || (raw?.kinId != null && raw.kinId !== scope.kinId)) throw error(400, 'Message scope does not match batch scope');
    return scopedMessage(raw, probe);
  });
  return { scope, messages };
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
function parseMessagePage(query) {
  if (!query.has('limit') && !query.has('cursor') && !query.has('direction')) return null;
  const value = query.get('limit');
  if (value !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) throw error(400, 'Invalid message page limit');
  const cursor = query.get('cursor');
  if (cursor !== null && !cursor) throw error(400, 'Invalid message cursor');
  const direction = query.get('direction') ?? 'older';
  if (!['older', 'newer', 'oldest'].includes(direction) || (direction === 'oldest' && cursor !== null) || (direction === 'newer' && cursor === null)) throw error(400, 'Invalid message page direction');
  return { limit: value === null ? 50 : Number(value), cursor, direction };
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
  function findScoped(scope, message) {
    if (message.messageId) return db.prepare('SELECT * FROM scoped_messages WHERE account_id=? AND kin_id=? AND conversation_id=? AND source_id=?').get(scope.accountId, scope.kinId, message.conversationId, message.messageId);
    return db.prepare('SELECT * FROM scoped_messages WHERE account_id=? AND kin_id=? AND conversation_id=? AND source_id IS NULL AND fingerprint=?').get(scope.accountId, scope.kinId, message.conversationId, message.fingerprint);
  }
  function scopedProbe(scope, messages) {
    scope = requireScope(scope);
    messages = messages.map((m) => scopedMessage(m, true));
    return { results: messages.map((m) => {
      const row = findScoped(scope, m);
      if (!row) return { status: 'missing' };
      const source = row.data ? JSON.parse(row.data).captureSource : undefined;
      const rank = (value) => value === 'dom' ? 0 : value === 'history' ? 1 : 2;
      if (m.captureSource && rank(m.captureSource) < rank(source)) return { status: 'unchanged' };
      if (m.captureSource && rank(m.captureSource) > rank(source)) return { status: 'changed' };
      return { status: row.fingerprint === m.fingerprint ? 'unchanged' : 'changed' };
    }) };
  }
  const scopedRevisionInsert = db.prepare('INSERT OR IGNORE INTO scoped_revisions (message_id,fingerprint,sender,timestamp,content,data,recorded_at) VALUES(?,?,?,?,?,?,?)');
  function scopedIngestInside(scope, messages, { importing = false } = {}) {
    scope = requireScope(scope); const counts = { inserted: 0, updated: 0, unchanged: 0 }; const now = new Date().toISOString();
    for (const m of messages) {
      if (importing) db.prepare('INSERT OR IGNORE INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)').run(scope.accountId,scope.kinId,m.conversationId,m.firstSeen || now,m.lastSeen || now);
      else db.prepare(`INSERT INTO scoped_conversations(account_id,kin_id,id,first_seen,last_seen) VALUES(?,?,?,?,?)
        ON CONFLICT(account_id,kin_id,id) DO UPDATE SET last_seen=excluded.last_seen`).run(scope.accountId, scope.kinId, m.conversationId, m.firstSeen || now, m.lastSeen || now);
      const old = findScoped(scope, m); const data = m.data == null ? null : JSON.stringify(m.data);
      const oldSource = old?.data ? JSON.parse(old.data).captureSource : undefined;
      const newSource = m.data?.captureSource;
      // Unknown/imported sources retain the existing highest-priority behavior.
      const rank = (value) => value === 'dom' ? 0 : value === 'history' ? 1 : 2;
      if (!old) {
        db.prepare('INSERT INTO scoped_messages(account_id,kin_id,conversation_id,source_id,fingerprint,sender,timestamp,content,data,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(scope.accountId, scope.kinId, m.conversationId, m.messageId, m.fingerprint, m.sender, m.timestamp, m.content, data, m.firstSeen || now, m.lastSeen || now); counts.inserted++;
      } else if (newSource && rank(newSource) < rank(oldSource)) {
        // Do not replace original text with a less reliable observation.
        counts.unchanged++;
      } else if (old.fingerprint !== m.fingerprint || (newSource && rank(newSource) > rank(oldSource))) {
        const current = { lastSeen: old.last_seen };
        if (importing && !newerSnapshot(current, m)) {
          scopedRevisionInsert.run(old.id, m.fingerprint, m.sender, m.timestamp, m.content, data, m.lastSeen || now); counts.unchanged++;
        } else {
          // Preserve different observed DOM text with its source tag; consumers can
          // distinguish this observation from a genuine edit in canonical data.
          if (!(newSource && rank(newSource) > rank(oldSource)) || old.content !== m.content) scopedRevisionInsert.run(old.id, old.fingerprint, old.sender, old.timestamp, old.content, old.data, now);
          db.prepare('UPDATE scoped_messages SET fingerprint=?,sender=?,timestamp=?,content=?,data=?,last_seen=? WHERE id=?').run(m.fingerprint, m.sender, m.timestamp, m.content, data, importing && m.lastSeen ? m.lastSeen : now, old.id); counts.updated++;
        }
      } else counts.unchanged++;
    }
    return counts;
  }
  function scopedIngest(scope, messages) { return transact(() => scopedIngestInside(scope, messages.map((m) => scopedMessage(m)))); }
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
  function replaceSnapshot(path) {
    db.prepare('ATTACH DATABASE ? AS restore_source').run(path);
    const order = ['accounts','kins','conversations','scoped_conversations','media_blobs','kin_profile_fields','kin_profile_history','journal_entries','journal_revisions','messages','revisions','scoped_messages','scoped_revisions','media_items','media_thumbnails'];
    try {
      return transact(() => {
        for (const table of order.slice().reverse()) db.exec(`DELETE FROM main.${table}`);
        for (const table of order) db.exec(`INSERT INTO main.${table} SELECT * FROM restore_source.${table}`);
      });
    } finally { db.exec('DETACH DATABASE restore_source'); }
  }
  return { db, databasePath, probe, ingest, digest, conversations, archiveMessages, archiveMessagePage, exportArchive, importArchive, mergeSnapshot, replaceSnapshot, search, upsertAccount, upsertKin, accounts, kins, scopedProbe, scopedIngest, scopedConversations, scopedArchiveMessages, upsertProfile, readProfile, upsertJournal, journalPage, media };
}

function validToken(provided, expected) {
  if (typeof provided !== 'string' || !provided.startsWith('Bearer ')) return false;
  const a = Buffer.from(provided.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let finished = false;
    const fail = (err) => { if (finished) return; finished = true; chunks.length = 0; reject(err); };
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) { fail(error(413, 'Request too large')); req.resume(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(error(400, 'Invalid JSON')); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(error(400, 'Request aborted')));
    // Reject a known oversized body immediately, without waiting for the sender.
    const length = req.headers?.['content-length'];
    if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > limit) {
      fail(error(413, 'Request too large')); req.resume();
    }
  });
}
function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.png', ['favicon.png', 'image/png']],
  ['/fonts/InterVariable.woff2', ['fonts/InterVariable.woff2', 'font/woff2']],
  ['/fonts/InterVariable-Italic.woff2', ['fonts/InterVariable-Italic.woff2', 'font/woff2']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['messages', 'personality', 'journal', 'images', 'settings', 'download', 'upload', 'refresh', 'search', 'lock', 'arrow-up']
    .map(name => [`/icons/${name}.svg`, [`icons/${name}.svg`, 'image/svg+xml']]),
]);
export function createHttpServer({ archive, token, allowedHosts = ['127.0.0.1', 'localhost', '::1'] }) {
  const tickets = new Map();
  let transferBusy = false;
  async function transfer(fn) {
    if (transferBusy) throw error(409, 'Another archive transfer is in progress.');
    transferBusy = true;
    try { return await fn(); } finally { transferBusy = false; }
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // A restrictive Host allowlist prevents a hostile DNS name from rebinding to the local archive.
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
      catch { return sendJson(res, 400, { error: 'Invalid host' }); }
      if (!allowedHosts.includes(hostname)) return sendJson(res, 403, { error: 'Host not allowed' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(publicDir, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok' });
      if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (req.method === 'GET' && ['/api/download/portable','/api/download/sqlite'].includes(url.pathname)) {
        const value = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('kinexport_download='))?.slice('kinexport_download='.length);
        const ticket = value ? tickets.get(value) : null;
        if (value) tickets.delete(value);
        const format = url.pathname.endsWith('/portable') ? 'portable' : 'sqlite';
        const validTicket = ticket && ticket.expires >= Date.now() && ticket.format === format ? ticket : null;
        if (!validToken(req.headers.authorization, token) && !validTicket) return sendJson(res, 401, { error:'Unauthorized' });
        res.setHeader('Set-Cookie','kinexport_download=; Path=/api/download; Max-Age=0; HttpOnly; SameSite=Strict');
        return await transfer(() => format === 'portable' ? streamPortable(archive,res,validTicket?.timestamp) : streamBackup(archive,res,validTicket?.timestamp));
      }
      if (!validToken(req.headers.authorization, token)) return sendJson(res, 401, { error: 'Unauthorized' });
      const contentType = req.headers['content-type']?.split(';')[0].trim();
      if (req.method === 'POST' && url.pathname === '/api/import/portable') {
        if (contentType !== 'application/zip') throw error(415, 'Expected application/zip');
        return sendJson(res,200,await transfer(() => importPortable(archive,req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/restore/sqlite') {
        if (contentType !== 'application/vnd.sqlite3') throw error(415, 'Expected application/vnd.sqlite3');
        return sendJson(res,200,await transfer(() => restoreBackup(archive,req,createArchive)));
      }
      if (req.method === 'POST' && contentType !== 'application/json') throw error(415, 'Expected application/json');
      if (req.method === 'POST' && url.pathname === '/api/download-ticket') {
        const body=await readJson(req); object(body,'download'); onlyKeys(body,['format','timestamp'],'download');
        if (!['portable','sqlite'].includes(body.format)) throw error(400,'Invalid download format');
        const timestamp = Object.hasOwn(body,'timestamp') ? downloadTimestamp(body.timestamp) : undefined;
        if (transferBusy) throw error(409,'Another archive transfer is in progress.');
        const now=Date.now(); for (const [key,ticket] of tickets) if (ticket.expires < now) tickets.delete(key);
        if (tickets.size >= 20) throw error(429,'Too many pending downloads.');
        const value=randomBytes(32).toString('base64url'); tickets.set(value,{format:body.format,timestamp,expires:now+120_000});
        return sendJson(res,200,{ok:true},{'Set-Cookie':`kinexport_download=${value}; Path=/api/download; Max-Age=120; HttpOnly; SameSite=Strict`});
      }
      if (req.method === 'POST' && url.pathname === '/api/accounts') return sendJson(res, 200, { account: archive.upsertAccount(await readJson(req)) });
      if (req.method === 'POST' && url.pathname === '/api/kins') return sendJson(res, 200, { kin: archive.upsertKin(await readJson(req)) });
      if (req.method === 'POST' && url.pathname === '/api/kins/profile') return sendJson(res, 200, archive.upsertProfile(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/kins/media') {
        const body = await readJson(req); object(body, 'media batch'); onlyKeys(body, ['accountId', 'kinId', 'items'], 'media batch');
        return sendJson(res, 200, archive.media.save(scopeFrom(body), body.items));
      }
      if (req.method === 'GET' && url.pathname === '/api/kins/media') {
        const limit=url.searchParams.get('limit'), offset=url.searchParams.get('offset');
        if ((limit !== null && !/^\d+$/.test(limit)) || (offset !== null && !/^\d+$/.test(offset))) throw error(400, 'Invalid media page');
        return sendJson(res, 200, archive.media.list(scopeFrom(Object.fromEntries(url.searchParams)), limit===null?50:Number(limit), offset===null?0:Number(offset)));
      }
      if (req.method === 'GET' && url.pathname === '/api/media/blob') {
        const blob=archive.media.blob(url.searchParams.get('sha256'));
        if (!blob) return sendJson(res, 404, {error:'Media not found'});
        res.writeHead(200, {'Content-Type':blob.mime,'Content-Length':blob.bytes.length,'Cache-Control':'no-store'}); return res.end(blob.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/media/thumbnail') {
        const thumbnail = await archive.media.thumbnail(url.searchParams.get('sha256'));
        if (!thumbnail) return sendJson(res, 404, {error:'Media not found'});
        res.writeHead(200, {'Content-Type':thumbnail.mime,'Content-Length':thumbnail.bytes.length,'Cache-Control':'no-store'}); return res.end(thumbnail.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/kins/profile') return sendJson(res, 200, archive.readProfile(scopeFrom(Object.fromEntries(url.searchParams))));
      if (req.method === 'POST' && url.pathname === '/api/kins/journal') return sendJson(res, 200, archive.upsertJournal(await readJson(req)));
      if (req.method === 'GET' && url.pathname === '/api/kins/journal') {
        const limit = url.searchParams.get('limit'); const offset = url.searchParams.get('offset');
        if ((limit !== null && !/^\d+$/.test(limit)) || (offset !== null && !/^\d+$/.test(offset))) throw error(400, 'Invalid journal page');
        return sendJson(res, 200, archive.journalPage(scopeFrom(Object.fromEntries(url.searchParams)), limit === null ? 50 : Number(limit), offset === null ? 0 : Number(offset)));
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') return sendJson(res, 200, { accounts: archive.accounts() });
      if (req.method === 'GET' && url.pathname === '/api/kins') return sendJson(res, 200, { kins: archive.kins(requiredString(url.searchParams.get('accountId'), 'accountId')) });
      if (req.method === 'POST' && (url.pathname === '/api/probe' || url.pathname === '/api/messages')) {
        const body = await readJson(req); const probe = url.pathname === '/api/probe'; const scope = scopeFrom(body, { allowLegacy: true });
        if (!scope) return sendJson(res, 200, probe ? archive.probe(parseBatch(body, true)) : archive.ingest(parseBatch(body)));
        const batch = scopedBatch(body, probe);
        return sendJson(res, 200, probe ? archive.scopedProbe(scope, batch.messages) : archive.scopedIngest(scope, batch.messages));
      }
      if (req.method === 'GET' && url.pathname === '/api/digest') return sendJson(res, 200, archive.digest());
      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        const scope = scopeFrom(Object.fromEntries(url.searchParams), { allowLegacy: true });
        return sendJson(res, 200, { conversations: scope ? archive.scopedConversations(scope) : archive.conversations() });
      }
      if (req.method === 'GET' && url.pathname === '/api/search') return sendJson(res, 200, { messages: archive.search(requiredString(url.searchParams.get('q'), 'search query', 500)) });
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const scope = scopeFrom(Object.fromEntries(url.searchParams), { allowLegacy: true });
        const conversationId = url.searchParams.get('conversationId');
        const page = parseMessagePage(url.searchParams);
        if (page) return sendJson(res, 200, archive.archiveMessagePage(scope, conversationId, page));
        return sendJson(res, 200, { messages: scope ? archive.scopedArchiveMessages(scope, conversationId) : archive.archiveMessages(conversationId) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(e); return; }
      // An oversized request may still be streaming. Send the 413 and close the
      // connection instead of keeping it open for an arbitrary remaining body.
      if (e.status === 413) { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); }
      if (!e.status) console.error('[KinExport] Server error:', e.message);
      return sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal server error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.KINEXPORT_TOKEN;
  if (!token || token.length < 32) throw new Error('KINEXPORT_TOKEN must be at least 32 characters');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8765);
  const archive = createArchive({ databasePath: process.env.DATABASE_PATH || './data/kinexport.sqlite', token });
  const allowedHosts = (process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,::1').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  createHttpServer({ archive, token, allowedHosts }).listen(port, host, () => console.log(`KinExport archive listening on ${host}:${port}`));
}
