// This scanner reads existing site storage and visible DOM. The history bridge
// reads already-loaded page state. Neither clicks, scrolls, navigates, or sends
// network requests to Kindroid.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const SCAN_DELAY_MS = 15_000;
  const MAX_BATCH = 100;
  const MAX_JOURNAL_BATCH = 10;
  let scanning = false;
  let deferred = false;
  let plaintextTimer;
  const plaintext = KinexportPlaintext.createTracker();
  let lastSnapshot = '';
  let lastMediaSnapshot = '';
  let imageCaptureUnavailable = false;
  let lastState = '';
  async function report(state) {
    if (state === lastState) return;
    lastState = state;
    try { await ext.runtime.sendMessage({ type: 'captureStatus', state }); } catch { /* Extension may have reloaded. */ }
  }
  async function activeFor(uid, expectedPath = null) {
    const settings = (await ext.storage.local.get('settings')).settings;
    const current = KinexportCache.firebaseUid(localStorage);
    return settings?.enabled === true && current.state === 'ready' && current.uid === uid && (expectedPath === null || location.pathname === expectedPath);
  }
  async function stillBound(uid, kinId, pathname) {
    if (!(await activeFor(uid, pathname))) return false;
    const caches = await KinexportCache.getAuthenticatedCaches(indexedDB);
    if (caches.length !== 1 || caches[0]?.ownerUid !== uid) return false;
    const queries = caches[0]?.client?.clientState?.queries;
    if (!Array.isArray(queries)) return false;
    const matches = queries.filter(query => Array.isArray(query?.queryKey) && query.queryKey.length === 3 && query.queryKey[0] === 'v2' && query.queryKey[1] === 'user' && query.queryKey[2] === uid);
    const ids = matches.length === 1 ? matches[0]?.state?.data?.aiList : null;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.length > 0) || new Set(ids).size !== ids.length || !ids.includes(kinId)) return false;
    return activeFor(uid, pathname);
  }
  function schedulePlaintext(delay = 1600) {
    if (plaintextTimer) clearTimeout(plaintextTimer);
    plaintextTimer = setTimeout(() => { plaintextTimer = undefined; void scan(); }, delay);
  }
  function requestHistory(uid, kinId, ids) {
    if (!ids.length) return Promise.resolve([]);
    const nonce = crypto.randomUUID();
    const requested = new Set(ids);
    return new Promise(resolve => {
      let timer;
      function finish(records) {
        clearTimeout(timer);
        window.removeEventListener('message', receive);
        resolve(records);
      }
      function receive(event) {
        const data = event.data;
        if (event.source !== window || event.origin !== location.origin || data?.type !== 'KINEXPORT_HISTORY_RESPONSE' || data.nonce !== nonce || data.uid !== uid || data.kinId !== kinId || !Array.isArray(data.records) || data.records.length > ids.length) return;
        finish(data.records.filter(record => record && requested.has(record.id)));
      }
      window.addEventListener('message', receive);
      timer = setTimeout(() => finish([]), 1500);
      window.postMessage({ type: 'KINEXPORT_HISTORY_REQUEST', nonce, uid, kinId, ids }, location.origin);
    });
  }
  async function scan() {
    if (scanning) { deferred = true; return; }
    scanning = true;
    try {
      const settings = (await ext.storage.local.get('settings')).settings;
      if (!settings?.enabled) { lastSnapshot = ''; lastMediaSnapshot = ''; plaintext.reset(); clearTimeout(plaintextTimer); plaintextTimer = undefined; await report('paused'); return; }
      const identity = KinexportCache.firebaseUid(localStorage);
      if (identity.state !== 'ready') { lastSnapshot = ''; await report(identity.state); return; }
      const caches = await KinexportCache.getAuthenticatedCaches(indexedDB);
      if (!(await activeFor(identity.uid))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
      const snapshot = await KinexportExtract.extract(identity.uid, caches);
      if (snapshot.state !== 'ready') { lastSnapshot = ''; await report(snapshot.state); return; }
      if (identity.displayName) snapshot.account.displayName = identity.displayName;
      const pathname = location.pathname;
      const visible = await KinexportDom.extractVisible(document, pathname, snapshot);
      if (visible.length) {
        if (!(await activeFor(identity.uid, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
        for (const group of visible) {
          const existing = snapshot.groups.find(item => item.kinId === group.kinId);
          if (existing) existing.messages.push(...group.messages); else snapshot.groups.push(group);
        }
      }
      const historyView = KinexportDom.historyView?.(document, pathname, snapshot);
      let history = [];
      let historyRecords = [];
      if (historyView) {
        const ids = KinexportDom.historyIds(historyView);
        // Bound each bridge message. Only IDs currently rendered are requested.
        for (let offset = 0; offset < ids.length; offset += 500) {
          if (offset) await new Promise(resolve => setTimeout(resolve, 350));
          historyRecords.push(...await requestHistory(identity.uid, historyView.kinId, ids.slice(offset, offset + 500)));
        }
        if (!(await stillBound(identity.uid, historyView.kinId, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
        const currentView = KinexportDom.historyView(document, pathname, snapshot);
        if (currentView?.dialog === historyView.dialog && currentView.body === historyView.body) history = await KinexportDom.extractHistory(currentView, historyRecords, snapshot);
      }
      const plaintextView = KinexportPlaintext.read(document, pathname, snapshot, identity.uid);
      let stablePlaintext = {};
      if (plaintextView) {
        const observation = plaintext.observe(identity.uid, plaintextView.kinId, plaintextView.fields, Date.now());
        stablePlaintext = observation.stable;
        if (observation.pending) schedulePlaintext();
      } else plaintext.reset();
      const journals = snapshot.journals ?? [];
      const mediaCandidates = imageCaptureUnavailable ? [] : (globalThis.KinexportMediaCandidates?.read(identity.uid, caches, pathname, document) ?? []);
      const expectedPath = visible.length || plaintextView || historyView || journals.length || mediaCandidates.length ? pathname : null;
      const profileFingerprint = await KinexportExtract.fingerprint(snapshot.profiles);
      const journalFingerprint = await KinexportExtract.fingerprint(journals);
      const mediaFingerprint = await KinexportExtract.fingerprint({ accountId: identity.uid, mediaCandidates });
      const signature = JSON.stringify({ account: snapshot.account, kins: snapshot.kins, profileFingerprint, journalFingerprint, groups: [...snapshot.groups, ...history].map(group => ({ kinId: group.kinId, messages: group.messages.map(({ messageId, fingerprint }) => ({ messageId, fingerprint })) })) });
      if (signature === lastSnapshot && (!mediaCandidates.length || mediaFingerprint === lastMediaSnapshot) && !Object.keys(stablePlaintext).length) { await report(snapshot.conflicts || snapshot.incompleteFields ? 'ambiguous-messages' : 'ready'); return; }
      if (!(await activeFor(identity.uid, expectedPath))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
      const inventory = await ext.runtime.sendMessage({ type: 'inventory', account: snapshot.account, kins: snapshot.kins });
      if (!inventory?.ok) return;
      for (const group of snapshot.groups) {
        for (let offset = 0; offset < group.messages.length; offset += MAX_BATCH) {
          if (!(await activeFor(identity.uid, expectedPath))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
          const result = await ext.runtime.sendMessage({ type: 'captureBatch', accountId: identity.uid, kinId: group.kinId, messages: group.messages.slice(offset, offset + MAX_BATCH) });
          if (!result?.ok) return;
        }
      }
      for (const group of history) {
        for (let offset = 0; offset < group.messages.length; offset += MAX_BATCH) {
          // Re-read the page's history records and rendered content before each
          // batch. Leave enough time for the page-world bridge's rate limit.
          const pending = group.messages.slice(offset, offset + MAX_BATCH);
          await new Promise(resolve => setTimeout(resolve, 350));
          const freshRecords = await requestHistory(identity.uid, group.kinId, pending.map(message => message.messageId));
          if (!(await stillBound(identity.uid, group.kinId, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
          const currentView = KinexportDom.historyView(document, pathname, snapshot);
          if (currentView?.dialog !== historyView.dialog || currentView.body !== historyView.body) { lastSnapshot = ''; return; }
          const current = await KinexportDom.extractHistory(currentView, freshRecords, snapshot);
          const fresh = new Map((current[0]?.messages ?? []).map(message => [message.messageId, message.fingerprint]));
          const batch = pending.filter(message => fresh.get(message.messageId) === message.fingerprint && current[0]?.rendered?.[message.messageId] === group.rendered[message.messageId]);
          if (batch.length) {
            const result = await ext.runtime.sendMessage({ type: 'captureBatch', accountId: identity.uid, kinId: group.kinId, messages: batch });
            if (!result?.ok) return;
          }
          if (batch.length !== pending.length) { lastSnapshot = ''; return; }
        }
      }
      for (const group of journals) {
        for (let offset = 0; offset < group.entries.length; offset += MAX_JOURNAL_BATCH) {
          // Ownership and the known-Kin list may change while requests run.
          if (!(await stillBound(identity.uid, group.kinId, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
          const result = await ext.runtime.sendMessage({ type: 'journal', accountId: identity.uid, kinId: group.kinId, entries: group.entries.slice(offset, offset + MAX_JOURNAL_BATCH) });
          if (!result?.ok) return;
        }
      }
      if (mediaCandidates.length && mediaFingerprint !== lastMediaSnapshot) {
        const captured = await ext.runtime.sendMessage({ type: 'mediaSnapshot', urls: mediaCandidates.map(item => item.url) });
        if (captured?.reason === 'unsupported') imageCaptureUnavailable = true;
        if (captured?.ok && Array.isArray(captured.images)) {
          const kinId = mediaCandidates[0].kinId;
          if (!(await stillBound(identity.uid, kinId, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
          const freshCaches = await KinexportCache.getAuthenticatedCaches(indexedDB);
          const fresh = KinexportMediaCandidates.read(identity.uid, freshCaches, pathname, document);
          const current = new Set(fresh.map(item => JSON.stringify(item)));
          const byUrl = new Map(captured.images.map(item => [item.url, item]));
          let complete = true;
          for (const candidate of mediaCandidates) {
            const body = byUrl.get(candidate.url);
            // A page snapshot may not contain every image yet. Retry missing or
            // changed candidates on a later passive scan instead of marking the
            // entire snapshot complete and silently skipping them indefinitely.
            if (!current.has(JSON.stringify(candidate)) || !body) { complete = false; continue; }
            if (!(await stillBound(identity.uid, kinId, pathname))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
            const { url, kinId: ignored, ...item } = candidate;
            const result = await ext.runtime.sendMessage({ type: 'mediaSave', accountId: identity.uid, kinId, items: [{ ...item, mime: body.mime, data: body.data }] });
            if (!result?.ok) return;
          }
          if (complete) lastMediaSnapshot = mediaFingerprint;
        }
      }
      for (const profile of snapshot.profiles) {
        if (!(await activeFor(identity.uid, expectedPath))) { lastSnapshot = ''; await report('identity-uncertain'); return; }
        const result = await ext.runtime.sendMessage({ type: 'profile', profile });
        if (!result?.ok) return;
      }
      if (plaintextView && Object.keys(stablePlaintext).length) {
        // The editor may have changed or gained focus while archive requests were
        // in flight. Recheck identity, route, focus and values just before sending.
        if (!(await stillBound(identity.uid, plaintextView.kinId, pathname))) { plaintext.reset(); lastSnapshot = ''; await report('identity-uncertain'); return; }
        const current = KinexportPlaintext.read(document, pathname, snapshot, identity.uid);
        const accepted = {};
        if (current?.kinId === plaintextView.kinId) {
          for (const [field, value] of Object.entries(stablePlaintext)) {
            if (Object.hasOwn(current.fields, field) && current.fields[field] === value) accepted[field] = value;
          }
        }
        if (Object.keys(accepted).length) {
          const observedAt = new Date().toISOString();
          const fields = Object.fromEntries(Object.entries(accepted).map(([field, value]) => [field, { value, observedAt }]));
          const result = await ext.runtime.sendMessage({ type: 'profile', profile: { accountId: identity.uid, kinId: plaintextView.kinId, fields } });
          if (!result?.ok) return;
          if (!(await stillBound(identity.uid, plaintextView.kinId, pathname))) { plaintext.reset(); lastSnapshot = ''; await report('identity-uncertain'); return; }
          plaintext.commit(accepted);
        }
      }
      lastSnapshot = signature;
      await report(snapshot.conflicts || snapshot.incompleteFields ? 'ambiguous-messages' : 'ready');
    } catch {
      // Do not log cache contents, authentication records or tokens.
      lastSnapshot = '';
      await report('waiting');
    } finally {
      scanning = false;
      if (deferred) { deferred = false; schedulePlaintext(0); }
    }
  }
  void scan();
  setInterval(() => { void scan(); }, SCAN_DELAY_MS);
  document.addEventListener('focusout', event => {
    if (event.target?.tagName === 'TEXTAREA' && /^\/v2\/kin-settings\//.test(location.pathname)) schedulePlaintext();
  }, true);
  // History is virtualised and can change quickly as the user scrolls. Observe
  // only mutations in (or introducing) the history dialog, without scrolling.
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    const selector = 'div[role="dialog"][aria-label]';
    const observer = new MutationObserver(changes => {
      if (!/^\/v2\/kin-settings\//.test(location.pathname)) return;
      const relevant = changes.some(change => {
        const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        if (KinexportDom.isHistoryDialog(target?.closest?.(selector))) return true;
        return [...(change.addedNodes ?? []), ...(change.removedNodes ?? [])].some(node => node.nodeType === 1 && (
          (node.matches?.(selector) && KinexportDom.isHistoryDialog(node)) ||
          [...(node.querySelectorAll?.(selector) ?? [])].some(KinexportDom.isHistoryDialog)
        ));
      });
      if (relevant) schedulePlaintext(400);
    });
    observer.observe(document.documentElement, { childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'role', 'hidden', 'aria-hidden'], subtree: true });
  }
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) { lastSnapshot = ''; lastMediaSnapshot = ''; void scan(); }
  });
})();
