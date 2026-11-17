import test from 'node:test';
import assert from 'node:assert/strict';
import '../profiles.js';
import '../extract.js';
const uid = 'acct';
const updated = 1730000000000;
const cacheQuery = (key, data, time = updated) => ({ queryKey: key, state: { data, dataUpdatedAt: time } });
const user = cacheQuery(['v2','user',uid], { aiList: ['kin-a', 'kin-b'] });
function wrap(queries, ownerUid = uid) { return [{ ownerUid, client: { clientState: { queries: [user, ...queries] } } }]; }
function direct(id, data, time) { return cacheQuery(['v2','kins',uid,id], { uid, ai_id: id, ...data }, time); }

test('only verified known Kin fields are captured; absent, empty, null, false and zero remain distinct', async () => {
  const page = cacheQuery(['v2','kins',uid,'page','az','',20], { pages: [{ docs: [
    { uid, ai_id: 'kin-a', ai_name: 'Alex', ai_backstory: '', ai_memory: 'Memory', time_awareness: false, selected_voice: 0, user_set_temperature: null, background_settings: { background_url: 'https://secret.invalid/?token=abc' }, api_token: 'secret' },
    { uid: 'another-account', ai_id: 'kin-b', ai_backstory: 'wrong owner' },
    { uid, ai_id: 'unknown-kin', ai_backstory: 'unknown kin' },
  ] }] });
  const snap = await globalThis.KinexportExtract.extract(uid, wrap([page]));
  assert.equal(snap.state, 'ready');
  assert.deepEqual(snap.profiles, [{ accountId: uid, kinId: 'kin-a', fields: {
    ai_backstory: { value: '', observedAt: '2024-10-27T03:33:20.000Z' },
    ai_memory: { value: 'Memory', observedAt: '2024-10-27T03:33:20.000Z' },
    ai_name: { value: 'Alex', observedAt: '2024-10-27T03:33:20.000Z' },
    selected_voice: { value: 0, observedAt: '2024-10-27T03:33:20.000Z' },
    user_set_temperature: { value: null, observedAt: '2024-10-27T03:33:20.000Z' },
    time_awareness: { value: false, observedAt: '2024-10-27T03:33:20.000Z' },
  } }]);
  assert.doesNotMatch(JSON.stringify(snap.profiles), /secret|wrong owner|unknown kin/);
  assert.equal((await globalThis.KinexportExtract.extract(uid, wrap([page], 'wrong'))).state, 'identity-uncertain');
});
test('newer observations win per field; equal-time conflicts are omitted, missing fields never clear', () => {
  const old = direct('kin-a', { ai_backstory: 'older', ai_memory: 'retained', ai_directive: 'one' }, updated);
  const latest = cacheQuery(['v2','kins',uid,'summaries-by-ids','x'], [{ uid, ai_id: 'kin-a', ai_backstory: 'newer', ai_directive: 'two' }], updated + 1000);
  const tie = direct('kin-a', { ai_directive: 'different at same time', ai_example_message: '' }, updated + 1000);
  const { profiles, conflicts } = globalThis.KinexportProfiles.extractProfiles(uid, ['kin-a'], [latest, old, tie]);
  assert.equal(profiles[0].fields.ai_backstory.value, 'newer');
  assert.equal(profiles[0].fields.ai_memory.value, 'retained');
  assert.equal(profiles[0].fields.ai_example_message.value, '');
  assert.equal(Object.hasOwn(profiles[0].fields, 'ai_directive'), false);
  assert.equal(conflicts, 1);
});
test('mismatched singleton identity and unsupported value types cannot leak into profile', () => {
  const bad = cacheQuery(['v2','kins',uid,'kin-a'], { uid, ai_id: 'kin-b', ai_backstory: 'wrong record' });
  const valid = direct('kin-a', { ai_memory: { token: 'secret' }, ai_directive: undefined, proactive_mode: 'yes', selected_voice: Infinity });
  const result = globalThis.KinexportProfiles.extractProfiles(uid, ['kin-a','kin-b'], [bad, valid]);
  assert.deepEqual(result.profiles, []);
  assert.equal(result.incompleteFields, 3);
});
