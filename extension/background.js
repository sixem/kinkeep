import { DEFAULT_SETTINGS, normalizeEndpoint, permissionFor, selectMissing, isCaptureMessage, isKindroidImageUrl } from './common.js';
import { extractImages } from './mhtml.js';

const ext = globalThis.browser ?? globalThis.chrome;

const ALARM = 'kinexport-health';
const FAILURE_DEBOUNCE_MS = 15_000;
const MAX_BATCH = 100;
let monitoring = null;
let legacyInventoryEndpoint = null;

async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...(await ext.storage.local.get('settings')).settings };
}
async function stillCurrent(settings) {
  const current = await getSettings();
  return current.enabled && current.endpoint === settings.endpoint && current.token === settings.token;
}
async function mediaStillCurrent(settings) {
  const current = await getSettings();
  return current.enabled && current.imageArchiving === true && current.endpoint === settings.endpoint && current.token === settings.token;
}
async function sameConfiguration(settings) {
  const current = await getSettings();
  return current.enabled === settings.enabled && current.endpoint === settings.endpoint && current.token === settings.token;
}
async function getStatus() {
  return (await ext.storage.local.get('status')).status ?? { state: 'paused', failureSince: null, notified: false };
}
async function setStatus(status) {
  await ext.storage.local.set({ status });
  await updateBadge(status);
}
async function updateBadge(status) {
  const capture = (await ext.storage.local.get('captureStatus')).captureStatus;
  const badge = status.state === 'online' ? (['identity-uncertain', 'ambiguous-messages'].includes(capture?.state) ? '?' : '') : status.state === 'paused' ? 'OFF' : status.state === 'checking' ? '…' : '!';
  await ext.action.setBadgeText({ text: badge });
  await ext.action.setBadgeBackgroundColor({ color: status.state === 'paused' ? '#64748b' : '#c2410c' });
  await ext.action.setTitle({ title: `KinKeep: ${status.state}` });
}
async function paused() {
  await ext.alarms.clear(ALARM);
  await setStatus({ state: 'paused', failureSince: null, notified: false });
}
async function fail(reason) {
  const previous = await getStatus();
  const now = Date.now();
  const failureSince = previous.failureSince ?? now;
  let notified = previous.notified ?? false;
  if (!notified && now - failureSince >= FAILURE_DEBOUNCE_MS) {
    try {
      await ext.notifications.create('kinexport-unavailable', {
        type: 'basic', iconUrl: 'icons/icon128.png', title: 'KinKeep archive unavailable',
        message: 'Messages seen while the archive is unavailable may not be saved. Open KinKeep to check your connection.',
      });
      notified = true;
    } catch (error) { console.error('[KinKeep] Notification failed:', error); }
  }
  await setStatus({ state: 'offline', reason, failureSince, notified });
  const delay = Math.min((previous.retryDelayMinutes ?? 0.25) * 2, 5);
  await ext.storage.local.set({ status: { ...(await getStatus()), retryDelayMinutes: delay } });
  await ext.alarms.create(ALARM, { delayInMinutes: delay });
}
async function online() {
  await setStatus({ state: 'online', failureSince: null, notified: false, checkedAt: Date.now() });
  await ext.alarms.create(ALARM, { delayInMinutes: 0.5 });
}
async function request(settings, path, payload) {
  if (typeof settings.token !== 'string' || !settings.token.trim()) throw new Error('Configure an archive access token.');
  const endpoint = normalizeEndpoint(settings.endpoint);
  const url = `${endpoint}${path}`;
  const signal = AbortSignal.timeout(8000);
  const options = {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${settings.token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal, cache: 'no-store', redirect: 'error', credentials: 'omit',
  };
  // Browser and JSON parser errors can contain URLs or fragments of the body.
  // Keep only safe categories in the status persisted by the worker.
  let response;
  try { response = await fetch(url, options); }
  catch (error) { throw new Error(signal.aborted || error?.name === 'TimeoutError' ? 'Connection timed out.' : 'Connection failed.'); }
  if (!response.ok) throw Object.assign(new Error(`Archive returned HTTP ${response.status}.`), { status: response.status });
  try { return await response.json(); }
  catch { throw signal.aborted ? new Error('Connection timed out.') : new SyntaxError('Unexpected server response.'); }
}
async function verifyStep(stage, action) {
  try { return await action(); }
  catch (error) {
    // Do not forward arbitrary fetch or JSON parsing errors: they may contain
    // server response data. Only report a safe category and the check's stage.
    const message = typeof error?.message === 'string' ? error.message : '';
    const httpStatus = /^Archive returned HTTP ([1-5]\d\d)\.$/.exec(message);
    const detail = httpStatus ? `Archive returned HTTP ${httpStatus[1]}.`
      : error?.name === 'TimeoutError' || /timed out|timeout/i.test(message) ? 'Connection timed out.'
      : error?.name === 'SyntaxError' || /^(Archive health check returned an unexpected response\.|The archive returned an (invalid probe response|unknown probe status)\.)$/.test(message) ? 'Unexpected server response.'
      : 'Connection failed.';
    throw new Error(`${stage}: ${detail}`);
  }
}
async function verifyServer(settings, checkHealth) {
  if (!settings.token) throw new Error('Configure an archive access token.');
  if (!(await ext.permissions.contains({ origins: [permissionFor(settings.endpoint)] }))) throw new Error('Archive endpoint permission has not been granted.');
  // A successful authenticated probe also proves reachability. Only a manual
  // connection test needs a separate health check for diagnostics.
  if (checkHealth) {
    if (!(await sameConfiguration(settings))) throw new Error('Archiving settings changed.');
    await verifyStep('Health check', async () => {
      const health = await request(settings, '/api/health');
      if (health?.status !== 'ok') throw new Error('Archive health check returned an unexpected response.');
    });
  }
  if (!(await sameConfiguration(settings))) throw new Error('Archiving settings changed.');
  await verifyStep('Authenticated probe', async () => {
    selectMissing([], await request(settings, '/api/probe', { messages: [] }));
  });
}
async function checkConnection(force = false) {
  const settings = await getSettings();
  if (!settings.enabled && !force) { await paused(); return { ok: false, reason: 'Archiving is paused.' }; }
  try {
    await verifyServer(settings, force);
    if (await stillCurrent(settings)) await online();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Connection failed.';
    if (await stillCurrent(settings)) await fail(reason);
    return { ok: false, reason };
  }
}
function monitor() {
  if (!monitoring) monitoring = checkConnection().finally(() => { monitoring = null; });
  return monitoring;
}
async function saveInventory(account, kins) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: 'Archiving is paused.' };
  if (!account || typeof account.accountId !== 'string' || !account.accountId || !Array.isArray(kins) ||
      !kins.every(kin => kin && typeof kin.kinId === 'string' && kin.kinId && kin.accountId === account.accountId)) {
    return { ok: false, reason: 'Invalid account or Kin inventory.' };
  }
  try {
    // Older archives only have individual upserts. Remember that capability
    // for the worker lifetime, so subsequent scans do not repeat the 404.
    let useLegacy = legacyInventoryEndpoint === settings.endpoint;
    if (!useLegacy) {
      for (let offset = 0; offset < Math.max(1, kins.length); offset += MAX_BATCH) {
        if (!(await stillCurrent(settings))) throw new Error('Archiving settings changed.');
        const batch = kins.slice(offset, offset + MAX_BATCH);
        let result;
        try { result = await request(settings, '/api/inventory', { account, kins: batch }); }
        catch (error) {
          if (offset || error.status !== 404) throw error;
          useLegacy = true;
          legacyInventoryEndpoint = settings.endpoint;
          break;
        }
        if (result?.accountId !== account.accountId || result.kinCount !== batch.length) throw new Error('The archive did not confirm the inventory.');
      }
    }
    if (useLegacy) {
      if (!(await stillCurrent(settings))) throw new Error('Archiving settings changed.');
      const result = await request(settings, '/api/accounts', account);
      if (result?.account?.accountId !== account.accountId) throw new Error('The archive did not confirm the account.');
      for (const kin of kins) {
        if (!(await stillCurrent(settings))) throw new Error('Archiving settings changed.');
        const result = await request(settings, '/api/kins', kin);
        if (result?.kin?.accountId !== account.accountId || result.kin.kinId !== kin.kinId) throw new Error('The archive did not confirm the Kin.');
      }
    }
    if (await stillCurrent(settings)) await online();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Archive request failed.';
    if (await stillCurrent(settings)) await fail(reason);
    return { ok: false, reason };
  }
}
function confirmsCount(result, fields, expected) {
  let total = 0;
  for (const field of fields) {
    const count = result?.[field];
    if (!Number.isSafeInteger(count) || count < 0) return false;
    total += count;
  }
  return total === expected;
}
async function saveProfile(profile) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: 'Archiving is paused.' };
  if (!profile || typeof profile.accountId !== 'string' || !profile.accountId || typeof profile.kinId !== 'string' || !profile.kinId || !profile.fields || typeof profile.fields !== 'object' || Array.isArray(profile.fields)) return { ok: false, reason: 'Invalid profile.' };
  try {
    if (!(await stillCurrent(settings))) return { ok: false, reason: 'Archiving settings changed.' };
    const result = await request(settings, '/api/kins/profile', profile);
    if (!confirmsCount(result, ['inserted', 'updated', 'unchanged'], Object.keys(profile.fields).length)) throw new Error('The archive did not confirm every profile field.');
    if (await stillCurrent(settings)) await online();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Archive request failed.';
    if (await stillCurrent(settings)) await fail(reason);
    return { ok: false, reason };
  }
}
async function saveJournal(accountId, kinId, entries) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: 'Archiving is paused.' };
  const validId = value => typeof value === 'string' && !!value.trim() && value.length <= 2048;
  const validEntry = entry => {
    if (!entry || !validId(entry.entryId) || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) ||
        new Date(entry.createdAt).toISOString() !== entry.createdAt || typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 1_000_000) return false;
    if (entry.origin !== undefined && !validId(entry.origin)) return false;
    return entry.keywords === undefined || (Array.isArray(entry.keywords) && entry.keywords.length <= 1000 && entry.keywords.every(validId));
  };
  if (!validId(accountId) || !validId(kinId) || !Array.isArray(entries) || entries.length > MAX_BATCH || !entries.every(validEntry)) return { ok: false, reason: 'Invalid journal batch.' };
  if (!entries.length) return { ok: true, inserted: 0, unchanged: 0, historical: 0 };
  // Only explicitly verified journal fields are sent to the local archive.
  const selected = entries.map(({ entryId, createdAt, description, keywords, origin }) => ({ entryId, createdAt, description,
    ...(keywords === undefined ? {} : { keywords }), ...(origin === undefined ? {} : { origin }) }));
  try {
    if (!(await stillCurrent(settings))) return { ok: false, reason: 'Archiving settings changed.' };
    const result = await request(settings, '/api/kins/journal', { accountId, kinId, entries: selected });
    if (!confirmsCount(result, ['inserted', 'unchanged', 'historical'], entries.length)) throw new Error('The archive did not confirm every journal entry.');
    if (await stillCurrent(settings)) await online();
    return { ok: true, ...result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Archive request failed.';
    if (await stillCurrent(settings)) await fail(reason);
    return { ok: false, reason };
  }
}
// Only explicitly matched image parts leave the snapshot in memory. Browser
// snapshot behavior may include stylesheet requests in some configurations.
async function captureMedia(tabId, urls) {
  const settings = await getSettings();
  if (!settings.enabled || settings.imageArchiving !== true || !Number.isInteger(tabId) || !Array.isArray(urls) || !urls.length || urls.length > 100 || !urls.every(isKindroidImageUrl)) return { ok: false };
  if (typeof ext.pageCapture?.saveAsMHTML !== 'function') return { ok: false, reason: 'unsupported' };
  try {
    if (!(await mediaStillCurrent(settings))) return { ok: false };
    const snapshot = await ext.pageCapture.saveAsMHTML({ tabId });
    if (!snapshot || snapshot.size > 40 * 1024 * 1024 || !(await mediaStillCurrent(settings))) return { ok: false };
    const images = extractImages(await snapshot.text(), urls);
    if (!(await mediaStillCurrent(settings))) return { ok: false };
    return { ok: true, images: [...images].map(([url, value]) => ({ url, ...value })) };
  } catch { return { ok: false }; }
}
async function saveMedia(accountId, kinId, items) {
  const settings = await getSettings();
  if (!settings.enabled || settings.imageArchiving !== true || typeof accountId !== 'string' || !accountId || typeof kinId !== 'string' || !kinId || !Array.isArray(items) || items.length > 8) return { ok: false };
  try {
    if (!(await mediaStillCurrent(settings))) return { ok: false };
    const result = await request(settings, '/api/kins/media', { accountId, kinId, items });
    if (!confirmsCount(result, ['inserted', 'unchanged'], items.length)) throw new Error('The archive did not confirm the media batch.');
    if (await mediaStillCurrent(settings)) await online();
    return { ok: true };
  } catch (error) {
    if (await mediaStillCurrent(settings)) await fail(error instanceof Error ? error.message : 'Archive request failed.');
    return { ok: false };
  }
}
async function saveBatch(accountId, kinId, messages) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, reason: 'Archiving is paused.' };
  if (typeof accountId !== 'string' || !accountId || typeof kinId !== 'string' || !kinId || !Array.isArray(messages) || messages.length > MAX_BATCH || !messages.every(isCaptureMessage)) return { ok: false, reason: 'Invalid message batch.' };
  if (!messages.length) return { ok: true, inserted: 0, updated: 0, unchanged: 0 };
  try {
    if (!(await stillCurrent(settings))) return { ok: false, reason: 'Archiving settings changed.' };
    const probe = messages.map(({ conversationId, messageId, fingerprint, data }) => ({ conversationId, ...(messageId === undefined ? {} : { messageId }), fingerprint, ...(data?.captureSource ? { captureSource: data.captureSource } : {}) }));
    const missing = selectMissing(messages, await request(settings, '/api/probe', { accountId, kinId, messages: probe }));
    if (!(await stillCurrent(settings))) return { ok: false, reason: 'Archiving settings changed.' };
    const result = missing.length ? await request(settings, '/api/messages', { accountId, kinId, messages: missing }) : { inserted: 0, updated: 0, unchanged: 0 };
    if (!confirmsCount(result, ['inserted', 'updated', 'unchanged'], missing.length)) throw new Error('The archive did not confirm every message.');
    if (await stillCurrent(settings)) await online();
    return { ok: true, ...result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Archive request failed.';
    if (await stillCurrent(settings)) await fail(reason);
    return { ok: false, reason };
  }
}
function isPopup(sender) { return sender.id === ext.runtime.id && sender.url === ext.runtime.getURL('popup.html'); }
function isKindroid(sender) {
  if (sender.id !== ext.runtime.id || !sender.tab || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  // Firefox may omit tab.url without the tabs permission; sender.url still
  // identifies the originating content script. Validate every URL available.
  const urls = [sender.url, sender.tab.url].filter(url => typeof url === 'string' && url.length);
  if (!urls.length) return false;
  try { return urls.every(value => { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'kindroid.ai'; }); } catch { return false; }
}
async function saveCaptureStatus(state) {
  await ext.storage.local.set({ captureStatus: { state } });
  await updateBadge(await getStatus());
  return { ok: true };
}

function dispatchMessage(message, sender) {
  const type = message?.type;
  if (type === 'capabilities' && (isPopup(sender) || isKindroid(sender))) {
    return { imageCapture: typeof ext.pageCapture?.saveAsMHTML === 'function' };
  }
  if (isPopup(sender)) {
    if (type === 'checkConnection') return checkConnection(true);
    if (type === 'settingsChanged') return checkConnection();
    return;
  }
  if (!isKindroid(sender)) return;
  switch (type) {
    case 'captureStatus':
      if (['ready', 'waiting', 'identity-uncertain', 'ambiguous-messages', 'paused'].includes(message.state)) {
        return saveCaptureStatus(message.state);
      }
      return;
    case 'inventory': return saveInventory(message.account, message.kins);
    case 'profile': return saveProfile(message.profile);
    case 'journal': return saveJournal(message.accountId, message.kinId, message.entries);
    case 'mediaSnapshot': return captureMedia(sender.tab.id, message.urls);
    case 'mediaSave': return saveMedia(message.accountId, message.kinId, message.items);
    case 'captureBatch': return saveBatch(message.accountId, message.kinId, message.messages);
  }
}

ext.runtime.onMessage.addListener((message, sender, respond) => {
  const result = dispatchMessage(message, sender);
  if (result === undefined) return false;
  Promise.resolve(result).then(respond, () => respond({ ok: false, reason: 'Extension request failed.' }));
  return true;
});
ext.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void monitor(); });
ext.runtime.onStartup.addListener(() => { void monitor(); });
ext.runtime.onInstalled.addListener(() => { void monitor(); });
