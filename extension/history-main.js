// Read only the already-loaded React Query history window. This runs in the page
// world because React's in-memory state is not visible to isolated scripts.
(() => {
  const REQUEST = 'KINEXPORT_HISTORY_REQUEST';
  const RESPONSE = 'KINEXPORT_HISTORY_RESPONSE';
  const MAX_IDS = 500;
  const MAX_DOM_NODES = 30000;
  const MAX_FIBERS = 50000;
  const MAX_HOOKS = 100;
  const MAX_CLIENTS = 50;
  const MAX_QUERIES = 10000;
  const MAX_MESSAGES = 20000;
  const MAX_RESPONSE_CHARS = 4_000_000;
  const idString = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048;
  const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  function selectedFields(record) {
    const result = { id: record.id, timestamp: record.timestamp, isSelf: record.isSelf };
    if (typeof record.text === 'string' && record.text.trim() && record.text.length <= 1_000_000 && !/(?:^|:)U2FsdGVkX1[A-Za-z0-9+/=]+$/.test(record.text)) result.text = record.text;
    if (typeof record.persona === 'string' && record.persona.trim() && record.persona.length <= 100_000) result.persona = record.persona;
    if (idString(record.chatHistoryRecordId)) result.chatHistoryRecordId = record.chatHistoryRecordId;
    if (idString(record.senderAiId)) result.senderAiId = record.senderAiId;
    if (Number.isSafeInteger(record.reactionsRevision) && record.reactionsRevision >= 0) result.reactionsRevision = record.reactionsRevision;
    if (record.reactions && typeof record.reactions === 'object' && !Array.isArray(record.reactions)) {
      const entries = Object.entries(record.reactions);
      if (entries.length <= 1000 && entries.every(([actor, emoji]) => idString(actor) && !/token|password|cookie|authorization|secret/i.test(actor) && typeof emoji === 'string' && emoji.trim() && emoji.length <= 128)) {
        result.reactions = Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      }
    }
    return result;
  }

  // Only inspect the known wrappers used to expose a QueryClient in a provider
  // or hook. Do not crawl the rest of the application's object graph.
  function findClientCandidates(value, clients, seen, depth = 0) {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value) || depth > 3) return;
    seen.add(value);
    if (typeof value.getQueryCache === 'function') {
      clients.add(value);
      if (clients.size > MAX_CLIENTS) throw new Error('Too many query clients');
      return;
    }
    for (const key of ['value', 'client', 'queryClient']) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && 'value' in descriptor) findClientCandidates(descriptor.value, clients, seen, depth + 1);
    }
  }

  function findClients() {
    const roots = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
    let element = document.documentElement;
    let nodeCount = 0;
    while (element) {
      if (++nodeCount > MAX_DOM_NODES) throw new Error('DOM scan limit');
      for (const name of Object.getOwnPropertyNames(element)) {
        if (name.startsWith('__reactContainer$')) {
          const descriptor = Object.getOwnPropertyDescriptor(element, name);
          if (descriptor && 'value' in descriptor && descriptor.value) roots.push(descriptor.value.current || descriptor.value);
        }
      }
      element = walker.nextNode();
    }
    const stack = roots;
    const seenFibers = new Set();
    const seenValues = new Set();
    const clients = new Set();
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber || typeof fiber !== 'object' || seenFibers.has(fiber)) continue;
      seenFibers.add(fiber);
      if (seenFibers.size > MAX_FIBERS) throw new Error('Fiber scan limit');
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
      findClientCandidates(fiber.memoizedProps, clients, seenValues);
      let hook = fiber.memoizedState;
      const hookSeen = new Set();
      while (hook && typeof hook === 'object' && !hookSeen.has(hook)) {
        hookSeen.add(hook);
        if (hookSeen.size > MAX_HOOKS) break;
        findClientCandidates(hook.memoizedState, clients, seenValues);
        findClientCandidates(hook.baseState, clients, seenValues);
        hook = hook.next;
      }
    }
    return clients;
  }

  function readRecords(clients, uid, kinId, ids) {
    const wanted = new Set(ids);
    const matches = [];
    for (const client of clients) {
      const cache = client.getQueryCache();
      if (!cache || typeof cache.getAll !== 'function') continue;
      const queries = cache.getAll();
      if (!Array.isArray(queries) || queries.length > MAX_QUERIES) throw new Error('Query scan limit');
      const relevant = queries.filter(query => {
        const key = query?.queryKey;
        return Array.isArray(key) && key.length === 8 && key[0] === 'v2' && key[1] === 'chat-history-window' && key[2] === uid && key[3] === 'ai' && key[4] === kinId && typeof key[5] === 'string' && Number.isFinite(key[6]) && Number.isFinite(key[7]);
      });
      if (relevant.length) matches.push(relevant);
    }
    // Multiple owner-matching clients have no reliable ordering or authority.
    if (matches.length !== 1) return [];
    const records = new Map();
    let count = 0;
    for (const query of matches[0]) {
      const pages = query.state?.data?.pages;
      if (!Array.isArray(pages) || pages.length > MAX_MESSAGES) continue;
      for (const page of pages) {
        if (!Array.isArray(page?.messages)) continue;
        for (const record of page.messages) {
          if (++count > MAX_MESSAGES) throw new Error('Message scan limit');
          if (!idString(record?.id) || !wanted.has(record.id)) continue;
          const valid = Number.isFinite(record.timestamp) && record.timestamp >= 1e12 && record.timestamp <= 8.64e15 && typeof record.isSelf === 'boolean';
          const previous = records.get(record.id);
          const selected = valid ? selectedFields(record) : null;
          if (!valid || previous === null || (previous && JSON.stringify(previous) !== JSON.stringify(selected))) {
            records.set(record.id, null);
          } else if (!previous) {
            records.set(record.id, selected);
          }
        }
      }
    }
    let size = 0;
    return [...records.values()].filter(record => {
      if (!record) return false;
      const length = JSON.stringify(record).length;
      if (size + length > MAX_RESPONSE_CHARS) return false;
      size += length;
      return true;
    });
  }

  let lastRequest = 0;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = event.data;
    if (!request || request.type !== REQUEST || !validNonce(request.nonce) || !idString(request.uid) || !idString(request.kinId) ||
        !Array.isArray(request.ids) || request.ids.length < 1 || request.ids.length > MAX_IDS || !request.ids.every(idString) || new Set(request.ids).size !== request.ids.length) return;
    const route = /^\/v2\/kin-settings\/([^/]+)\/?$/.exec(location.pathname);
    if (!route) return;
    try { if (decodeURIComponent(route[1]) !== request.kinId) return; } catch { return; }
    const now = Date.now();
    if (now - lastRequest < 300) return;
    lastRequest = now;
    let records;
    try { records = readRecords(findClients(), request.uid, request.kinId, request.ids); } catch { records = []; }
    window.postMessage({ type: RESPONSE, nonce: request.nonce, uid: request.uid, kinId: request.kinId, records }, location.origin);
  });
})();
