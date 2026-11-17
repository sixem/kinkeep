import { DEFAULT_SETTINGS, normalizeEndpoint, permissionFor } from './common.js';

const ext = globalThis.browser ?? globalThis.chrome;

const form = document.querySelector('#settings-form');
const enabled = document.querySelector('#enabled');
const endpoint = document.querySelector('#endpoint');
const token = document.querySelector('#token');
const test = document.querySelector('#test');
const open = document.querySelector('#open');
const feedback = document.querySelector('#feedback');
const statusText = document.querySelector('#status');
const indicator = document.querySelector('#indicator');
const captureStatus = document.querySelector('#capture-status');
const mediaStatus = document.querySelector('#media-status');
let settings = { ...DEFAULT_SETTINGS, ...(await ext.storage.local.get('settings')).settings };
// A browser permission prompt can close the popup before its promise resolves.
// Keep the submitted values in memory across popup instances, not on disk.
const draftKey = 'pendingArchiveSettings';
let draft;
try { draft = (await ext.storage.session.get(draftKey))[draftKey]; } catch { /* Continue with the last saved settings. */ }
let recovered = false;
let recoveryFailed = false;
if (draft) {
  try {
    const normalized = normalizeEndpoint(draft.endpoint);
    if (typeof draft.token !== 'string') throw new Error('Invalid draft');
    draft = { endpoint: normalized, token: draft.token };
    if (await ext.permissions.contains({ origins: [permissionFor(normalized)] })) {
      const recoveredSettings = { ...settings, ...draft };
      await ext.storage.local.set({ settings: recoveredSettings });
      settings = recoveredSettings;
      await ext.storage.session.remove(draftKey);
      draft = null;
      recovered = true;
    }
  } catch {
    // Keep a valid draft available for another save attempt if storage fails.
    recoveryFailed = true;
  }
}
let lastCaptureStatus = {};
enabled.checked = settings.enabled;
endpoint.value = draft?.endpoint ?? settings.endpoint;
token.value = draft?.token ?? settings.token;
if (draft) feedback.textContent = recoveryFailed ? 'Could not finish saving settings. Try again.' : 'Allow access and save settings to finish.';
else if (recovered) feedback.textContent = 'Settings saved.';
function setLink() {
  try { open.href = normalizeEndpoint(settings.endpoint) + '/'; } catch { open.removeAttribute('href'); }
}
function connectionHelp(reason = '') {
  const stage = /^(Health check|Authenticated probe):/.exec(reason)?.[1];
  const message = text => stage ? `${stage}: ${text}` : text;
  if (/HTTP (401|403)/i.test(reason)) return message('Access token rejected. Check your token.');
  if (/configure an archive access token/i.test(reason)) return message('Enter an access token and save settings.');
  if (/permission/i.test(reason)) return message('Allow access to the server URL.');
  if (/settings changed/i.test(reason)) return message('Settings changed during the test. Try again.');
  if (/extension unavailable|extension did not respond/i.test(reason)) return message('Extension did not respond. Reload it and try again.');
  if (/timeout|timed out/i.test(reason)) return message('Connection timed out. Check the server and URL.');
  if (/unexpected (server )?response|invalid probe response|unknown probe status|json/i.test(reason)) return message('Unexpected server response. Check the archive URL and server version.');
  const httpStatus = /HTTP ([1-5]\d\d)\b/i.exec(reason);
  if (httpStatus) return message(`Server returned HTTP ${httpStatus[1]}. Check the archive URL and server.`);
  return message('Could not reach the archive. Check the server and URL.');
}
function render(status = {}) {
  const state = status.state ?? 'paused';
  indicator.textContent = ({ online: 'Connected', offline: 'Unavailable', checking: 'Checking', paused: 'Paused' })[state] ?? 'Unknown';
  indicator.className = `badge ${state}`;
  statusText.textContent = state === 'offline' ? connectionHelp(status.reason) : '';
}
function renderCapture(status = {}) {
  lastCaptureStatus = status ?? {};
  captureStatus.textContent = enabled.checked ? ({ waiting: 'Waiting for Kindroid.', 'identity-uncertain': 'Account not verified; capture paused.', 'ambiguous-messages': 'Some data could not be captured.' })[lastCaptureStatus.state] ?? '' : '';
}
setLink();
render((await ext.storage.local.get('status')).status);
renderCapture((await ext.storage.local.get('captureStatus')).captureStatus);
ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.status) render(changes.status.newValue); if (area === 'local' && changes.captureStatus) renderCapture(changes.captureStatus.newValue); });
async function send(type) {
  try { return (await ext.runtime.sendMessage({ type })) ?? { ok: false, reason: 'Extension did not respond.' }; }
  catch { return { ok: false, reason: 'Extension unavailable.' }; }
}
const capabilities = await send('capabilities');
if (capabilities?.imageCapture === false) mediaStatus.textContent = 'Image archiving is unavailable in this browser.';
if (recovered) await send('settingsChanged');
async function persist(next = settings) { await ext.storage.local.set({ settings: next }); settings = next; await send('settingsChanged'); }
enabled.addEventListener('change', async () => {
  renderCapture(lastCaptureStatus);
  await persist({ ...settings, enabled: enabled.checked });
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  feedback.textContent = '';
  try {
    const normalized = normalizeEndpoint(endpoint.value);
    const submitted = { endpoint: normalized, token: token.value.trim() };
    // Begin the session write before requesting permission, but do not await it:
    // permissions.request must still run directly in this user gesture.
    const saveDraft = ext.storage.session.set({ [draftKey]: submitted });
    const requestPermission = ext.permissions.request({ origins: [permissionFor(normalized)] });
    const [, permission] = await Promise.allSettled([saveDraft, requestPermission]);
    if (permission.status === 'rejected') throw permission.reason;
    if (!permission.value) throw new Error('Permission was not granted. Allow access and save settings to finish.');
    await persist({ ...settings, ...submitted });
    await ext.storage.session.remove(draftKey);
    endpoint.value = normalized;
    setLink();
    feedback.textContent = 'Settings saved.';
  } catch (error) { feedback.textContent = error instanceof Error ? error.message : 'Could not save settings.'; }
});
test.addEventListener('click', async () => {
  let currentEndpoint;
  try { currentEndpoint = normalizeEndpoint(endpoint.value); }
  catch { feedback.textContent = 'Enter a valid archive server URL and save settings.'; return; }
  if (currentEndpoint !== settings.endpoint || token.value.trim() !== settings.token) {
    feedback.textContent = 'Save settings before testing the connection.';
    return;
  }
  feedback.textContent = 'Checking saved settings…';
  const result = await send('checkConnection');
  feedback.textContent = result?.ok ? 'Connected.' : connectionHelp(result?.reason);
});
