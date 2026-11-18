// Extract only fields whose meaning was verified in Kindroid's local cache.
(() => {
  const isId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
  // Kindroid assigns local UUIDs to optimistic messages before they receive a
  // persistent source ID. Their timestamps and IDs are not archive identities.
  const isProvisionalMessageId = value => typeof value === 'string' && /^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const keyIs = (key, ...parts) => Array.isArray(key) && parts.every((part, index) => key[index] === part);
  function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    return value;
  }
  async function fingerprint(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(stable(value)));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map(part => part.toString(16).padStart(2, '0')).join('');
  }
  async function extract(uid, caches) {
    const scope = KinKeepCache.accountScope(uid, caches);
    if (scope.state !== 'ready') return scope;
    const { queries, kinIds: ids } = scope;
    const known = new Set(ids);
    const names = new Map();
    function considerName(doc, updatedAt) {
      if (doc?.uid !== uid || !known.has(doc?.ai_id) || typeof doc?.ai_name !== 'string' || !doc.ai_name.trim() || doc.ai_name.length > 2048) return;
      const previous = names.get(doc.ai_id);
      if (!previous || updatedAt > previous.updatedAt) names.set(doc.ai_id, { value: doc.ai_name, updatedAt });
      else if (updatedAt === previous.updatedAt && previous.value !== doc.ai_name) names.set(doc.ai_id, { value: null, updatedAt });
    }
    for (const query of queries) {
      const key = query?.queryKey;
      if (!keyIs(key, 'v2', 'kins', uid)) continue;
      const updatedAt = Number.isFinite(query.state?.dataUpdatedAt) ? query.state.dataUpdatedAt : 0;
      const data = query.state?.data;
      if (key[3] === 'page' && Array.isArray(data?.pages)) {
        for (const page of data.pages) if (Array.isArray(page?.docs)) for (const doc of page.docs) considerName(doc, updatedAt);
      } else if (key[3] === 'summaries-by-ids' && Array.isArray(data)) {
        for (const doc of data) considerName(doc, updatedAt);
      } else if (key.length === 4 && known.has(key[3]) && data?.ai_id === key[3]) considerName(data, updatedAt);
    }
    const profileResult = KinKeepProfiles.extractProfiles(uid, ids, queries);
    const kins = ids.map(kinId => ({ accountId: uid, kinId, ...(names.get(kinId)?.value ? { name: names.get(kinId).value } : {}) }));
    let incompleteFields = 0;
    const recordsByKin = new Map(ids.map(id => [id, new Map()]));
    const cacheIds = new Map(ids.map(id => [id, new Set()]));
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 4 || !keyIs(key, 'v2', 'chat-messages', uid) || !known.has(key[3]) || !Array.isArray(query.state?.data)) continue;
      const byId = recordsByKin.get(key[3]);
      for (const record of query.state.data) {
        if (isId(record?.id) && !isProvisionalMessageId(record.id)) cacheIds.get(key[3]).add(record.id);
        if (!isId(record?.id) || isProvisionalMessageId(record.id) || typeof record.text !== 'string' || record.text.length > 1_000_000 || typeof record.isSelf !== 'boolean' || !Number.isFinite(record.timestamp)) continue;
        const date = new Date(record.timestamp);
        if (!Number.isFinite(date.getTime()) || record.timestamp < 1_000_000_000_000) continue;
        const data = { captureSource: 'cache' };
        if (typeof record.persona === 'string' && record.persona.trim() && record.persona.length <= 100_000) data.persona = record.persona;
        if (record.reactions != null) {
          const value = record.reactions;
          const valid = typeof value === 'object' && !Array.isArray(value) && Object.entries(value).length <= 1000 &&
            Object.entries(value).every(([actor, emoji]) => isId(actor) && !/token|password|cookie|authorization|secret/i.test(actor) && typeof emoji === 'string' && emoji.trim() && emoji.length <= 128);
          if (valid) data.reactions = Object.fromEntries(Object.entries(value));
          else incompleteFields++;
        }
        if (isId(record.chatHistoryRecordId)) data.chatHistoryRecordId = record.chatHistoryRecordId;
        if (isId(record.senderAiId)) data.senderAiId = record.senderAiId;
        if (Number.isSafeInteger(record.reactionsRevision) && record.reactionsRevision >= 0) data.reactionsRevision = record.reactionsRevision;
        const message = { conversationId: 'observed-main', messageId: record.id, sender: record.isSelf ? 'user' : 'kin', timestamp: date.toISOString(), content: record.text, data };
        const signature = JSON.stringify(stable(message));
        const previous = byId.get(record.id);
        // If the same ID appears with conflicting cached versions, skip it until
        // the cache is unambiguous rather than guessing which version is newer.
        if (!previous) byId.set(record.id, { message, signature, conflicting: false });
        else if (previous.signature !== signature) previous.conflicting = true;
      }
    }
    const groups = [];
    let conflicts = 0;
    for (const [kinId, byId] of recordsByKin) {
      const messages = [];
      for (const item of byId.values()) {
        if (item.conflicting) { conflicts++; continue; }
        messages.push({ ...item.message, fingerprint: await fingerprint(item.message) });
      }
      if (messages.length) groups.push({ kinId, messages });
    }
    // Journal pages are already loaded by Kindroid during normal browsing. Do
    // not request more pages: only accept a known Kin under the verified owner.
    const journalRecords = new Map(ids.map(id => [id, new Map()]));
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key.length !== 5 || !keyIs(key, 'v2', 'journal-entries', 'kin', uid) || !known.has(key[4])) continue;
      const pages = query.state?.data?.pages;
      if (!Array.isArray(pages) || pages.length > 1000) { incompleteFields++; continue; }
      const byId = journalRecords.get(key[4]);
      let count = 0;
      for (const page of pages) {
        if (!Array.isArray(page?.entries)) continue;
        for (const record of page.entries) {
          if (++count > 20_000) { incompleteFields++; break; }
          if (!isId(record?.id) || !Number.isFinite(record.created) || record.created < 1_000_000_000_000 ||
              !Number.isFinite(new Date(record.created).getTime()) || typeof record.description !== 'string' ||
              !record.description.trim() || record.description.length > 1_000_000 ||
              /(?:^|:)U2FsdGVkX1[A-Za-z0-9+/=]+$/.test(record.description)) { incompleteFields++; continue; }
          const entry = { entryId: record.id, createdAt: new Date(record.created).toISOString(), description: record.description };
          if (Array.isArray(record.keywords) && record.keywords.length <= 1000 && record.keywords.every(value => typeof value === 'string' && value.trim() && value.length <= 2048)) entry.keywords = [...record.keywords];
          if (typeof record.origin === 'string' && record.origin.trim() && record.origin.length <= 2048) entry.origin = record.origin;
          const signature = JSON.stringify(stable(entry));
          const previous = byId.get(entry.entryId);
          if (!previous) byId.set(entry.entryId, { entry, signature, conflicting: false });
          else if (previous.signature !== signature) previous.conflicting = true;
        }
        if (count > 20_000) break;
      }
    }
    const journals = [];
    for (const [kinId, byId] of journalRecords) {
      const entries = [];
      for (const item of byId.values()) {
        if (item.conflicting) { conflicts++; continue; }
        entries.push(item.entry);
      }
      if (entries.length) journals.push({ kinId, entries });
    }
    return { state: 'ready', account: { accountId: uid }, kins, profiles: profileResult.profiles, groups, journals, conflicts: conflicts + profileResult.conflicts, incompleteFields: incompleteFields + profileResult.incompleteFields, cacheIds };
  }
  globalThis.KinKeepExtract = Object.freeze({ extract, fingerprint, isProvisionalMessageId });
})();
