import test from 'node:test';
import assert from 'node:assert/strict';
import '../plaintext.js';
const { read, createTracker } = globalThis.KinexportPlaintext;
const snap = { state: 'ready', account: { accountId: 'acct' }, kins: [{ accountId: 'acct', kinId: 'kin' }] };
function textarea(label, value, options = {}) {
  const e = { tagName: 'TEXTAREA', labels: [{ textContent: label }], value, isConnected: true, hidden: false, disabled: false,
    closest: () => options.busy ? {} : null, getBoundingClientRect: () => ({ width: options.hidden ? 0 : 100, height: 20 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } }, ...options };
  return e;
}
function doc(elements, activeElement = null) { return { querySelectorAll: () => elements, activeElement }; }
test('only labelled, visible and unfocused fields from the verified account and route are read', () => {
  const personality = textarea('Personality', 'story');
  const memory = textarea('Key Memories', '');
  const focused = textarea('Response Directive', 'typing');
  const hidden = textarea('Example Message', 'not visible', { hidden: true });
  const scene = textarea('Scene Setting', 'scene');
  const page = doc([personality, memory, focused, hidden, scene], focused);
  assert.equal(read(page, '/v2/chat/kin', snap, 'acct'), null);
  assert.equal(read(page, '/v2/kin-settings/unknown', snap, 'acct'), null);
  assert.equal(read(page, '/v2/kin-settings/kin', snap, 'different-account'), null);
  assert.deepEqual(read(page, '/v2/kin-settings/kin/', snap, 'acct'), { kinId: 'kin', fields: {
    ai_backstory_plaintext: 'story', ai_memory_plaintext: '', current_scene_plaintext: 'scene',
  } });
});
test('ambiguous duplicates, loading and invalid or oversized controls are skipped', () => {
  const page = doc([textarea('Personality','one'), textarea('Personality','two'), textarea('Key Memories','busy',{busy:true}),
    textarea('Scene Setting', 'x'.repeat(1_000_001)), textarea('Response Directive','disabled',{disabled:true}), textarea('Example Message','enc:U2FsdGVkX1cipher')]);
  assert.deepEqual(read(page, '/v2/kin-settings/kin', snap, 'acct'), { kinId: 'kin', fields: {} });
});
test('stable fields are observed once, reset on account or value changes, and focused disappearance restarts debounce', () => {
  const tracker = createTracker(1500);
  assert.deepEqual(tracker.observe('a','k',{x:'one'},0), {stable:{},pending:true});
  assert.deepEqual(tracker.observe('a','k',{x:'one'},1499), {stable:{},pending:true});
  assert.deepEqual(tracker.observe('a','k',{x:'one'},1500), {stable:{x:'one'},pending:false});
  tracker.commit({x:'one'});
  assert.deepEqual(tracker.observe('a','k',{x:'one'},3000), {stable:{},pending:false});
  assert.deepEqual(tracker.observe('a','k',{x:'two'},3001), {stable:{},pending:true});
  assert.deepEqual(tracker.observe('other','k',{x:'two'},5000), {stable:{},pending:true});
  assert.deepEqual(tracker.observe('other','k',{},6000), {stable:{},pending:false});
  assert.deepEqual(tracker.observe('other','k',{x:'two'},7000), {stable:{},pending:true});
});
