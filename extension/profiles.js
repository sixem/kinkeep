// Extract only explicitly verified profile fields from account-owned cache docs.
(() => {
  // Only live-verified fields are allowed; null is retained as an explicit value.
  const strings = ['ai_backstory', 'ai_memory', 'ai_directive', 'ai_example_message',
    'developed_context_v1', 'developed_context_previous_v1', 'ai_name', 'voice_model',
    'voice_call_directive', 'llm_flair', 'reasoning_effort', 'custom_avatar_description',
    'custom_avatar_face_prompt', 'current_scene', 'default_room_bio', 'legacy_llm_model',
    'legacy_selfies_model', 'video_model', 'auto_journal_day', 'proactive_engine'];
  const numbers = ['selected_voice', 'user_set_temperature', 'custom_avatar_fidelity', 'custom_avatar_face_detail'];
  const booleans = ['time_awareness', 'ai_reactions_enabled', 'avatar_is_anime',
    'proactive_mode', 'live_tool_mode', 'disable_ltm_recall', 'disable_ltm_consolidate',
    'has_cascade_memory', 'voice_call_use_fast_voice', 'voice_call_unified_context'];
  const FIELD_TYPES = Object.freeze(Object.fromEntries([
    ...strings.map(name => [name, ['string', 'null']]),
    ...numbers.map(name => [name, ['number', 'null']]),
    ...booleans.map(name => [name, ['boolean', 'null']]),
  ]));
  function extractProfiles(uid, kinIds, queries) {
    const known = new Set(kinIds);
    const values = new Map(kinIds.map(kinId => [kinId, new Map()]));
    let conflicts = 0;
    let incompleteFields = 0;
    function consider(doc, observedMs) {
      if (!doc || doc.uid !== uid || !known.has(doc.ai_id)) return;
      const fields = values.get(doc.ai_id);
      for (const [name, types] of Object.entries(FIELD_TYPES)) {
        if (!Object.hasOwn(doc, name)) continue;
        const value = doc[name];
        if (value === undefined) continue;
        const type = value === null ? 'null' : typeof value;
        if (!types.includes(type) || (type === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000)) || (type === 'string' && value.length > 1_000_000)) { incompleteFields++; continue; }
        const prior = fields.get(name);
        const stamp = Number.isFinite(observedMs) && observedMs > 0 && observedMs <= 253402300799999 && Number.isFinite(new Date(observedMs).getTime()) ? observedMs : null;
        if (!prior || (stamp !== null && (prior.stamp === null || stamp > prior.stamp))) {
          fields.set(name, { value, stamp, conflicting: false });
        } else if (stamp === prior.stamp && !Object.is(value, prior.value)) {
          prior.conflicting = true;
        }
      }
    }
    for (const query of queries) {
      const key = query?.queryKey;
      if (!Array.isArray(key) || key[0] !== 'v2' || key[1] !== 'kins' || key[2] !== uid) continue;
      const data = query.state?.data;
      const timestamp = query.state?.dataUpdatedAt;
      if (key[3] === 'page' && Array.isArray(data?.pages)) {
        for (const page of data.pages) if (Array.isArray(page?.docs)) for (const doc of page.docs) consider(doc, timestamp);
      } else if (key[3] === 'summaries-by-ids' && Array.isArray(data)) {
        for (const doc of data) consider(doc, timestamp);
      } else if (key.length === 4 && known.has(key[3]) && data?.ai_id === key[3]) consider(data, timestamp);
    }
    const profiles = [];
    for (const [kinId, fields] of values) {
      const observed = {};
      for (const [name, candidate] of fields) {
        if (candidate.conflicting) { conflicts++; continue; }
        observed[name] = { value: candidate.value, ...(candidate.stamp === null ? {} : { observedAt: new Date(candidate.stamp).toISOString() }) };
      }
      if (Object.keys(observed).length) profiles.push({ accountId: uid, kinId, fields: observed });
    }
    return { profiles, conflicts, incompleteFields };
  }
  globalThis.KinexportProfiles = Object.freeze({ extractProfiles });
})();
