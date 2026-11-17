// DOM-only fallback for rendered message IDs not present in the verified cache.
(() => {
  const BLOCKS = new Set(['P', 'DIV', 'LI', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const OMIT = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);

  // Reconstruct a readable Markdown-like representation from visible text.
  // Rendered HTML cannot tell us whether the original emphasis used * or _,
  // nor exactly how the author spaced paragraphs, so this is best effort.
  function toSourceText(root) {
    function render(node) {
      if (node.nodeType === 3) return node.nodeValue ?? '';
      if (node.nodeType !== 1 && node.nodeType !== 11) return '';
      const tag = node.nodeType === 1 ? node.tagName.toUpperCase() : '';
      if (OMIT.has(tag) || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return '';
      if (tag === 'BR') return '\n';
      const view = node.ownerDocument?.defaultView;
      if (tag && view?.getComputedStyle) {
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return '';
      }
      let text = '';
      let previousBlock = '';
      for (const child of node.childNodes ?? []) {
        const part = render(child);
        if (!part) continue;
        const childTag = child.nodeType === 1 ? child.tagName.toUpperCase() : '';
        const childBlock = BLOCKS.has(childTag) ? childTag : '';
        if (text && (previousBlock || childBlock)) {
          const required = previousBlock === 'P' && childBlock === 'P' ? 2 : 1;
          const trailing = (text.match(/\n*$/) ?? [''])[0].length;
          const leading = (part.match(/^\n*/) ?? [''])[0].length;
          text += '\n'.repeat(Math.max(0, required - trailing - leading));
        }
        text += part;
        previousBlock = childBlock;
      }
      const marker = tag === 'EM' || tag === 'I' ? '*' : tag === 'STRONG' || tag === 'B' ? '**' : '';
      if (!marker) return text;
      // Keep source-node whitespace exactly where it appeared in the element.
      return marker + text + marker;
    }
    return render(root);
  }

  async function extractVisible(document, pathname, snapshot) {
    const match = /^\/v2\/chat\/([^/]+)\/?$/.exec(pathname);
    if (!match || snapshot.state !== 'ready') return [];
    let kinId;
    try { kinId = decodeURIComponent(match[1]); } catch { return []; }
    if (!snapshot.kins.some(kin => kin.kinId === kinId)) return [];
    const viewport = document.querySelector('section[data-chat-message-viewport]');
    if (!viewport) return [];
    const cached = snapshot.cacheIds?.get(kinId) ?? new Set(snapshot.groups.find(group => group.kinId === kinId)?.messages.map(message => message.messageId) ?? []);
    const records = new Map();
    for (const article of viewport.querySelectorAll('article[data-chat-message]')) {
      const wrapper = article.parentElement;
      if (!wrapper?.id?.startsWith('v2-msg-')) continue;
      const messageId = wrapper.id.slice('v2-msg-'.length);
      if (!messageId.trim() || messageId.length > 2048 || cached.has(messageId)) continue;
      const timestamp = Number(wrapper.dataset?.chatTimestamp);
      if (!Number.isFinite(timestamp) || timestamp < 1_000_000_000_000) continue;
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) continue;
      const classes = [...article.classList];
      const self = classes.some(value => /_align-self(?:_|$)/.test(value));
      const other = classes.some(value => /_align-other(?:_|$)/.test(value));
      if (self === other) continue;
      const nodes = article.querySelectorAll('[data-chat-message-surface] .v2-message-selectable');
      if (nodes.length !== 1) continue;
      const content = toSourceText(nodes[0]);
      if (!content.trim() || content.length > 1_000_000) continue;
      const message = { conversationId: 'observed-main', messageId, sender: self ? 'user' : 'kin', timestamp: date.toISOString(), content, data: { captureSource: 'dom' } };
      const existing = records.get(messageId);
      const signature = JSON.stringify(message);
      if (!existing) records.set(messageId, { message, signature, conflicting: false });
      else if (existing.signature !== signature) existing.conflicting = true;
    }
    const messages = [];
    for (const record of records.values()) {
      if (!record.conflicting) messages.push({ ...record.message, fingerprint: await KinexportExtract.fingerprint(record.message) });
    }
    return messages.length ? [{ kinId, messages }] : [];
  }

  function isHistoryDialog(dialog) {
    const label = dialog?.getAttribute?.('aria-label');
    return typeof label === 'string' && /^chat history$/i.test(label.trim().replace(/\s+/g, ' '));
  }
  function historyView(document, pathname, snapshot) {
    const match = /^\/v2\/kin-settings\/([^/]+)\/?$/.exec(pathname);
    if (!match || snapshot.state !== 'ready') return null;
    let kinId;
    try { kinId = decodeURIComponent(match[1]); } catch { return null; }
    if (!snapshot.kins.some(kin => kin.kinId === kinId)) return null;
    const visible = [...document.querySelectorAll('div[role="dialog"][aria-label]')].filter(dialog => {
      if (!isHistoryDialog(dialog)) return false;
      if (dialog.hidden || dialog.getAttribute('aria-hidden') === 'true' || !dialog.isConnected) return false;
      const style = document.defaultView?.getComputedStyle(dialog);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      const rect = dialog.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (visible.length !== 1) return null;
    const bodies = visible[0].querySelectorAll('div.v2-sheet-scroll-body.v2-slim-scrollbar');
    if (bodies.length !== 1) return null;
    return { kinId, dialog: visible[0], body: bodies[0] };
  }
  function historyIds(view) {
    const ids = new Set();
    for (const article of view.body.querySelectorAll('article[data-chat-message]')) {
      const id = article.parentElement?.id;
      if (typeof id !== 'string' || !id.startsWith('v2-history-')) continue;
      const value = id.slice('v2-history-'.length);
      if (value.trim() && value.length <= 2048) ids.add(value);
    }
    return [...ids];
  }

  // A history message is usable only when the exact displayed message ID has a
  // timestamp and sender in the account/Kin-scoped in-memory history query.
  async function extractHistory(view, records, snapshot) {
    if (!view || snapshot.state !== 'ready' || !snapshot.kins.some(kin => kin.kinId === view.kinId)) return [];
    const cached = snapshot.cacheIds?.get(view.kinId) ?? new Set(snapshot.groups.find(group => group.kinId === view.kinId)?.messages.map(message => message.messageId) ?? []);
    const metadata = new Map();
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 2048 || !Number.isFinite(record.timestamp) || record.timestamp < 1_000_000_000_000 || typeof record.isSelf !== 'boolean') continue;
      if (!Number.isFinite(new Date(record.timestamp).getTime())) continue;
      const current = { timestamp: record.timestamp, isSelf: record.isSelf, data: { captureSource: 'dom' } };
      if (typeof record.text === 'string' && record.text.trim() && record.text.length <= 1_000_000 && !/(?:^|:)U2FsdGVkX1[A-Za-z0-9+/=]+$/.test(record.text)) {
        current.text = record.text;
        current.data.captureSource = 'history';
        if (typeof record.persona === 'string' && record.persona.trim() && record.persona.length <= 100_000) current.data.persona = record.persona;
        const validId = value => typeof value === 'string' && value.trim() && value.length <= 2048;
        if (validId(record.chatHistoryRecordId)) current.data.chatHistoryRecordId = record.chatHistoryRecordId;
        if (validId(record.senderAiId)) current.data.senderAiId = record.senderAiId;
        if (Number.isSafeInteger(record.reactionsRevision) && record.reactionsRevision >= 0) current.data.reactionsRevision = record.reactionsRevision;
        if (record.reactions && typeof record.reactions === 'object' && !Array.isArray(record.reactions)) {
          const entries = Object.entries(record.reactions);
          if (entries.length <= 1000 && entries.every(([actor, emoji]) => validId(actor) && !/token|password|cookie|authorization|secret/i.test(actor) && typeof emoji === 'string' && emoji.trim() && emoji.length <= 128)) {
            current.data.reactions = Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
          }
        }
      }
      const previous = metadata.get(record.id);
      if (!previous) metadata.set(record.id, current);
      else if (previous.conflicting || JSON.stringify(previous) !== JSON.stringify(current)) metadata.set(record.id, { conflicting: true });
    }
    const observed = new Map();
    for (const article of view.body.querySelectorAll('article[data-chat-message]')) {
      const wrapper = article.parentElement;
      if (!wrapper?.id?.startsWith('v2-history-')) continue;
      const messageId = wrapper.id.slice('v2-history-'.length);
      const meta = metadata.get(messageId);
      if (!messageId.trim() || messageId.length > 2048 || cached.has(messageId) || !meta || meta.conflicting) continue;
      const classes = [...article.classList];
      const self = classes.some(value => /_align-self(?:_|$)/.test(value));
      const other = classes.some(value => /_align-other(?:_|$)/.test(value));
      if (self === other || self !== meta.isSelf) continue;
      const nodes = article.querySelectorAll('[data-chat-message-surface] .v2-message-selectable');
      if (nodes.length !== 1) continue;
      const rendered = toSourceText(nodes[0]);
      if (!rendered.trim() || rendered.length > 1_000_000) continue;
      const message = { conversationId: 'observed-main', messageId, sender: self ? 'user' : 'kin', timestamp: new Date(meta.timestamp).toISOString(), content: meta.text ?? rendered, data: meta.data };
      const signature = JSON.stringify({ message, rendered });
      const previous = observed.get(messageId);
      if (!previous) observed.set(messageId, { message, signature, rendered, conflicting: false });
      else if (previous.signature !== signature) previous.conflicting = true;
    }
    const messages = [], rendered = Object.create(null);
    for (const item of observed.values()) if (!item.conflicting) {
      messages.push({ ...item.message, fingerprint: await KinexportExtract.fingerprint(item.message) });
      rendered[item.message.messageId] = item.rendered;
    }
    return messages.length ? [{ kinId: view.kinId, messages, rendered }] : [];
  }
  globalThis.KinexportDom = Object.freeze({ extractVisible, isHistoryDialog, historyView, historyIds, extractHistory, toSourceText });
})();
