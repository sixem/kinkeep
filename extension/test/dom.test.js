import test from 'node:test';
import assert from 'node:assert/strict';
import '../extract.js';
import '../dom-extract.js';

function text(value) { return { nodeType: 3, nodeValue: value }; }
function el(tag, ...children) { return { nodeType: 1, tagName: tag.toUpperCase(), childNodes: children }; }
function article(id, content, sender = 'self') {
  return { parentElement: { id: `v2-msg-${id}`, dataset: { chatTimestamp: '1730000000000' } }, classList: [`chat_align-${sender}__hash`], querySelectorAll: () => [typeof content === 'string' ? el('p', text(content)) : content] };
}
function doc(articles) { return { querySelector: () => ({ querySelectorAll: () => articles }) }; }
const snapshot = { state: 'ready', kins: [{ kinId: 'kin-a' }], groups: [{ kinId: 'kin-a', messages: [{ messageId: 'cached' }] }] };
test('DOM fallback is limited to a verified route, Kin and uncached IDs', async () => {
  const { extractVisible } = globalThis.KinexportDom;
  const page = doc([article('cached', 'rendered form differs from cache'), article('new', 'visible', 'other')]);
  assert.deepEqual(await extractVisible(page, '/v2/chat/kin-a/extra', snapshot), []);
  assert.deepEqual(await extractVisible(page, '/v2/chat/unknown', snapshot), []);
  const groups = await extractVisible(page, '/v2/chat/kin-a/', snapshot);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kinId, 'kin-a');
  const [message] = groups[0].messages;
  assert.equal(message.messageId, 'new');
  assert.equal(message.sender, 'kin');
  assert.equal(message.content, 'visible');
  assert.equal(message.data.captureSource, 'dom');
  assert.match(message.fingerprint, /^[0-9a-f]{64}$/);
});
test('conflicting visible duplicates are skipped', async () => {
  const page = doc([article('same', 'one'), article('same', 'two')]);
  assert.deepEqual(await globalThis.KinexportDom.extractVisible(page, '/v2/chat/kin-a', snapshot), []);
});
test('narration, emphasis, nested formatting and whitespace are reconstructed from text nodes', async () => {
  const p = el('p', text('Hello '), el('em', text('smiles')), text(' and '), el('strong', text('speaks '), el('i', text('softly'))), text('.'));
  assert.equal(globalThis.KinexportDom.toSourceText(p), 'Hello *smiles* and **speaks *softly***.');
  const page = doc([article('new', p)]);
  const [group] = await globalThis.KinexportDom.extractVisible(page, '/v2/chat/kin-a', snapshot);
  assert.equal(group.messages[0].content, 'Hello *smiles* and **speaks *softly***.');
  assert.notEqual(group.messages[0].fingerprint, await globalThis.KinexportExtract.fingerprint({ ...group.messages[0], fingerprint: undefined, content: 'Hello smiles and speaks softly.' }));
});
test('line breaks, paragraphs and surrounding emphasis spaces are preserved', () => {
  const root = el('div', el('p', text('first '), el('em', text(' wave ')), el('br'), text('second')), el('p', text('third')), el('div', text('fourth')));
  assert.equal(globalThis.KinexportDom.toSourceText(root), 'first * wave *\nsecond\n\nthird\nfourth');
});
test('emphasis retains all original text-node whitespace inside delimiters', () => {
  const root = el('p', el('em', text('  smiles \n ')), el('strong', text(' bold ')));
  assert.equal(globalThis.KinexportDom.toSourceText(root), '*  smiles \n *** bold **');
});
test('hidden nodes and non-content markup are ignored; literal HTML-looking text stays text', () => {
  const hidden = el('span', text('secret')); hidden.hidden = true;
  const root = el('div', text('<example> '), hidden, el('script', text('unsafe')), el('em', text('visible')));
  assert.equal(globalThis.KinexportDom.toSourceText(root), '<example> *visible*');
});

function historyArticle(id, content, sender = 'self') {
  const item = article(id, content, sender);
  item.parentElement.id = `v2-history-${id}`;
  return item;
}
function historyPage(articles) {
  const body = { querySelectorAll: () => articles };
  const dialog = { isConnected: true, hidden: false, getAttribute: name => name === 'aria-label' ? 'Chat history' : null, getBoundingClientRect: () => ({ width: 100, height: 100 }), querySelectorAll: () => [body] };
  const document = { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }, querySelectorAll: () => [dialog] };
  return { document, dialog, body };
}
test('history captures rendered narration only with matching scoped Kin, timestamp, sender and ID', async () => {
  const page = historyPage([historyArticle('cached', 'cached'), historyArticle('history-id', el('p', text('Hi '), el('em', text('smiles'))), 'other'), historyArticle('no-time', 'missing timestamp')]);
  const { historyView, historyIds, extractHistory } = globalThis.KinexportDom;
  assert.equal(historyView(page.document, '/v2/kin-settings/unknown', snapshot), null);
  assert.equal(historyView(page.document, '/v2/chat/kin-a', snapshot), null);
  const view = historyView(page.document, '/v2/kin-settings/kin-a', snapshot);
  assert.deepEqual(historyIds(view), ['cached', 'history-id', 'no-time']);
  const groups = await extractHistory(view, [
    { id: 'cached', timestamp: 1730000000000, isSelf: true },
    { id: 'history-id', timestamp: 1730000000123, isSelf: false },
    { id: 'no-time', timestamp: null, isSelf: true },
    { id: 'not-rendered', timestamp: 1730000000000, isSelf: true },
  ], snapshot);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].messages.map(m => [m.messageId, m.sender, m.timestamp, m.content]), [['history-id', 'kin', '2024-10-27T03:33:20.123Z', 'Hi *smiles*']]);
  assert.equal(groups[0].messages[0].data.captureSource, 'dom');
});
test('history refuses ambiguous metadata, mismatched sender, duplicate conflicting content and hidden dialog', async () => {
  const page = historyPage([historyArticle('conflict', 'one'), historyArticle('conflict', 'two'), historyArticle('sender', 'three'), historyArticle('time', 'four')]);
  const { historyView, extractHistory } = globalThis.KinexportDom;
  const view = historyView(page.document, '/v2/kin-settings/kin-a', snapshot);
  const ms = 1730000000000;
  assert.deepEqual(await extractHistory(view, [{ id: 'conflict', timestamp: ms, isSelf: true }, { id: 'sender', timestamp: ms, isSelf: false }, { id: 'time', timestamp: ms, isSelf: true }, { id: 'time', timestamp: ms + 1, isSelf: true }], snapshot), []);
  page.dialog.hidden = true;
  assert.equal(historyView(page.document, '/v2/kin-settings/kin-a', snapshot), null);
});
test('history prefers exact original text and verified metadata over rendered formatting', async () => {
  const page = historyPage([historyArticle('id', el('p', text('Hi '), el('em', text('smiles'))), 'other')]);
  const view = globalThis.KinexportDom.historyView(page.document, '/v2/kin-settings/kin-a', snapshot);
  const [group] = await globalThis.KinexportDom.extractHistory(view, [{ id: 'id', timestamp: 1730000000000, isSelf: false,
    text: 'Hi _smiles_\n\nExact', persona: 'P', reactions: { 'kin:k': '❤️' }, reactionsRevision: 2, chatHistoryRecordId: 'record', senderAiId: 'kin-a', token: 'never' }], snapshot);
  assert.equal(group.messages[0].content, 'Hi _smiles_\n\nExact');
  assert.deepEqual(group.messages[0].data, { captureSource: 'history', persona: 'P', chatHistoryRecordId: 'record', senderAiId: 'kin-a', reactionsRevision: 2, reactions: { 'kin:k': '❤️' } });
  assert.equal(group.rendered.id, 'Hi *smiles*');
  assert.deepEqual(await globalThis.KinexportDom.extractHistory(view, [
    { id: 'id', timestamp: 1730000000000, isSelf: false, text: 'one' },
    { id: 'id', timestamp: 1730000000000, isSelf: false, text: 'two' },
  ], snapshot), []);
});
test('history dialog label accepts observed capitalization and whitespace only', () => {
  const { isHistoryDialog } = globalThis.KinexportDom;
  const dialog = label => ({ getAttribute: () => label });
  assert.equal(isHistoryDialog(dialog('Chat history')), true);
  assert.equal(isHistoryDialog(dialog('  CHAT   HISTORY  ')), true);
  assert.equal(isHistoryDialog(dialog('History')), false);
  assert.equal(isHistoryDialog(dialog('Chat settings')), false);
  assert.equal(isHistoryDialog(null), false);
});
