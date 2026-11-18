// This scanner reads existing site storage and visible DOM. The history bridge
// reads already-loaded page state. Neither clicks, scrolls, navigates, or sends
// network requests to Kindroid.
(() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const SCAN_DELAY_MS = 15_000;
  const MAX_BATCH = 100;
  const MAX_JOURNAL_BATCH = 10;
  // JSON strings can occupy several bytes per character on the wire. Keep
  // multi-record batches modest while allowing a single valid large record.
  const MAX_BATCH_CHARS = 2_000_000;
  function* captureBatches(records, maxCount) {
    let batch = [], size = 0;
    for (const record of records) {
      const length = JSON.stringify(record).length;
      if (batch.length && (batch.length >= maxCount || size + length > MAX_BATCH_CHARS)) {
        yield batch;
        batch = [];
        size = 0;
      }
      batch.push(record);
      size += length;
    }
    if (batch.length) yield batch;
  }
  let scanning = false;
  let deferred = false;
  let scanTimer;
  const plaintext = KinKeepPlaintext.createTracker();
  let confirmed = new Map();
  let confirmedOwner;
  let mediaProgress;
  let settingsGeneration = 0;
  let scanGeneration;
  let captureEnabled;
  let observer;
  let imageCaptureUnavailable = false;
  let lastState = '';
  function setObservation(enabled) {
    if (captureEnabled === enabled) return;
    captureEnabled = enabled;
    if (enabled) {
      observer?.observe(document.documentElement, {
        childList: true, characterData: true, attributes: true, subtree: true,
        attributeFilter: ['aria-label', 'role', 'hidden', 'aria-hidden'],
      });
    } else observer?.disconnect();
  }
  function forgetConfirmations() {
    confirmed = new Map();
    confirmedOwner = undefined;
    mediaProgress = undefined;
    plaintext.reset();
  }
  async function saveAtArchive(message) {
    const response = await ext.runtime.sendMessage(message);
    if (response?.ok) return true;
    // A restored archive may have lost the account, Kin, and acknowledged
    // records. Reestablish inventory and probe everything still present.
    confirmed.clear();
    mediaProgress?.saved.clear();
    plaintext.reset();
    return false;
  }
  async function report(state) {
    if (state === lastState) return;
    lastState = state;
    try { await ext.runtime.sendMessage({ type: 'captureStatus', state }); } catch { /* Extension may have reloaded. */ }
  }
  async function activeFor(uid, expectedPath = null) {
    const settings = (await ext.storage.local.get('settings')).settings;
    const current = KinKeepCache.firebaseUid(localStorage);
    return settingsGeneration === scanGeneration && settings?.enabled === true && current.state === 'ready' && current.uid === uid && (expectedPath === null || location.pathname === expectedPath);
  }
  async function stillBound(uid, kinId, pathname) {
    if (!(await activeFor(uid, pathname))) return false;
    const caches = await KinKeepCache.getAuthenticatedCaches(indexedDB);
    const scope = KinKeepCache.accountScope(uid, caches);
    if (scope.state !== 'ready' || !scope.kinIds.includes(kinId)) return false;
    return activeFor(uid, pathname);
  }
  function scheduleScan(delay = 1600) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { scanTimer = undefined; return scan(); }, delay);
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
    scanGeneration = settingsGeneration;
    try {
      const settings = (await ext.storage.local.get('settings')).settings;
      if (scanGeneration !== settingsGeneration) return;
      setObservation(settings?.enabled === true);
      if (!captureEnabled) { forgetConfirmations(); clearTimeout(scanTimer); scanTimer = undefined; await report('paused'); return; }
      const identity = KinKeepCache.firebaseUid(localStorage);
      if (identity.state !== 'ready') { forgetConfirmations(); await report(identity.state); return; }
      const caches = await KinKeepCache.getAuthenticatedCaches(indexedDB);
      if (!(await activeFor(identity.uid))) { forgetConfirmations(); await report('identity-uncertain'); return; }
      const snapshot = await KinKeepExtract.extract(identity.uid, caches);
      if (snapshot.state !== 'ready') { forgetConfirmations(); await report(snapshot.state); return; }
      if (confirmedOwner !== identity.uid) {
        forgetConfirmations();
        confirmedOwner = identity.uid;
      }
      if (identity.displayName) snapshot.account.displayName = identity.displayName;
      const pathname = location.pathname;
      const visible = await KinKeepDom.extractVisible(document, pathname, snapshot);
      if (visible.length) {
        if (!(await activeFor(identity.uid, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
        for (const group of visible) {
          const existing = snapshot.groups.find(item => item.kinId === group.kinId);
          if (existing) existing.messages.push(...group.messages); else snapshot.groups.push(group);
        }
      }
      const historyView = KinKeepDom.historyView?.(document, pathname, snapshot);
      let history = [];
      const cachedIds = snapshot.cacheIds?.get(historyView?.kinId);
      const ids = historyView ? KinKeepDom.historyIds(historyView).filter(id => !cachedIds?.has(id)) : [];
      if (ids.length) {
        const historyRecords = [];
        // Bound each bridge message. Only IDs currently rendered are requested.
        for (let offset = 0; offset < ids.length; offset += 500) {
          if (offset) await new Promise(resolve => setTimeout(resolve, 350));
          if (!(await activeFor(identity.uid, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          historyRecords.push(...await requestHistory(identity.uid, historyView.kinId, ids.slice(offset, offset + 500)));
        }
        if (!(await stillBound(identity.uid, historyView.kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
        const currentView = KinKeepDom.historyView(document, pathname, snapshot);
        if (currentView?.dialog === historyView.dialog && currentView.body === historyView.body) history = await KinKeepDom.extractHistory(currentView, historyRecords, snapshot);
      }
      const plaintextView = KinKeepPlaintext.read(document, pathname, snapshot, identity.uid);
      let stablePlaintext = {};
      if (plaintextView) {
        const observation = plaintext.observe(identity.uid, plaintextView.kinId, plaintextView.fields, Date.now());
        stablePlaintext = observation.stable;
        if (observation.pending) scheduleScan();
      } else plaintext.reset();
      const journals = snapshot.journals ?? [];
      const mediaCandidates = imageCaptureUnavailable || settings.imageArchiving !== true ? [] : (globalThis.KinKeepMediaCandidates?.read(identity.uid, caches, pathname, document) ?? []);
      const expectedPath = visible.length || plaintextView || historyView || journals.length || mediaCandidates.length ? pathname : null;
      if (!(await activeFor(identity.uid, expectedPath))) { forgetConfirmations(); await report('identity-uncertain'); return; }

      // Carry forward only data observed in this scan. Unconfirmed writes and
      // records that leave and later re-enter the page are checked again.
      const previous = confirmed;
      const acknowledgements = new Map();
      confirmed = acknowledgements;
      function needsSave(key, version) {
        if (previous.get(key) !== version) return true;
        acknowledgements.set(key, version);
        return false;
      }
      function messageKey(kinId, message) {
        return JSON.stringify(['message', kinId, message.conversationId, message.messageId]);
      }
      function changedMessages(group) {
        return group.messages.filter(message => needsSave(messageKey(group.kinId, message), message.fingerprint));
      }
      function confirmMessages(kinId, messages) {
        for (const message of messages) acknowledgements.set(messageKey(kinId, message), message.fingerprint);
      }
      const inventoryVersion = JSON.stringify([snapshot.account, snapshot.kins]);
      if (needsSave('inventory', inventoryVersion)) {
        if (!(await saveAtArchive({ type: 'inventory', account: snapshot.account, kins: snapshot.kins }))) return;
        acknowledgements.set('inventory', inventoryVersion);
      }
      for (const group of snapshot.groups) {
        for (const batch of captureBatches(changedMessages(group), MAX_BATCH)) {
          if (!(await activeFor(identity.uid, expectedPath))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          if (!(await saveAtArchive({ type: 'captureBatch', accountId: identity.uid, kinId: group.kinId, messages: batch }))) return;
          confirmMessages(group.kinId, batch);
        }
      }
      for (const group of history) {
        for (const pending of captureBatches(changedMessages(group), MAX_BATCH)) {
          // Re-read the page's history records and rendered content before each
          // batch. Leave enough time for the page-world bridge's rate limit.
          await new Promise(resolve => setTimeout(resolve, 350));
          if (!(await activeFor(identity.uid, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          const freshRecords = await requestHistory(identity.uid, group.kinId, pending.map(message => message.messageId));
          if (!(await stillBound(identity.uid, group.kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          const currentView = KinKeepDom.historyView(document, pathname, snapshot);
          if (currentView?.dialog !== historyView.dialog || currentView.body !== historyView.body) return;
          const current = await KinKeepDom.extractHistory(currentView, freshRecords, snapshot);
          const fresh = new Map((current[0]?.messages ?? []).map(message => [message.messageId, message.fingerprint]));
          const batch = pending.filter(message => fresh.get(message.messageId) === message.fingerprint && current[0]?.rendered?.[message.messageId] === group.rendered[message.messageId]);
          if (batch.length) {
            if (!(await activeFor(identity.uid, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
            if (!(await saveAtArchive({ type: 'captureBatch', accountId: identity.uid, kinId: group.kinId, messages: batch }))) return;
            confirmMessages(group.kinId, batch);
          }
          if (batch.length !== pending.length) return;
        }
      }
      for (const group of journals) {
        for (const entries of captureBatches(group.entries, MAX_JOURNAL_BATCH)) {
          const key = JSON.stringify(['journal', group.kinId, entries[0].entryId]);
          const version = await KinKeepExtract.fingerprint(entries);
          if (!needsSave(key, version)) continue;
          // Ownership and the known-Kin list may change while requests run.
          if (!(await stillBound(identity.uid, group.kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          if (!(await saveAtArchive({ type: 'journal', accountId: identity.uid, kinId: group.kinId, entries }))) return;
          acknowledgements.set(key, version);
        }
      }
      const mediaFingerprint = mediaCandidates.length ? await KinKeepExtract.fingerprint(mediaCandidates) : null;
      if (mediaFingerprint !== mediaProgress?.fingerprint) {
        mediaProgress = mediaFingerprint ? { fingerprint: mediaFingerprint, saved: new Set(), retryAt: 0, delay: SCAN_DELAY_MS } : undefined;
      }
      const progress = mediaProgress;
      if (progress && progress.saved.size < mediaCandidates.length && Date.now() >= progress.retryAt) {
        const pending = mediaCandidates.filter(item => !progress.saved.has(item.url));
        const kinId = pending[0].kinId;
        if (!(await stillBound(identity.uid, kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
        // An incomplete or oversized snapshot can persist across many scans.
        // Retry only missing parts, with backoff while the candidates stay the same.
        progress.retryAt = Date.now() + progress.delay;
        progress.delay = Math.min(progress.delay * 2, 300_000);
        const captured = await ext.runtime.sendMessage({ type: 'mediaSnapshot', urls: pending.map(item => item.url) });
        if (captured?.reason === 'unsupported') imageCaptureUnavailable = true;
        if (captured?.ok && Array.isArray(captured.images)) {
          if (!(await stillBound(identity.uid, kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          const freshCaches = await KinKeepCache.getAuthenticatedCaches(indexedDB);
          const fresh = KinKeepMediaCandidates.read(identity.uid, freshCaches, pathname, document);
          const freshCandidates = new Set(fresh.map(item => JSON.stringify(item)));
          const byUrl = new Map(captured.images.map(item => [item.url, item]));
          for (const candidate of pending) {
            const body = byUrl.get(candidate.url);
            if (!freshCandidates.has(JSON.stringify(candidate)) || !body) continue;
            if (!(await stillBound(identity.uid, kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
            const { url, kinId: ignored, ...item } = candidate;
            if (!(await saveAtArchive({ type: 'mediaSave', accountId: identity.uid, kinId, items: [{ ...item, mime: body.mime, data: body.data }] }))) return;
            progress.saved.add(url);
          }
        }
      }
      for (const profile of snapshot.profiles) {
        const key = JSON.stringify(['profile', profile.kinId]);
        const version = await KinKeepExtract.fingerprint(profile);
        if (!needsSave(key, version)) continue;
        if (!(await activeFor(identity.uid, expectedPath))) { forgetConfirmations(); await report('identity-uncertain'); return; }
        if (!(await saveAtArchive({ type: 'profile', profile }))) return;
        acknowledgements.set(key, version);
      }
      if (plaintextView && Object.keys(stablePlaintext).length) {
        // The editor may have changed or gained focus while archive requests were
        // in flight. Recheck identity, route, focus and values just before sending.
        if (!(await stillBound(identity.uid, plaintextView.kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
        const current = KinKeepPlaintext.read(document, pathname, snapshot, identity.uid);
        const accepted = {};
        if (current?.kinId === plaintextView.kinId) {
          for (const [field, value] of Object.entries(stablePlaintext)) {
            if (Object.hasOwn(current.fields, field) && current.fields[field] === value) accepted[field] = value;
          }
        }
        if (Object.keys(accepted).length) {
          const observedAt = new Date().toISOString();
          const fields = Object.fromEntries(Object.entries(accepted).map(([field, value]) => [field, { value, observedAt }]));
          if (!(await saveAtArchive({ type: 'profile', profile: { accountId: identity.uid, kinId: plaintextView.kinId, fields } }))) return;
          if (!(await stillBound(identity.uid, plaintextView.kinId, pathname))) { forgetConfirmations(); await report('identity-uncertain'); return; }
          plaintext.commit(accepted);
        }
      }
      await report(snapshot.conflicts || snapshot.incompleteFields ? 'ambiguous-messages' : 'ready');
    } catch {
      // Do not log cache contents, authentication records or tokens.
      forgetConfirmations();
      await report('waiting');
    } finally {
      scanning = false;
      if (deferred) { deferred = false; scheduleScan(0); }
    }
  }
  setInterval(() => { if (captureEnabled !== false) return scan(); }, SCAN_DELAY_MS);
  document.addEventListener('focusout', event => {
    if (captureEnabled && event.target?.tagName === 'TEXTAREA' && /^\/v2\/kin-settings\//.test(location.pathname)) scheduleScan();
  }, true);
  // History is virtualised and can change quickly as the user scrolls. Observe
  // only mutations in (or introducing) the history dialog, without scrolling.
  if (typeof MutationObserver !== 'undefined' && document.documentElement) {
    const selector = 'div[role="dialog"][aria-label]';
    observer = new MutationObserver(changes => {
      if (!/^\/v2\/kin-settings\//.test(location.pathname)) return;
      const relevant = changes.some(change => {
        const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        if (KinKeepDom.isHistoryDialog(target?.closest?.(selector))) return true;
        return [...(change.addedNodes ?? []), ...(change.removedNodes ?? [])].some(node => node.nodeType === 1 && (
          (node.matches?.(selector) && KinKeepDom.isHistoryDialog(node)) ||
          [...(node.querySelectorAll?.(selector) ?? [])].some(KinKeepDom.isHistoryDialog)
        ));
      });
      if (relevant) scheduleScan(400);
    });
  }
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settingsGeneration++;
      // Suspend page observation until the new settings have been read. A
      // failed read leaves interval polling active so capture can recover.
      setObservation(undefined);
      forgetConfirmations();
      return scan();
    }
  });
  return scan();
})();
