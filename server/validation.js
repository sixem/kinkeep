export const MAX_BODY = 128 * 1024 * 1024;
export const MAX_BATCH = 500;

export function error(status, message) { return Object.assign(new Error(message), { status }); }
export function requiredString(value, name, max = 2048) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw error(400, `Invalid ${name}`);
  return value;
}
export function optionalString(value, name, max = 2048) {
  return value == null ? null : requiredString(value, name, max);
}
export function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, `Invalid ${name}`);
  return value;
}
export function onlyKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw error(400, `Unexpected ${name} field: ${key}`);
}

export function accountInput(raw) {
  object(raw, 'account');
  onlyKeys(raw, ['accountId', 'displayName', 'sourceTimestamp', 'firstSeen', 'lastSeen'], 'account');
  return { accountId: requiredString(raw.accountId, 'accountId'), displayName: optionalString(raw.displayName, 'displayName'), sourceTimestamp: optionalString(raw.sourceTimestamp, 'sourceTimestamp'), firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen') };
}
export function kinInput(raw) {
  object(raw, 'Kin');
  onlyKeys(raw, ['accountId', 'kinId', 'name', 'sourceTimestamp', 'firstSeen', 'lastSeen'], 'Kin');
  return { accountId: requiredString(raw.accountId, 'accountId'), kinId: requiredString(raw.kinId, 'kinId'), name: optionalString(raw.name, 'name'), sourceTimestamp: optionalString(raw.sourceTimestamp, 'sourceTimestamp'), firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen') };
}
export function conversationInput(raw) {
  object(raw, 'conversation');
  onlyKeys(raw, ['accountId', 'kinId', 'id', 'firstSeen', 'lastSeen'], 'conversation');
  return {
    ...scopeFrom(raw), id: requiredString(raw.id, 'conversation id'),
    firstSeen: requiredString(raw.firstSeen, 'conversation firstSeen'), lastSeen: requiredString(raw.lastSeen, 'conversation lastSeen'),
  };
}
export function messageData(value) {
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
    object(value.reactions, 'reactions');
    const entries = Object.entries(value.reactions);
    if (entries.length > 1000) throw error(400, 'Invalid reactions');
    data.reactions = Object.create(null);
    for (const [actor, emoji] of entries) {
      requiredString(actor, 'reaction actor', 2048);
      if (/token|password|cookie|authorization|secret/i.test(actor)) throw error(400, 'Invalid reaction actor');
      data.reactions[actor] = requiredString(emoji, 'reaction emoji', 128);
    }
  }
  return data;
}
export function scopedMessage(raw, probe = false) {
  object(raw, 'message');
  onlyKeys(raw, ['accountId', 'kinId', 'conversationId', 'messageId', 'fingerprint', ...(probe ? ['captureSource'] : ['sender', 'timestamp', 'content', 'data', 'firstSeen', 'lastSeen'])], 'message');
  const message = {
    conversationId: requiredString(raw.conversationId, 'conversationId'),
    messageId: optionalString(raw.messageId, 'messageId'),
    fingerprint: requiredString(raw.fingerprint, 'fingerprint'),
  };
  if (probe) {
    if (raw.captureSource != null) {
      if (!['dom', 'history', 'cache'].includes(raw.captureSource)) throw error(400, 'Invalid captureSource');
      message.captureSource = raw.captureSource;
    }
    return message;
  }
  if (typeof raw.content !== 'string' || raw.content.length > 1_000_000) throw error(400, 'Invalid content');
  return {
    ...message, sender: optionalString(raw.sender, 'sender'), timestamp: optionalString(raw.timestamp, 'timestamp'),
    content: raw.content, firstSeen: optionalString(raw.firstSeen, 'firstSeen'), lastSeen: optionalString(raw.lastSeen, 'lastSeen'),
    data: messageData(raw.data),
  };
}
export function scopeFrom(body) {
  object(body, 'scope');
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
export function journalValue(raw, { importing = false, revision = false } = {}) {
  object(raw, 'journal entry');
  onlyKeys(raw, ['createdAt', 'description', 'keywords', 'origin', ...(revision ? ['recordedAt'] : ['entryId', ...(importing ? ['accountId', 'kinId', 'firstSeen', 'lastSeen'] : [])])], 'journal entry');
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
  }
  return entry;
}

export function profileFieldsInput(raw, { importing = false } = {}) {
  object(raw, 'profile fields');
  const fields = Object.entries(raw);
  if (fields.length > Object.keys(PROFILE_FIELDS).length) throw error(400, 'Too many profile fields');
  return fields.map(([field, input]) => {
    object(input, `profile ${field}`);
    onlyKeys(input, importing ? ['value', 'observedAt', 'recordedAt', 'eventId'] : ['value', 'observedAt'], `profile ${field}`);
    if (!Object.hasOwn(input, 'value')) throw error(400, `Missing value for ${field}`);
    const value = profileValue(field, input.value);
    const observedAt = profileDate(input.observedAt, 'observedAt', { optional: true });
    const recordedAt = importing ? profileDate(input.recordedAt, 'recordedAt') : null;
    const eventId = importing ? requiredString(input.eventId, 'profile eventId', 128) : null;
    return { field, value, observedAt, recordedAt, eventId };
  });
}
export function scopedBatch(scope, messages, probe = false) {
  if (!Array.isArray(messages) || messages.length > MAX_BATCH) throw error(400, `Expected up to ${MAX_BATCH} messages`);
  return messages.map((raw) => {
    if ((raw?.accountId != null && raw.accountId !== scope.accountId) || (raw?.kinId != null && raw.kinId !== scope.kinId)) throw error(400, 'Message scope does not match batch scope');
    return scopedMessage(raw, probe);
  });
}
