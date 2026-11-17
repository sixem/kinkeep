import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('welcome version matches the server package', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(html.includes(`Version ${version}`));
});

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.listeners = {}; this._text = ''; this.hidden = false; this.value = ''; this.parentNode = null; this.style = {}; this.isConnected = true; this.clientWidth = 900; this.clientHeight = 600;
    this.layoutVisible = true; this.scrollHeight = 1000; this._scrollTop = 0; this.scrollEvents = [];
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => { this.scrollEvents.push({ action: 'reveal', value }); classes.delete(value); }, contains: value => classes.has(value) };
  }
  set scrollTop(value) { this._scrollTop = value; this.scrollEvents.push({ action: 'scroll', value, concealed: this.classList.contains('messages--concealed') }); }
  get scrollTop() { return this._scrollTop; }
  scrollTo(options) { this.lastScrollTo = options; this.scrollTop = Math.min(options.top, Math.max(0, this.scrollHeight - this.clientHeight)); this.listeners.scroll?.(); }
  getClientRects() { return this.layoutVisible ? [{}] : []; }
  decode() { return Promise.resolve(); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this._text = ''; this.children = [...children]; }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (selector === 'button:not(:disabled)' && child.tagName === 'button' && !child.disabled) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this); this.parentNode = null; }
  querySelector(tag) { for (const child of this.children) { if (child.tagName === tag) return child; const result = child.querySelector(tag); if (result) return result; } return null; }
  click() { return this.listeners.click?.({ target: this }); }
}

test('dashboard uses the same local timestamp for the download ticket and filename', async () => {
  const elements = new Map(), anchors = [], tickets = [];
  const document = {
    addEventListener() {},
    querySelector(selector) { if (!elements.has(selector)) { const node = new Element(); node.ownerDocument = this; elements.set(selector, node); } return elements.get(selector); },
    createElement(tag) { const node = new Element(tag); node.ownerDocument = this; if (tag === 'a') anchors.push(node); return node; },
    createElementNS(_namespace, tag) { return this.createElement(tag); },
    createTextNode(value) { const node = this.createElement('#text'); node.textContent = value; return node; },
  };
  const fetch = async (url, options) => { assert.equal(url, '/api/download-ticket'); tickets.push(JSON.parse(options.body)); return { ok: true }; };
  const context = { document, fetch, sessionStorage: { getItem: () => '', setItem() {}, removeItem() {} }, URLSearchParams, URL, Date, setTimeout: () => 0, clearTimeout() {}, console };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await context.startDownload('portable');
  await context.startDownload('sqlite');
  assert.equal(tickets[0].format, 'portable');
  assert.equal(tickets[1].format, 'sqlite');
  assert.match(tickets[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:Z|[+-]\d{2}-\d{2})$/);
  assert.equal(anchors[0].download, `kinexport-${tickets[0].timestamp}.zip`);
  assert.equal(anchors[1].download, `kinexport-backup-${tickets[1].timestamp}.sqlite3`);
});

test('single account and conversation open automatically, and refresh keeps the selected Kin', async () => {
  const elements = new Map();
  const document = { activeElement: null, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, querySelector(selector) { if (!elements.has(selector)) { const node = new Element(); node.ownerDocument = this; elements.set(selector, node); } return elements.get(selector); }, createElement(tag) { const node = new Element(tag); node.ownerDocument = this; return node; }, createElementNS(_namespace, tag) { return this.createElement(tag); }, createTextNode(value) { const node = new Element('#text'); node.ownerDocument = this; node.textContent = value; return node; } };
  const routes = {
    '/api/digest': { kins: 2, conversations: 1, messages: 1, lastArchivedAt: null },
    '/api/accounts': { accounts: [{ accountId: 'account', displayName: 'Account' }] },
    '/api/conversations': { conversations: [] },
    '/api/kins?accountId=account': { kins: [{ kinId: 'alpha', name: 'Alpha' }, { kinId: 'beta', name: 'Beta' }] },
    '/api/kins/profile?accountId=account&kinId=alpha': { fields: {
      ai_backstory: { value: 'v1:U2FsdGVkX1abc123', observedAt: null, history: [] },
      ai_backstory_plaintext: { value: 'Sample profile', observedAt: '2026-01-01T12:00:00Z', recordedAt: '2026-01-01T12:01:00Z', history: [] },
      ai_memory: { value: 'v1:U2FsdGVkX1abc123', observedAt: null, history: [] },
      sample_setting: { value: 'Observed setting', observedAt: null, history: [{ value:'Earlier value',observedAt:null,recordedAt:'2026-01-01T00:00:00Z' }] },
      sample_flag: { value: false, observedAt: null, history: [] },
      sample_long_setting: { value: 'First line\nSecond line', observedAt: null, history: [] },
    } },
    '/api/kins/journal?accountId=account&kinId=alpha&limit=50&offset=0': { accountId: 'account', kinId: 'alpha', entries: [
      { entryId: 'older', createdAt: '2026-01-01T12:00:00Z', description: 'Older journal', keywords: ['one'], revisions: [{ description: 'Different journal observation', keywords: [], recordedAt: '2026-01-01T00:00:00Z' }] },
      { entryId: 'newer', createdAt: '2026-01-02T00:15:00Z', description: '<script>Newest journal</script>', keywords: ['two'], revisions: [{ description: 'Another journal observation', keywords: ['old'], recordedAt: '2026-01-01T00:00:00Z' }, { description: 'Second journal observation', keywords: [], recordedAt: '2026-01-01T00:00:00Z' }] },
    ], total: 51, nextOffset: 50 },
    '/api/kins/journal?accountId=account&kinId=alpha&limit=50&offset=50': { accountId: 'account', kinId: 'alpha', entries: [{ entryId: 'page2', createdAt: '2025-01-01T00:00:00Z', description: 'Second journal page', keywords: [], revisions: [] }], total: 51, nextOffset: null },
    '/api/kins/journal?accountId=account&kinId=beta&limit=50&offset=0': { accountId: 'account', kinId: 'beta', entries: [{ entryId: 'beta', createdAt: '2026-01-01T00:00:00Z', description: 'Stale beta entry', keywords: [], revisions: [] }], total: 1, nextOffset: null },
    '/api/kins/profile?accountId=account&kinId=beta': { fields: {} },
    '/api/kins/media?accountId=account&kinId=alpha&limit=20&offset=0': { accountId: 'account', kinId: 'alpha', items: [{ sha256: 'a'.repeat(64), kind: 'selfie', variant: 'preview', createdAt: '2026-01-01T00:00:00Z', prompt: 'Sample prompt' }], total: 1, nextOffset: null },
    '/api/conversations?accountId=account&kinId=beta': { conversations: [] },
    '/api/conversations?accountId=account&kinId=alpha': { conversations: [{ id: 'observed-main', messageCount: 3 }] },
    '/api/search?q=sample': { messages: [
      { sender: 'kin', kinName: 'Beta', content: 'Older search result', timestamp: '2026-01-01T12:00:00Z' },
      { sender: 'kin', kinName: 'Beta', content: 'Newer search result', timestamp: '2026-01-02T00:15:00Z' },
    ] },
    '/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha': { messages: [
      { sender: 'user', content: 'Newer message *narration*', timestamp: '2026-01-02T00:15:00Z', revisions: [{ content: 'Earlier *rendering*', recordedAt: '2026-01-01T00:00:00Z' }] },
      { sender: 'kin', content: 'Older message', timestamp: '2026-01-01T12:00:00Z', revisions: [] },
      { sender: 'kin', content: 'Equal timestamp', timestamp: '2026-01-01T12:00:00Z', revisions: [] },
      { sender: 'kin', content: 'Undated message', timestamp: null, revisions: [] },
    ], nextCursor: 'older-key', newerCursor: null, total: 51 },
    '/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha&cursor=older-key': { messages: [
      { sender: 'kin', content: 'Earlier page', timestamp: '2025-01-01T00:00:00Z', revisions: [] },
    ], nextCursor: null, newerCursor: 'newer-key', total: 51 },
  };
  routes['/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha&direction=oldest'] = routes['/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha&cursor=older-key'];
  routes['/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha&direction=newer&cursor=newer-key'] = routes['/api/messages?conversationId=observed-main&limit=50&accountId=account&kinId=alpha'];
  const calls = [];
  let releaseProfile;
  const profileGate = new Promise((resolve) => { releaseProfile = resolve; });
  let delayProfile = true;
  let releaseBetaJournal;
  const betaJournalGate = new Promise((resolve) => { releaseBetaJournal = resolve; });
  let releaseKins, kinsGate = null;
  let releaseOlderMessages, olderMessagesGate = null;
  const fetch = async (url) => {
    calls.push(url);
    if ([`/api/media/blob?sha256=${'a'.repeat(64)}`, `/api/media/thumbnail?sha256=${'a'.repeat(64)}`].includes(url)) return { ok: true, blob: async () => new Blob(['sample'], { type: 'image/webp' }) };
    if (!routes[url]) throw new Error(`Unexpected test request: ${url}`);
    if (url.startsWith('/api/kins/profile?') && delayProfile) { delayProfile = false; await profileGate; }
    if (url.startsWith('/api/kins/journal?accountId=account&kinId=beta')) await betaJournalGate;
    if (url.startsWith('/api/kins?accountId=') && kinsGate) await kinsGate;
    if (url.includes('/api/messages?') && url.includes('cursor=older-key') && olderMessagesGate) await olderMessagesGate;
    return { ok: true, json: async () => routes[url] };
  };
  const sessionStorage = { getItem: () => 'test-token', setItem() {}, removeItem() {} };
  const context = { document, fetch, sessionStorage, URLSearchParams, URL, Date, setTimeout: () => 0, clearTimeout() {}, console };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const localDate = { getFullYear: () => 2026, getMonth: () => 0, getDate: () => 2, getHours: () => 3, getMinutes: () => 4, getSeconds: () => 5 };
  assert.equal(context.downloadTimestamp({ ...localDate, getTimezoneOffset: () => -330 }), '2026-01-02T03-04-05+05-30');
  assert.equal(context.downloadTimestamp({ ...localDate, getTimezoneOffset: () => 210 }), '2026-01-02T03-04-05-03-30');
  assert.equal(context.downloadTimestamp({ ...localDate, getTimezoneOffset: () => 0 }), '2026-01-02T03-04-05Z');
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush(); await flush();
  assert.equal(elements.get('#welcome-panel').hidden, false);
  assert.equal(elements.get('#message-panel').hidden, true);
  for (const section of ['messages', 'personality', 'journal', 'settings']) assert.equal(elements.get(`#nav-${section}`)['aria-current'], undefined);
  assert.match(elements.get('#kins').textContent, /Alpha/);
  assert.equal(calls.filter((url) => url === '/api/kins?accountId=account').length, 1);
  for (const id of ['#messages', '#profile', '#settings-profile', '#journal-entries']) {
    assert.equal(elements.get(id).textContent, 'Select a Kin above to view this page.');
    assert.match(elements.get(id).children[0].className, /empty-state/);
  }
  const messageContainer = document.querySelector('#messages');
  messageContainer.layoutVisible = false;
  const selection = elements.get('#kins').children[0].children[0].click();
  assert.equal(elements.get('#welcome-panel').hidden, true);
  assert.equal(elements.get('#message-panel').hidden, false);
  assert.equal(elements.get('#nav-messages')['aria-current'], 'page');
  await flush();
  assert.equal(elements.get('#profile').children[0].className, 'loading-skeleton');
  assert.doesNotMatch(elements.get('#profile').textContent, /loading/i);
  releaseProfile();
  await selection;
  assert.equal(messageContainer.classList.contains('messages--concealed'), true);
  assert.equal(messageContainer.scrollTop, 0);
  assert.match(elements.get('#profile').textContent, /Sample profile/);
  const personalityField = elements.get('#profile').querySelector('textarea');
  assert.equal(personalityField.readOnly, true);
  assert.equal(personalityField.value, 'Sample profile');
  assert.equal(personalityField['aria-label'], 'Backstory');
  const settingsField = elements.get('#settings-profile').querySelector('input');
  assert.equal(settingsField.readOnly, true);
  assert.equal(settingsField.value, 'Observed setting');
  assert.equal(settingsField.type, 'text');
  const settingSections = elements.get('#settings-profile').children;
  const flag = settingSections.find(section => section.querySelector('h3').textContent === 'Sample flag');
  assert.equal(flag.querySelector('input').value, 'false');
  const longSetting = settingSections.find(section => section.querySelector('h3').textContent === 'Sample long setting');
  assert.equal(longSetting.querySelector('textarea').value, 'First line\nSecond line');
  const settingHistory = settingSections[0].querySelector('details');
  settingHistory.open = true; settingHistory.listeners.toggle();
  assert.equal(settingHistory.querySelector('input').value, 'Earlier value');
  await elements.get('#nav-images').click(); await flush();
  assert.equal(elements.get('#images-panel').hidden, false);
  const imageButton = elements.get('#images-entries').querySelector('button');
  assert.equal(imageButton['aria-label'], 'Open Selfie preview');
  assert.match(imageButton.textContent, /2026/);
  assert.ok(calls.some(url => url.startsWith('/api/media/thumbnail?')));
  assert.equal(calls.some(url => url.startsWith('/api/media/blob?')), false);
  let releaseImageDecode;
  elements.get('#image-viewer-image').decode = () => new Promise(resolve => { releaseImageDecode = resolve; });
  imageButton.click(); await flush();
  assert.equal(elements.get('#image-viewer').hidden, true);
  assert.equal(imageButton['aria-busy'], 'true');
  releaseImageDecode(); await flush();
  assert.equal(elements.get('#image-viewer').hidden, false);
  assert.equal(imageButton['aria-busy'], undefined);
  assert.equal(elements.get('#image-viewer-title').textContent, 'Selfie preview');
  assert.equal(elements.get('#image-viewer-prompt').value, 'Sample prompt');
  assert.equal(elements.get('#image-viewer-download').href, elements.get('#image-viewer-image').src);
  assert.match(elements.get('#image-viewer-download').download, /^kinexport-selfie-preview-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:Z|[+-]\d{2}-\d{2})\.webp$/);
  const tab = shiftKey => elements.get('#image-viewer').listeners.keydown({ key:'Tab', shiftKey, preventDefault() {} });
  tab(false); assert.equal(document.activeElement, elements.get('#image-viewer-content'));
  tab(false); assert.equal(document.activeElement, elements.get('#image-viewer-prompt'));
  tab(false); assert.equal(document.activeElement, elements.get('#image-viewer-download'));
  tab(false); assert.equal(document.activeElement, elements.get('#image-viewer-close'));
  tab(true); assert.equal(document.activeElement, elements.get('#image-viewer-download'));
  assert.ok(calls.some(url => url.startsWith('/api/media/blob?')));
  elements.get('#image-viewer').listeners.keydown({ key:'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(elements.get('#image-viewer').hidden, true);
  assert.equal(elements.get('#image-viewer-download').href, undefined);
  assert.equal(document.activeElement, imageButton);
  imageButton.click(); await flush();
  elements.get('#nav-messages').click();
  releaseImageDecode(); await flush();
  assert.equal(elements.get('#image-viewer').hidden, true);
  assert.equal(imageButton['aria-busy'], undefined);
  assert.doesNotMatch(elements.get('#profile').children[0].className, /empty-state/);
  assert.match(elements.get('#profile').textContent, /Observed/);
  assert.equal(elements.get('#profile').children[0].children[1].title, undefined);
  assert.doesNotMatch(elements.get('#profile').textContent, /Archived|Kindroid editor|First observed|Updated/);
  assert.match(elements.get('#settings-profile').textContent, /Observed setting/);
  assert.equal(calls.filter(url => url.startsWith('/api/kins/journal?')).length, 0);
  assert.doesNotMatch(elements.get('#profile').textContent, /Observed setting/);
  assert.equal(elements.get('#account-label').textContent, 'Account (account)');
  assert.equal(elements.get('#account-trigger')['aria-label'], 'Account: Account (account)');
  assert.equal(elements.get('#accounts').children[0].children[0].children[1].textContent, 'account');
  assert.equal(elements.get('#kin-label').textContent, 'Alpha');
  const accountOptions = elements.get('#account-options');
  accountOptions.append(elements.get('#accounts'));
  accountOptions.hidden = true;
  elements.get('#account-trigger').click();
  assert.equal(accountOptions.hidden, false);
  assert.equal(elements.get('#account-trigger')['aria-expanded'], 'true');
  document.listeners.keydown({ key: 'Escape' });
  assert.equal(accountOptions.hidden, true);
  assert.equal(document.activeElement, elements.get('#account-trigger'));
  elements.get('#account-trigger').listeners.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(document.activeElement, elements.get('#accounts').children[0].children[0]);
  accountOptions.listeners.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(document.activeElement, elements.get('#account-trigger'));
  elements.get('#account-trigger').click();
  document.listeners.click({ target: new Element() });
  assert.equal(accountOptions.hidden, true);
  const backupOptions = elements.get('#backup-options');
  backupOptions.hidden = true;
  backupOptions.append(elements.get('#backup-download'), elements.get('#backup-restore'));
  elements.get('#backup-trigger').click();
  assert.equal(backupOptions.hidden, false);
  assert.equal(elements.get('#backup-trigger')['aria-expanded'], 'true');
  let openedBackupPicker = false;
  elements.get('#backup-file').click = () => { openedBackupPicker = true; };
  elements.get('#backup-restore').click();
  assert.equal(openedBackupPicker, true);
  assert.equal(backupOptions.hidden, true);
  assert.equal(document.activeElement, elements.get('#backup-trigger'));
  elements.get('#nav-personality').click();
  assert.equal(elements.get('#personality-panel').hidden, false);
  assert.equal(elements.get('#message-panel').hidden, true);
  assert.equal(elements.get('#conversation-panel').hidden, true);
  assert.equal(elements.get('#nav-personality')['aria-current'], 'page');
  await elements.get('#kins').children[0].children[0].click();
  assert.equal(elements.get('#personality-panel').hidden, false);
  assert.equal(elements.get('#nav-personality')['aria-current'], 'page');
  elements.get('#home').click();
  assert.equal(elements.get('#welcome-panel').hidden, false);
  assert.equal(elements.get('#personality-panel').hidden, true);
  assert.equal(elements.get('#nav-personality')['aria-current'], undefined);
  assert.equal(elements.get('#account-label').textContent, 'Account (account)');
  assert.equal(elements.get('#kin-label').textContent, 'Alpha');
  await elements.get('#kins').children[0].children[0].click();
  assert.equal(elements.get('#message-panel').hidden, false);
  assert.equal(elements.get('#nav-messages')['aria-current'], 'page');
  elements.get('#nav-personality').click();
  assert.equal(elements.get('#personality-panel').hidden, false);
  await elements.get('#nav-journal').click();
  assert.equal(elements.get('#journal-panel').hidden, false);
  assert.equal(elements.get('#personality-panel').hidden, true);
  assert.equal(elements.get('#nav-journal')['aria-current'], 'page');
  const journal = elements.get('#journal-entries');
  assert.ok(journal.textContent.indexOf('Newest journal') < journal.textContent.indexOf('Older journal'));
  assert.equal(journal.children[0].children[1].tagName, 'p');
  assert.equal(journal.children[0].children[1].textContent, '<script>Newest journal</script>');
  assert.equal(elements.get('#journal-count').textContent, '51 entries');
  assert.doesNotMatch(journal.textContent, /\b(?:AM|PM)\b/i);
  const journalDetails = journal.children[0].querySelector('details');
  assert.equal(journalDetails.querySelector('summary').textContent, '2 other observations');
  assert.equal(journal.children[1].querySelector('summary').textContent, '1 other observation');
  assert.doesNotMatch(journalDetails.textContent, /Another journal observation/);
  journalDetails.open = true; journalDetails.listeners.toggle();
  assert.match(journalDetails.textContent, /Another journal observation/);
  assert.match(elements.get('#journal-paging').textContent, /Page 1 of 2/);
  assert.equal(elements.get('#journal-paging').children[0].children[0]['aria-label'], 'Newest journal entries');
  assert.equal(elements.get('#journal-paging').children[2].children[1]['aria-label'], 'Oldest journal entries');
  assert.equal(elements.get('#journal-paging').children[0].children[0].disabled, true);
  await elements.get('#journal-paging').children[2].children[0].click();
  assert.match(journal.textContent, /Second journal page/);
  assert.equal(elements.get('#journal-paging').children[2].children[1].disabled, true);
  await elements.get('#journal-paging').children[0].children[1].click();
  assert.match(journal.textContent, /Newest journal/);
  await elements.get('#journal-paging').children[2].children[1].click();
  assert.match(journal.textContent, /Second journal page/);
  await elements.get('#journal-paging').children[0].children[0].click();
  assert.match(journal.textContent, /Newest journal/);
  // A delayed response for the previously selected Kin must never replace Alpha's journal.
  await elements.get('#kins').children[1].children[0].click();
  await flush();
  assert.match(elements.get('#profile').children[0].className, /empty-state/);
  assert.match(elements.get('#settings-profile').children[0].className, /empty-state/);
  await elements.get('#kins').children[0].children[0].click();
  await flush();
  releaseBetaJournal(); await flush();
  assert.match(journal.textContent, /Newest journal/);
  assert.doesNotMatch(journal.textContent, /Stale beta entry/);
  elements.get('#nav-settings').click();
  assert.equal(elements.get('#settings-panel').hidden, false);
  assert.equal(elements.get('#personality-panel').hidden, true);
  messageContainer.layoutVisible = true;
  elements.get('#nav-messages').click();
  assert.equal(elements.get('#message-panel').hidden, false);
  assert.equal(messageContainer.scrollTop, messageContainer.scrollHeight);
  assert.equal(messageContainer.classList.contains('messages--concealed'), false);
  const lastScroll = messageContainer.scrollEvents.findLastIndex(item => item.action === 'scroll');
  assert.equal(messageContainer.scrollEvents[lastScroll].concealed, true);
  assert.equal(messageContainer.scrollEvents[lastScroll + 1].action, 'reveal');
  assert.equal(elements.get('#conversation-panel').hidden, true);
  assert.match(elements.get('#profile').textContent, /Not recorded/);
  assert.doesNotMatch(elements.get('#profile').textContent, /U2FsdGVkX1/);
  assert.match(elements.get('#conversations').textContent, /Chat history/);
  const messages = elements.get('#messages').textContent;
  assert.ok(messages.indexOf('Undated message') < messages.indexOf('Equal timestamp'));
  assert.ok(messages.indexOf('Equal timestamp') < messages.indexOf('Older message'));
  assert.ok(messages.indexOf('Older message') < messages.indexOf('Newer message'));
  assert.doesNotMatch(messages, /\b(?:AM|PM)\b/i);
  assert.equal(elements.get('#messages').children[3].querySelector('em').textContent, 'narration');
  assert.equal(elements.get('#messages').children[3].querySelector('strong').textContent, 'You');
  assert.equal(elements.get('#messages').children[1].querySelector('strong').textContent, 'Alpha');
  assert.match(elements.get('#messages').children[3].className, /message--self/);
  assert.match(elements.get('#messages').children[1].className, /message--kin/);
  assert.equal(elements.get('#selected-message-count').textContent, '51 messages');
  assert.match(elements.get('#message-paging').textContent, /Page 2 of 2/);
  const details = elements.get('#messages').children[3].querySelector('details');
  assert.doesNotMatch(details.textContent, /Earlier rendering/);
  details.open = true; details.listeners.toggle();
  assert.match(details.textContent, /Earlier rendering/);
  const messagePaging = elements.get('#message-paging');
  assert.equal(messagePaging.children[0].children[0]['aria-label'], 'Oldest messages');
  assert.equal(messagePaging.children[0].children[1]['aria-label'], 'Older messages');
  assert.equal(messagePaging.children[2].children[0]['aria-label'], 'Newer messages');
  assert.equal(messagePaging.children[2].children[1]['aria-label'], 'Newest messages');
  assert.equal(messagePaging.children[0].children[0].children.length, 2);
  assert.equal(messagePaging.children[0].children[1].children.length, 1);
  assert.equal(messagePaging.children[2].children[0].disabled, true);
  const toTop = elements.get('#messages-scroll-top'), toBottom = elements.get('#messages-scroll-bottom');
  assert.equal(toTop.disabled, false);
  assert.equal(toBottom.disabled, true);
  messageContainer.scrollTop = 200; messageContainer.listeners.scroll();
  assert.equal(toTop.disabled, false);
  assert.equal(toBottom.disabled, false);
  toTop.click();
  assert.equal(messageContainer.scrollTop, 0);
  assert.equal(messageContainer.lastScrollTo.behavior, 'instant');
  assert.equal(toTop.disabled, true);
  assert.equal(toBottom.disabled, false);
  toBottom.click();
  assert.equal(messageContainer.scrollTop, 400);
  assert.equal(toTop.disabled, false);
  assert.equal(toBottom.disabled, true);
  messageContainer.scrollHeight = messageContainer.clientHeight; messageContainer.listeners.scroll();
  assert.equal(toTop.disabled, false); // The mock does not clamp scrollTop on a resize.
  messageContainer.scrollTop = 0; messageContainer.listeners.scroll();
  assert.equal(toTop.disabled, true);
  assert.equal(toBottom.disabled, true);
  messageContainer.scrollHeight = 1000;
  olderMessagesGate = new Promise(resolve => { releaseOlderMessages = resolve; });
  const olderPage = messagePaging.children[0].children[1].click();
  await flush(); elements.get('#nav-personality').click(); releaseOlderMessages(); await olderPage; olderMessagesGate = null;
  elements.get('#nav-messages').click();
  assert.match(elements.get('#messages').textContent, /Earlier page/);
  assert.equal(messageContainer.scrollTop, 0);
  assert.equal(messageContainer.classList.contains('messages--concealed'), false);
  assert.match(elements.get('#message-paging').textContent, /Page 1 of 2/);
  await elements.get('#message-paging').children[2].children[0].click();
  assert.match(elements.get('#messages').textContent, /Newer message/);
  assert.equal(messageContainer.scrollTop, 0);
  await elements.get('#message-paging').children[0].children[0].click();
  assert.match(elements.get('#message-paging').textContent, /Page 1 of 2/);
  assert.equal(messageContainer.scrollTop, 0);
  await elements.get('#message-paging').children[2].children[1].click();
  assert.match(elements.get('#message-paging').textContent, /Page 2 of 2/);
  assert.equal(messageContainer.scrollTop, 0);
  document.querySelector('#search').value = 'sample';
  await elements.get('#search-form').listeners.submit({ preventDefault() {} });
  const search = elements.get('#search-results').textContent;
  assert.ok(search.indexOf('Newer search result') < search.indexOf('Older search result'));
  assert.equal(elements.get('#search-results').children[2].querySelector('strong').textContent, 'Beta');
  kinsGate = new Promise(resolve => { releaseKins = resolve; });
  const refreshing = elements.get('#refresh').click();
  await flush();
  for (const id of ['#messages', '#profile', '#settings-profile', '#journal-entries', '#images-entries']) {
    assert.equal(elements.get(id).children[0].className, 'loading-skeleton');
    assert.doesNotMatch(elements.get(id).textContent, /Select a Kin/);
  }
  releaseKins(); await refreshing; kinsGate = null;
  assert.equal(elements.get('#kins').children[0].children[0]['aria-pressed'], 'true');
  assert.match(elements.get('#messages').textContent, /Newer message/);
  assert.match(elements.get('#toasts').textContent, /Archive refreshed\./);
  elements.get('#toasts').children[0].children[1].click();
  assert.equal(elements.get('#toasts').children.length, 0);
  routes['/api/conversations?accountId=account&kinId=alpha'].conversations.push({ id: 'imported', messageCount: 1 });
  routes['/api/messages?conversationId=imported&limit=50&accountId=account&kinId=alpha'] = { messages: [{ sender: 'kin', content: 'Imported conversation', timestamp: '2026-01-01T00:00:00Z', revisions: [] }], nextCursor: null, newerCursor: null, total: 1 };
  await elements.get('#refresh').click();
  assert.equal(elements.get('#conversation-panel').hidden, false);
  assert.equal(elements.get('#conversation-label').textContent, 'Chat history');
  elements.get('#conversation-trigger').click();
  assert.equal(elements.get('#conversation-options').hidden, false);
  await elements.get('#conversations').children[1].children[0].click();
  assert.equal(elements.get('#conversation-options').hidden, true);
  assert.match(elements.get('#messages').textContent, /Imported conversation/);
  await elements.get('#refresh').click();
  assert.match(elements.get('#messages').textContent, /Imported conversation/);
  routes['/api/kins/media?accountId=account&kinId=alpha&limit=20&offset=0'].items = [];
  routes['/api/kins/media?accountId=account&kinId=alpha&limit=20&offset=0'].total = 0;
  await elements.get('#nav-images').click(); await flush();
  assert.match(elements.get('#images-entries').textContent, /No images archived/);
  assert.match(elements.get('#images-entries').children[0].className, /empty-state/);
  routes['/api/conversations'].conversations.push({ id: 'legacy-main', kinName: 'Legacy', messageCount: 1 });
  routes['/api/messages?conversationId=legacy-main&limit=50'] = { messages: [{ sender: 'kin', content: 'Unassigned message', timestamp: '2026-01-01T00:00:00Z', revisions: [] }], nextCursor: null, newerCursor: null, total: 1 };
  await elements.get('#refresh').click();
  const journalCallsBeforeLegacy = calls.filter(url => url.startsWith('/api/kins/journal?')).length;
  await elements.get('#accounts').children[1].children[0].click();
  await elements.get('#nav-journal').click();
  assert.equal(calls.filter(url => url.startsWith('/api/kins/journal?')).length, journalCallsBeforeLegacy);
  assert.match(elements.get('#journal-entries').textContent, /no associated Kin journal/i);
  assert.match(elements.get('#journal-entries').children[0].className, /empty-state/);
  assert.equal(elements.get('#conversation-panel').hidden, true);
  assert.match(elements.get('#messages').textContent, /Unassigned message/);
});

test('an automatically selected conversation scrolls before the archive becomes visible', async () => {
  const elements = new Map();
  const document = {
    activeElement: null, addEventListener() {},
    querySelector(selector) {
      if (!elements.has(selector)) { const node = new Element(); node.ownerDocument = this; elements.set(selector, node); }
      return elements.get(selector);
    },
    createElement(tag) { const node = new Element(tag); node.ownerDocument = this; return node; },
    createElementNS(_namespace, tag) { return this.createElement(tag); },
    createTextNode(value) { const node = new Element('#text'); node.ownerDocument = this; node.textContent = value; return node; },
  };
  const archive = document.querySelector('#archive'); archive.hidden = true;
  const messages = document.querySelector('#messages');
  messages.getClientRects = () => archive.hidden || document.querySelector('#message-panel').hidden ? [] : [{}];
  const routes = {
    '/api/digest': { kins: 1, conversations: 1, messages: 1 },
    '/api/accounts': { accounts: [{ accountId: 'a' }] },
    '/api/conversations': { conversations: [] },
    '/api/kins?accountId=a': { kins: [{ kinId: 'k', name: 'Kin' }] },
    '/api/kins/profile?accountId=a&kinId=k': { fields: {} },
    '/api/conversations?accountId=a&kinId=k': { conversations: [{ id: 'observed-main', messageCount: 1 }] },
    '/api/messages?conversationId=observed-main&limit=50&accountId=a&kinId=k': { messages: [{ sender: 'kin', content: 'Message', timestamp: '2026-01-01T00:00:00Z' }], total: 1, nextCursor: null, newerCursor: null },
  };
  const fetch = async url => { if (!routes[url]) throw new Error(`Unexpected test request: ${url}`); return { ok: true, json: async () => routes[url] }; };
  const sessionStorage = { getItem: () => 'token', setItem() {}, removeItem() {} };
  runInNewContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), { document, fetch, sessionStorage, URLSearchParams, URL, Date, setTimeout: () => 0, clearTimeout() {}, console });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(archive.hidden, false);
  assert.equal(document.querySelector('#account-label').textContent, 'Account (a)');
  assert.equal(document.querySelector('#account-trigger')['aria-label'], 'Account: Account (a)');
  assert.equal(document.querySelector('#welcome-panel').hidden, false);
  assert.equal(document.querySelector('#message-panel').hidden, true);
  assert.equal(messages.classList.contains('messages--concealed'), true);
  document.querySelector('#nav-messages').click();
  assert.equal(messages.scrollTop, messages.scrollHeight);
  assert.equal(messages.classList.contains('messages--concealed'), false);
  const position = messages.scrollEvents.findLastIndex(event => event.action === 'scroll');
  assert.ok(position >= 0);
  assert.equal(messages.scrollEvents[position].concealed, true);
  assert.equal(messages.scrollEvents[position + 1].action, 'reveal');
});

test('image grid virtualizes tiles, loads metadata on scroll, and fetches the original only in the viewer', async () => {
  const elements = new Map();
  const document = { activeElement: null, listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; }, querySelector(selector) { if (!elements.has(selector)) { const node = new Element(); node.ownerDocument = this; elements.set(selector, node); } return elements.get(selector); }, createElement(tag) { const node = new Element(tag); node.ownerDocument = this; return node; }, createElementNS(_namespace, tag) { return this.createElement(tag); }, createTextNode(value) { const node = new Element('#text'); node.ownerDocument = this; node.textContent = value; return node; } };
  const scroller = document.querySelector('#images-entries'); scroller.clientWidth = 400; scroller.clientHeight = 300;
  const calls = [], revoked = []; let serial = 0;
  class TestURL extends URL { static createObjectURL() { return `blob:test-${++serial}`; } static revokeObjectURL(url) { revoked.push(url); } }
  const fetch = async path => {
    calls.push(path);
    if (path === '/api/digest') return {ok:true,json:async()=>({kins:1,conversations:0,messages:0})};
    if (path === '/api/accounts') return {ok:true,json:async()=>({accounts:[{accountId:'a'}]})};
    if (path === '/api/conversations') return {ok:true,json:async()=>({conversations:[]})};
    if (path === '/api/kins?accountId=a') return {ok:true,json:async()=>({kins:[{kinId:'k',name:'Kin'}]})};
    if (path === '/api/kins/profile?accountId=a&kinId=k') return {ok:true,json:async()=>({fields:{}})};
    if (path === '/api/conversations?accountId=a&kinId=k') return {ok:true,json:async()=>({conversations:[]})};
    if (path.startsWith('/api/kins/media?')) {
      const offset=Number(new URL(`http://local${path}`).searchParams.get('offset'));
      const items=Array.from({length:20},(_,i)=>({sourceId:`item-${offset+i}`,sha256:(offset+i).toString(16).padStart(64,'0'),kind:'selfie',variant:'preview',prompt:`Prompt ${offset+i}`}));
      return {ok:true,json:async()=>({accountId:'a',kinId:'k',items,total:100,nextOffset:offset+20<100?offset+20:null})};
    }
    if (path.startsWith('/api/media/thumbnail?') || path.startsWith('/api/media/blob?')) return {ok:true,blob:async()=>new Blob(['image'],{type:'image/webp'})};
    throw new Error(`Unexpected request ${path}`);
  };
  const sessionStorage={getItem:()=> 'token',setItem(){},removeItem(){}};
  runInNewContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),{document,fetch,sessionStorage,URLSearchParams,URL:TestURL,Date,AbortController,setTimeout:()=>0,clearTimeout(){},console});
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();await flush();await elements.get('#nav-images').click();await flush();await flush();
  const initialThumbs=calls.filter(path=>path.startsWith('/api/media/thumbnail?')).length;
  assert.ok(initialThumbs>0 && initialThumbs<20, `loaded ${initialThumbs} thumbnails`);
  assert.equal(calls.filter(path=>path.startsWith('/api/media/blob?')).length,0);
  const grid=scroller.children[1];assert.ok(grid.children.length<=12);
  scroller.scrollTop=1400;scroller.listeners.scroll();await flush();await flush();
  assert.ok(calls.some(path=>path.includes('/api/kins/media?')&&path.includes('offset=20')));
  assert.ok(grid.children.length<=20);assert.ok(revoked.length>0);
  grid.children[0].click();await flush();
  assert.equal(elements.get('#image-viewer').hidden,false);
  assert.equal(calls.filter(path=>path.startsWith('/api/media/blob?')).length,1);
  assert.match(elements.get('#image-viewer-prompt').value,/Prompt/);
  elements.get('#image-viewer-close').click();assert.equal(elements.get('#image-viewer').hidden,true);
  elements.get('#nav-messages').click();
});
