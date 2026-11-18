// Read-only observations of profile values the user has displayed in settings.
(() => {
  const LABELS = Object.freeze({
    'personality': 'ai_backstory_plaintext',
    'key memories': 'ai_memory_plaintext',
    'response directive': 'ai_directive_plaintext',
    'example message': 'ai_example_message_plaintext',
    'scene setting': 'current_scene_plaintext',
  });
  function visible(element) {
    const view = element.ownerDocument?.defaultView;
    if (!element.isConnected || element.hidden || element.disabled || element.closest('[aria-busy="true"], [aria-hidden="true"], [hidden]')) return false;
    const rectangle = element.getBoundingClientRect();
    if (!(rectangle.width > 0 && rectangle.height > 0)) return false;
    const style = view?.getComputedStyle(element);
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0');
  }
  function read(document, pathname, snapshot, uid) {
    const match = /^\/v2\/kin-settings\/([^/]+)\/?$/.exec(pathname);
    if (!match || snapshot?.state !== 'ready' || !uid || snapshot.account?.accountId !== uid) return null;
    let kinId;
    try { kinId = decodeURIComponent(match[1]); } catch { return null; }
    if (!snapshot.kins?.some(kin => kin.accountId === uid && kin.kinId === kinId)) return null;
    const candidates = new Map();
    for (const element of document.querySelectorAll('textarea')) {
      if (!visible(element)) continue;
      const matches = [...(element.labels ?? [])].map(label => LABELS[(label.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()]).filter(Boolean);
      if (new Set(matches).size !== 1) continue;
      const field = matches[0];
      const values = candidates.get(field) ?? [];
      values.push(element);
      candidates.set(field, values);
    }
    const fields = {};
    for (const [field, elements] of candidates) {
      if (elements.length !== 1) continue;
      const element = elements[0];
      // Never record an in-progress edit. An empty value is a valid observation.
      if (document.activeElement === element || typeof element.value !== 'string' || element.value.length > 1_000_000) continue;
      // Do not mislabel an undecrypted salted envelope as plaintext.
      const delimiter = element.value.indexOf(':');
      if (delimiter >= 0 && delimiter < 32 && element.value.slice(delimiter + 1).startsWith('U2FsdGVkX1')) continue;
      fields[field] = element.value;
    }
    return { kinId, fields };
  }
  function createTracker(delayMs = 1500) {
    let identity = '';
    let entries = new Map();
    return {
      reset() { identity = ''; entries = new Map(); },
      observe(uid, kinId, fields, now) {
        const nextIdentity = JSON.stringify([uid, kinId]);
        if (identity !== nextIdentity) { identity = nextIdentity; entries = new Map(); }
        for (const field of entries.keys()) if (!Object.hasOwn(fields, field)) entries.delete(field);
        for (const [field, value] of Object.entries(fields)) {
          const existing = entries.get(field);
          if (!existing || existing.value !== value) entries.set(field, { value, since: now, sent: false });
        }
        const stable = {};
        let pending = false;
        for (const [field, entry] of entries) {
          if (entry.sent) continue;
          if (now - entry.since >= delayMs) stable[field] = entry.value;
          else pending = true;
        }
        return { stable, pending };
      },
      commit(fields) {
        for (const [field, value] of Object.entries(fields)) {
          const existing = entries.get(field);
          if (existing && existing.value === value) existing.sent = true;
        }
      },
    };
  }
  globalThis.KinKeepPlaintext = Object.freeze({ read, createTracker });
})();
