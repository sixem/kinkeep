import { DEFAULT_SETTINGS, normalizeEndpoint, permissionFor } from './common.js';

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
let settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
let lastCaptureStatus = {};
enabled.checked = settings.enabled;
endpoint.value = settings.endpoint;
token.value = settings.token;
function setLink() {
  try { open.href = normalizeEndpoint(settings.endpoint) + '/'; } catch { open.removeAttribute('href'); }
}
function connectionHelp(reason = '') {
  if (/HTTP (401|403)/i.test(reason)) return 'Access token rejected. Check your token.';
  if (/token/i.test(reason)) return 'Enter an access token.';
  if (/permission/i.test(reason)) return 'Allow access to the server URL.';
  return 'Check the archive server and URL.';
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
render((await chrome.storage.local.get('status')).status);
renderCapture((await chrome.storage.local.get('captureStatus')).captureStatus);
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.status) render(changes.status.newValue); if (area === 'local' && changes.captureStatus) renderCapture(changes.captureStatus.newValue); });
async function send(type) {
  try { return await chrome.runtime.sendMessage({ type }); }
  catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Extension unavailable.' }; }
}
async function persist() { await chrome.storage.local.set({ settings }); await send('settingsChanged'); }
enabled.addEventListener('change', async () => {
  settings.enabled = enabled.checked;
  renderCapture(lastCaptureStatus);
  await persist();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  feedback.textContent = '';
  try {
    const normalized = normalizeEndpoint(endpoint.value);
    // Permission must be requested directly from this user gesture.
    if (!(await chrome.permissions.request({ origins: [permissionFor(normalized)] }))) throw new Error('Permission was not granted.');
    settings = { ...settings, endpoint: normalized, token: token.value.trim() };
    await persist();
    endpoint.value = normalized;
    setLink();
    feedback.textContent = 'Settings saved.';
  } catch (error) { feedback.textContent = error instanceof Error ? error.message : 'Could not save settings.'; }
});
test.addEventListener('click', async () => {
  feedback.textContent = 'Checking saved settings…';
  const result = await send('checkConnection');
  feedback.textContent = result?.ok ? 'Connected.' : connectionHelp(result?.reason);
});
