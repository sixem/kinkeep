'use strict';
const $ = (selector) => document.querySelector(selector);
let token = sessionStorage.getItem('kinexport-token') || '';
let selection = { accountId: null, kinId: null, conversationId: null, legacy: false };
let accounts = [];
let kins = [];
let conversations = [];
let legacyConversations = [];
let viewVersion = 0;
let profileVersion = 0;
let messagePaging = null;
let journalPaging = null;
let journalVersion = 0;
let imagesState = null;
let imagesVersion = 0;
let imageViewerVersion = 0;
let imageViewerUrl = null;
let imageViewerFocus = null;
const imageViewerRequests = new WeakMap();
let currentSection = 'welcome';
const activeToasts = [];
const MESSAGE_PAGE_SIZE = 50;
const JOURNAL_PAGE_SIZE = 50;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  if (!response.ok) { let data; try { data = await response.json(); } catch {} throw new Error(data?.error || `Request failed (${response.status})`); }
  return response;
}
function displayDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}
function downloadTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const zone = offset === 0 ? 'Z' : `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}-${pad(Math.abs(offset) % 60)}`;
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}${zone}`;
}
function messageTime(message) {
  for (const value of [message.timestamp, message.firstSeen]) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}
function newestMessages(messages) {
  return messages.slice().sort((a, b) => {
    const left = messageTime(a), right = messageTime(b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right - left;
  });
}
function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}
function messageText(value) {
  const container = document.createElement('p');
  const text = typeof value === 'string' ? value : '';
  const isMarker = (index) => text[index] === '*' && text[index - 1] !== '*' &&
    text[index + 1] !== '*' && text[index - 1] !== '\\';
  let cursor = 0;
  for (let start = 0; start < text.length; start++) {
    if (!isMarker(start)) continue;
    let end = start + 1;
    while (end < text.length && !isMarker(end)) end++;
    if (end >= text.length) break;
    const narration = text.slice(start + 1, end);
    if (!narration.trim()) continue;
    if (start > cursor) container.append(document.createTextNode(text.slice(cursor, start)));
    container.append(textElement('em', narration, 'message-narration'));
    cursor = end + 1;
    start = end;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  return container;
}
function dismissToast(toast) {
  clearTimeout(toast.timer);
  toast.element.remove();
  const index = activeToasts.indexOf(toast);
  if (index !== -1) activeToasts.splice(index, 1);
}
function showToast(message, kind = 'info') {
  while (activeToasts.length >= 3) dismissToast(activeToasts[0]);
  const element = document.createElement('div');
  element.className = kind === 'error' ? 'toast toast--error' : 'toast';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'toast__close';
  close.setAttribute('aria-label', 'Dismiss notification'); close.textContent = '×';
  const toast = { element, timer: null };
  close.addEventListener('click', () => dismissToast(toast));
  element.append(textElement('p', message, 'toast__message'), close);
  $('#toasts').append(element);
  activeToasts.push(toast);
  toast.timer = setTimeout(() => dismissToast(toast), kind === 'error' ? 7000 : 4000);
}
const SELECT_KIN_MESSAGE = 'Select a Kin above to view this page.';
function placeholder(container, text) { container.replaceChildren(textElement('p', text, 'muted empty-state')); }
function selectionPlaceholder(container, fallback) {
  const noKin = !selection.kinId && !selection.legacy;
  placeholder(container, noKin ? SELECT_KIN_MESSAGE : fallback);
}
function showLoading(container) {
  container.setAttribute('aria-busy', 'true');
  const skeleton = document.createElement(container.tagName === 'UL' ? 'li' : 'div');
  skeleton.className = 'loading-skeleton'; skeleton.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) skeleton.append(document.createElement('span'));
  container.replaceChildren(skeleton);
}
function finishLoading(container) { container.setAttribute('aria-busy', 'false'); }
function emptyList(list, text) { list.append(textElement('li', text, 'muted empty')); }
function listButton(list, title, detail, selected, callback) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'list-item';
  button.setAttribute('aria-pressed', String(selected));
  button.append(textElement('span', title));
  if (detail) button.append(textElement('small', detail));
  button.addEventListener('click', callback);
  li.append(button); list.append(li);
}
function accountName(account) { return typeof account.displayName === 'string' && account.displayName.trim() ? account.displayName.trim() : 'Account'; }
function shortAccountId(id) { return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id; }
function kinName(kin, index) { return kin.name || `Unnamed Kin ${index + 1}`; }
function countText(count, singular, plural = `${singular}s`) { return `${count} ${count === 1 ? singular : plural}`; }
function pagingButton(label, left, double, disabled, callback) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'secondary message-paging__button';
  button.setAttribute('aria-label', label); button.disabled = disabled;
  for (let i = 0; i < (double ? 2 : 1); i++) {
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '-5.5 0 26 26');
    icon.setAttribute('class', `message-paging__icon${left ? ' message-paging__icon--left' : ''}`);
    icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('transform', 'translate(-474 -1196)');
    path.setAttribute('d', 'M488.404,1207.36 L477.637,1197.6 C476.806,1196.76 475.459,1196.76 474.629,1197.6 C473.798,1198.43 473.798,1199.77 474.629,1200.6 L483.885,1209 L474.629,1217.4 C473.798,1218.23 473.798,1219.57 474.629,1220.4 C475.459,1221.24 476.806,1221.24 477.637,1220.4 L488.404,1210.64 C488.854,1210.19 489.052,1209.59 489.015,1209 C489.052,1208.41 488.854,1207.81 488.404,1207.36');
    icon.append(path); button.append(icon);
  }
  button.addEventListener('click', () => disabled ? undefined : callback());
  return button;
}
function pagingGroup(...buttons) {
  const group = document.createElement('div'); group.className = 'message-paging__group'; group.append(...buttons); return group;
}
function conversationName(conversation, index) {
  if (conversation.id === 'observed-main') return 'Chat history';
  const date = conversation.firstSeen ? displayDate(conversation.firstSeen) : null;
  return date ? `First observed ${date}` : `Conversation ${index + 1}`;
}
function updateMessageScrollControls() {
  const container = $('#messages');
  const ready = currentSection === 'messages' && messagePaging && messagePaging.page !== null &&
    !container.classList.contains('messages--concealed') && container.getClientRects().length > 0;
  const remaining = container.scrollHeight - container.clientHeight - container.scrollTop;
  for (const [selector, available] of [
    ['#messages-scroll-top', ready && container.scrollTop > 1],
    ['#messages-scroll-bottom', ready && remaining > 1],
  ]) {
    const button = $(selector);
    if (!available && document.activeElement === button) container.focus({ preventScroll: true });
    button.disabled = !available;
    if (available) button.classList.add('is-visible');
    else button.classList.remove('is-visible');
  }
}
function scrollMessages(toBottom) {
  const container = $('#messages');
  container.scrollTo({ top: toBottom ? container.scrollHeight : 0, behavior: 'instant' });
}
$('#messages-scroll-top').addEventListener('click', () => scrollMessages(false));
$('#messages-scroll-bottom').addEventListener('click', () => scrollMessages(true));
$('#messages').addEventListener('scroll', updateMessageScrollControls, { passive: true });
$('#messages').addEventListener('toggle', updateMessageScrollControls, true);
if (typeof ResizeObserver === 'function') new ResizeObserver(updateMessageScrollControls).observe($('#messages'));
function selectSection(section) {
  if (!['welcome', 'messages', 'personality', 'journal', 'images', 'settings'].includes(section)) return;
  if (currentSection === 'images' && section !== 'images') clearImages();
  currentSection = section;
  $('#welcome-panel').hidden = section !== 'welcome';
  for (const name of ['messages', 'personality', 'journal', 'images', 'settings']) {
    const nav = $(`#nav-${name}`);
    if (name === section) nav.setAttribute('aria-current', 'page');
    else nav.removeAttribute('aria-current');
    $(`#${name === 'messages' ? 'message' : name}-panel`).hidden = name !== section;
  }
  if (section === 'messages') revealMessagesAtBottom();
  updateMessageScrollControls();
  if (section === 'journal' && selection.accountId && selection.kinId && !selection.legacy) return ensureJournal().catch(showError);
  if (section === 'images' && selection.accountId && selection.kinId && !selection.legacy) return ensureImages().catch(showError);
}
const dropdowns = [
  { wrapper: '#account-dropdown', trigger: '#account-trigger', options: '#account-options' },
  { wrapper: '#kin-dropdown', trigger: '#kin-trigger', options: '#kin-options' },
  { wrapper: '#conversation-panel', trigger: '#conversation-trigger', options: '#conversation-options' },
  { wrapper: '#backup-dropdown', trigger: '#backup-trigger', options: '#backup-options' },
];
function positionBackupMenu() {
  const trigger = $('#backup-trigger'), options = $('#backup-options');
  if (options.hidden || typeof trigger.getBoundingClientRect !== 'function' || !globalThis.innerWidth || !globalThis.innerHeight) return;
  const rect = trigger.getBoundingClientRect(), margin = 8, gap = 5;
  const toolbar = $('.archive-toolbar').getBoundingClientRect();
  if (rect.bottom <= toolbar.top || rect.top >= toolbar.bottom || rect.right <= toolbar.left || rect.left >= toolbar.right) { closeDropdown(dropdowns[3]); return; }
  const width = options.offsetWidth, height = options.offsetHeight;
  const left = Math.max(margin, Math.min(globalThis.innerWidth - width - margin, rect.right - width));
  const below = rect.bottom + gap, above = rect.top - height - gap;
  const top = below + height <= globalThis.innerHeight - margin ? below : above >= margin ? above : Math.max(margin, globalThis.innerHeight - height - margin);
  options.style.left = `${left}px`; options.style.top = `${top}px`;
}
function closeDropdown(dropdown, restoreFocus = false) {
  $(dropdown.options).hidden = true;
  $(dropdown.trigger).setAttribute('aria-expanded', 'false');
  if (restoreFocus) $(dropdown.trigger).focus();
}
function closeDropdowns(except = null) {
  for (const dropdown of dropdowns) if (dropdown !== except) closeDropdown(dropdown);
}
for (const dropdown of dropdowns) {
  const trigger = $(dropdown.trigger), options = $(dropdown.options);
  trigger.addEventListener('click', () => {
    if (trigger.disabled) return;
    const opening = options.hidden;
    closeDropdowns(dropdown);
    options.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening && dropdown.wrapper === '#backup-dropdown') positionBackupMenu();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); closeDropdowns(dropdown);
    options.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    if (dropdown.wrapper === '#backup-dropdown') positionBackupMenu();
    const buttons = options.querySelectorAll('button:not(:disabled)');
    (event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1])?.focus();
  });
  options.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeDropdown(dropdown, true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...options.querySelectorAll('button:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index <= 0 ? buttons.length - 1 : index - 1);
    buttons[next].focus();
  });
}
globalThis.addEventListener?.('resize', positionBackupMenu);
document.addEventListener('scroll', positionBackupMenu, true);
document.addEventListener('click', (event) => {
  for (const dropdown of dropdowns) if (!$(dropdown.wrapper).contains(event.target)) closeDropdown(dropdown);
});
document.addEventListener('focusin', (event) => {
  for (const dropdown of dropdowns) if (!$(dropdown.wrapper).contains(event.target)) closeDropdown(dropdown);
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const dropdown of dropdowns) if (!$(dropdown.options).hidden) closeDropdown(dropdown, true);
});
for (const section of ['messages', 'personality', 'journal', 'images', 'settings']) {
  $(`#nav-${section}`).addEventListener('click', () => selectSection(section));
}
$('#home').addEventListener('click', () => {
  closeDropdowns();
  $('#search-results').replaceChildren();
  selectSection('welcome');
});
selectSection('welcome');
function clearMessages() {
  messagePaging = null;
  $('#messages').classList.remove('messages--concealed');
  $('#message-paging').hidden = true;
  $('#message-paging').replaceChildren();
  $('#messages-title').textContent = 'Messages';
  $('#selected-message-count').textContent = '';
  selectionPlaceholder($('#messages'), 'Choose a conversation to view its messages.');
  finishLoading($('#messages'));
  updateMessageScrollControls();
}
function clearProfile(message = 'Choose a Kin to view its archived profile and settings.') {
  ++profileVersion;
  $('#profile-title').textContent = 'Personality';
  $('#settings-title').textContent = 'Settings';
  for (const id of ['profile', 'settings-profile']) { selectionPlaceholder($(`#${id}`), message); finishLoading($(`#${id}`)); }
}
function clearConversations(message = 'Choose a Kin to see conversations.') {
  clearJournal();
  clearImages();
  conversations = []; $('#conversation-panel').hidden = true; closeDropdown(dropdowns[2]);
  $('#conversations-help').textContent = message; $('#conversations').replaceChildren(); clearMessages();
}
function lock() {
  ++viewVersion; token = ''; sessionStorage.removeItem('kinexport-token');
  selection = { accountId: null, kinId: null, conversationId: null, legacy: false };
  accounts = []; kins = []; conversations = []; legacyConversations = [];
  $('#token').value = ''; $('#login').hidden = false; $('#archive').hidden = true; $('#lock').hidden = true;
  closeDropdowns(); selectSection('welcome');
  for (const id of ['accounts', 'kins', 'conversations', 'search-results']) $(`#${id}`).replaceChildren();
  $('#search').value = ''; clearConversations(); clearProfile();
}
function renderAccounts() {
  const list = $('#accounts'); list.replaceChildren();
  const index = accounts.findIndex(account => account.accountId === selection.accountId);
  const selected = index >= 0 && !selection.legacy ? accounts[index] : null;
  if (selected) $('#account-label').replaceChildren(textElement('span', `${accountName(selected)} `, 'account-label__name'), textElement('span', `(${shortAccountId(selected.accountId)})`, 'account-label__id'));
  else $('#account-label').textContent = selection.legacy ? 'Unassigned archive' : 'Choose account';
  $('#account-trigger').setAttribute('aria-label', selected ? `Account: ${accountName(selected)} (${selected.accountId})` : `Account: ${$('#account-label').textContent}`);
  if (!accounts.length && !legacyConversations.length) emptyList(list, 'No account records or conversations archived yet.');
  accounts.forEach((account) => listButton(list, accountName(account), account.accountId,
    !selection.legacy && account.accountId === selection.accountId,
    () => { closeDropdown(dropdowns[0], true); return selectAccount(account.accountId).catch(showError); }));
  if (legacyConversations.length) listButton(list, 'Unassigned archive', 'Older conversations without an account and Kin', selection.legacy,
    () => { closeDropdown(dropdowns[0], true); return selectLegacy().catch(showError); });
}
function renderKins() {
  const list = $('#kins'); list.replaceChildren();
  finishLoading(list);
  const index = kins.findIndex(kin => kin.kinId === selection.kinId);
  $('#kin-label').textContent = selection.legacy ? 'Unassigned' : index >= 0 ? kinName(kins[index], index) : 'Choose Kin';
  $('#kin-trigger').setAttribute('aria-label', `Kin: ${$('#kin-label').textContent}`);
  $('#kin-trigger').disabled = !selection.accountId || selection.legacy;
  if ($('#kin-trigger').disabled) closeDropdown(dropdowns[1]);
  if (selection.legacy) {
    $('#kins-help').textContent = 'These older conversations are not assigned to an account or Kin.';
    return;
  }
  if (!selection.accountId) { $('#kins-help').textContent = 'Choose an account to see its Kins.'; return; }
  $('#kins-help').textContent = kins.length ? '' : 'No Kins archived for this account yet.';
  kins.forEach((kin, index) => listButton(list, kinName(kin, index), null, kin.kinId === selection.kinId,
    () => {
      closeDropdown(dropdowns[1], true);
      const showMessages = currentSection === 'welcome';
      const selected = selectKin(kin.kinId);
      if (showMessages) selectSection('messages');
      return selected.catch(showError);
    }));
}
function renderConversations() {
  const list = $('#conversations'); list.replaceChildren();
  finishLoading(list);
  $('#conversation-panel').hidden = conversations.length <= 1;
  if (conversations.length <= 1) closeDropdown(dropdowns[2]);
  const selectedIndex = conversations.findIndex(conversation => conversation.id === selection.conversationId);
  const selected = conversations[selectedIndex];
  $('#conversation-label').textContent = selected ? (selection.legacy && selected.kinName ? `${selected.kinName}: ${conversationName(selected, selectedIndex)}` : conversationName(selected, selectedIndex)) : 'Choose conversation';
  $('#conversation-trigger').setAttribute('aria-label', `Conversation: ${$('#conversation-label').textContent}`);
  if (!selection.legacy && !selection.kinId) { $('#conversations-help').textContent = 'Choose a Kin to see conversations.'; return; }
  $('#conversations-help').textContent = conversations.length ? '' : 'No conversations archived here yet.';
  conversations.forEach((conversation, index) => listButton(list,
    selection.legacy && conversation.kinName ? `${conversation.kinName}: ${conversationName(conversation, index)}` : conversationName(conversation, index),
    countText(conversation.messageCount, 'message'), conversation.id === selection.conversationId,
    () => { closeDropdown(dropdowns[2], true); return selectConversation(conversation).catch(showError); }));
}
async function selectAccount(accountId, restore = {}) {
  const version = ++viewVersion;
  selection = { accountId, kinId: null, conversationId: null, legacy: false }; kins = [];
  renderAccounts(); renderKins(); clearConversations(); clearProfile();
  if (restore.kinId) for (const id of ['messages', 'profile', 'settings-profile', 'journal-entries', 'images-entries']) showLoading($(`#${id}`));
  $('#kins-help').textContent = '';
  showLoading($('#kins'));
  try {
    const result = await api(`/api/kins?accountId=${encodeURIComponent(accountId)}`).then((r) => r.json());
    if (version !== viewVersion) return;
    kins = result.kins; renderKins();
    const kin = kins.find((item) => item.kinId === restore.kinId) || (kins.length === 1 ? kins[0] : null);
    if (kin) await selectKin(kin.kinId, restore);
    else if (restore.kinId) { clearConversations(); clearProfile(); }
  } catch (error) {
    if (version === viewVersion) { $('#kins').replaceChildren(); $('#kins-help').textContent = 'Could not load Kins.'; finishLoading($('#kins')); if (restore.kinId) { clearConversations(); clearProfile(); } }
    throw error;
  }
}
async function selectLegacy(restore = {}) {
  ++viewVersion;
  selection = { accountId: null, kinId: null, conversationId: null, legacy: true };
  kins = []; conversations = legacyConversations; renderAccounts(); renderKins(); renderConversations(); clearMessages();
  clearProfile('Older unassigned conversations have no associated Kin profile.');
  clearJournal('Older unassigned conversations have no associated Kin journal.');
  clearImages('Older unassigned conversations have no associated Kin images.');
  const conversation = conversations.find(item => item.id === restore.conversationId) || (conversations.length === 1 ? conversations[0] : null);
  if (conversation) await selectConversation(conversation);
}
function isEncryptedProfileValue(value) {
  return typeof value === 'string' && /(?:^|:)U2FsdGVkX1[A-Za-z0-9+/=]+$/.test(value);
}
function profileValue(value) {
  if (isEncryptedProfileValue(value)) return 'Not recorded';
  if (typeof value === 'string') return value === '' ? '(empty string)' : value;
  // Values are JSON from the archive; JSON.stringify preserves null, false and zero.
  return JSON.stringify(value, null, 2) ?? '(unavailable)';
}
function fieldRows(value) {
  return Math.min(12, Math.max(3, value.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / 72)), 0)));
}
function profileObservation(observation, label, { compact = false } = {}) {
  const container = document.createElement('div'); container.className = 'profile-observation';
  const value = profileValue(observation.value);
  const singleLine = compact && value.length <= 72 && !/[\r\n\u2028\u2029]/.test(value);
  const field = textElement(singleLine ? 'input' : 'textarea', value, `profile-value readonly-field${singleLine ? ' readonly-field--single' : ''}`);
  field.value = value; field.readOnly = true; field.spellcheck = false; field.setAttribute('aria-label', label);
  if (singleLine) field.type = 'text'; else field.rows = fieldRows(value);
  container.append(field);
  if (observation.observedAt) container.append(textElement('small', `Observed ${displayDate(observation.observedAt)}`));
  else if (observation.recordedAt) container.append(textElement('small', `Archived ${displayDate(observation.recordedAt)}`));
  return container;
}
function renderProfile(profile) {
  const container = $('#profile'); container.replaceChildren();
  const settingsContainer = $('#settings-profile'); settingsContainer.replaceChildren();
  const fields = profile.fields || {};
  const familiar = {
    ai_backstory: 'Backstory', ai_memory: 'Key memories',
    ai_directive: 'Response directive', ai_example_message: 'Example message', current_scene: 'Scene',
  };
  const primaryNames = Object.keys(familiar);
  const plaintextNames = new Set(primaryNames.map((name) => `${name}_plaintext`));
  const otherNames = Object.keys(fields).filter((name) => !Object.hasOwn(familiar, name) && !plaintextNames.has(name));
  const names = [...primaryNames, ...otherNames];
  if (!Object.keys(fields).length) {
    placeholder(container, 'No Kin personality data has been observed or imported yet.');
    placeholder(settingsContainer, 'No Kin settings have been observed or imported yet.');
    finishLoading(container); finishLoading(settingsContainer); return;
  }
  if (!otherNames.length) placeholder(settingsContainer, 'No Kin settings have been observed or imported yet.');
  for (const name of names) {
    const plaintext = plaintextNames.has(`${name}_plaintext`) ? fields[`${name}_plaintext`] : null;
    const field = plaintext || fields[name];
    const section = document.createElement('section'); section.className = 'profile-field';
    const label = Object.hasOwn(familiar, name) ? familiar[name] : name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
    section.append(textElement('h3', label));
    const missing = Object.hasOwn(familiar, name) ? 'Not recorded. Open this Kin’s Personality page to capture it.' : 'Not recorded';
    if (!field) section.append(textElement('p', missing, 'muted'));
    else if (!plaintext && isEncryptedProfileValue(field.value)) {
      section.append(textElement('p', missing, 'muted'));
    } else {
      const compact = !Object.hasOwn(familiar, name);
      section.append(profileObservation(field, label, { compact }));
      if (field.history?.length) {
        const details = document.createElement('details');
        details.append(textElement('summary', countText(field.history.length, 'earlier observation')));
        let rendered = false;
        details.addEventListener('toggle', () => {
          if (!details.open || rendered) return;
          for (const observation of field.history) details.append(profileObservation(observation, `Earlier ${label}`, { compact }));
          rendered = true;
        });
        section.append(details);
      }
    }
    (Object.hasOwn(familiar, name) ? container : settingsContainer).append(section);
  }
  finishLoading(container);
  finishLoading(settingsContainer);
}
async function loadProfile(accountId, kinId) {
  const version = ++profileVersion;
  $('#profile-title').textContent = 'Personality';
  showLoading($('#profile'));
  showLoading($('#settings-profile'));
  const query = new URLSearchParams({ accountId, kinId });
  try {
    const profile = await api(`/api/kins/profile?${query}`).then((r) => r.json());
    if (version === profileVersion) renderProfile(profile);
  } catch (error) {
    if (version === profileVersion) for (const id of ['profile', 'settings-profile']) { placeholder($(`#${id}`), `Could not load profile: ${error.message}`); finishLoading($(`#${id}`)); }
  }
}
async function selectKin(kinId, restore = {}) {
  const version = ++viewVersion;
  selection.kinId = kinId; selection.conversationId = null;
  renderKins(); clearConversations(''); showLoading($('#conversations'));
  showLoading($('#messages'));
  if (currentSection === 'journal') void ensureJournal().catch(showError);
  if (currentSection === 'images') void ensureImages().catch(showError);
  const profileTask = loadProfile(selection.accountId, kinId);
  const query = new URLSearchParams({ accountId: selection.accountId, kinId });
  try {
    const result = await api(`/api/conversations?${query}`).then((r) => r.json());
    if (version !== viewVersion) return;
    conversations = result.conversations; renderConversations();
    const conversation = conversations.find((item) => item.id === restore.conversationId) || (conversations.length === 1 ? conversations[0] : null);
    if (conversation) await selectConversation(conversation);
    else clearMessages();
  } catch (error) {
    if (version === viewVersion) { $('#conversations').replaceChildren(); $('#conversations-help').textContent = 'Could not load conversations.'; finishLoading($('#conversations')); placeholder($('#messages'), 'Could not load conversations.'); finishLoading($('#messages')); }
    throw error;
  } finally { await profileTask; }
}
function closeImageViewer(restoreFocus = true) {
  ++imageViewerVersion;
  $('#image-viewer').hidden = true;
  $('#image-viewer-image').removeAttribute('src');
  $('#image-viewer-download').removeAttribute('href');
  $('#image-viewer-download').onclick = null;
  if (imageViewerUrl) URL.revokeObjectURL(imageViewerUrl);
  imageViewerUrl = null;
  if (restoreFocus && imageViewerFocus?.isConnected) imageViewerFocus.focus();
  imageViewerFocus = null;
}
function clearImages(message = 'No images archived for this Kin yet.') {
  closeImageViewer(false);
  ++imagesVersion;
  const previous = imagesState; imagesState = null;
  if (previous) {
    previous.observer?.disconnect(); previous.resizeObserver?.disconnect();
    if (previous.frameHandle != null && globalThis.cancelAnimationFrame) cancelAnimationFrame(previous.frameHandle);
    for (const tile of previous.mounted.values()) {
      tile.controller?.abort(); if (tile.url) URL.revokeObjectURL(tile.url);
    }
  }
  $('#images-count').textContent = '';
  selectionPlaceholder($('#images-entries'), message); finishLoading($('#images-entries'));
}
function imageLabel(item) { return item.kind === 'portrait' ? 'Portrait' : item.variant === 'preview' ? 'Selfie preview' : 'Selfie'; }
async function openImageViewer(state, item, source) {
  if (imagesState !== state) return;
  const version = ++imageViewerVersion;
  imageViewerRequests.set(source, version);
  source.setAttribute('aria-busy', 'true');
  if (imageViewerUrl) URL.revokeObjectURL(imageViewerUrl);
  imageViewerUrl = null; imageViewerFocus = source;
  $('#image-viewer-title').textContent = imageLabel(item);
  $('#image-viewer-date').textContent = item.createdAt ? displayDate(item.createdAt) : '';
  $('#image-viewer-prompt-section').hidden = !item.prompt;
  const prompt = item.prompt || '', promptField = $('#image-viewer-prompt');
  promptField.value = prompt; promptField.rows = fieldRows(prompt);
  $('#image-viewer-image').removeAttribute('src');
  $('#image-viewer-image').alt = imageLabel(item);
  let url = null;
  try {
    const response = await api(`/api/media/blob?sha256=${item.sha256}`);
    const blob = await response.blob();
    if (imagesState !== state || imageViewerVersion !== version) return;
    url = URL.createObjectURL(blob);
    const image = $('#image-viewer-image'); image.src = url;
    await image.decode();
    if (imagesState !== state || imageViewerVersion !== version) return;
    imageViewerUrl = url; url = null;
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'img';
    const download = $('#image-viewer-download');
    download.href = imageViewerUrl;
    const filename = () => `kinexport-${imageLabel(item).toLowerCase().replaceAll(' ', '-')}-${item.sha256.slice(0, 12)}-${downloadTimestamp()}.${extension}`;
    download.download = filename();
    download.onclick = () => { download.download = filename(); };
    $('#image-viewer-content').scrollTop = 0;
    $('#image-viewer').hidden = false; $('#image-viewer-close').focus();
  } catch {
    if (imagesState === state && imageViewerVersion === version) showToast('Could not load the image.', 'error');
  } finally {
    if (url) URL.revokeObjectURL(url);
    if (imageViewerRequests.get(source) === version) { imageViewerRequests.delete(source); source.removeAttribute('aria-busy'); }
  }
}
function scheduleImages(state) {
  if (imagesState !== state || state.frameHandle != null) return;
  if (globalThis.requestAnimationFrame) state.frameHandle = requestAnimationFrame(() => { state.frameHandle = null; renderImages(state); });
  else renderImages(state);
}
function loadImageThumbnail(state, index) {
  const entry = state.mounted.get(index);
  if (!entry || entry.loading || entry.url || entry.failed) return;
  entry.loading = true;
  entry.controller = typeof AbortController === 'function' ? new AbortController() : null;
  void (async () => {
    try {
      const options = entry.controller ? { signal: entry.controller.signal } : {};
      const response = await api(`/api/media/thumbnail?sha256=${entry.item.sha256}`, options);
      const blob = await response.blob();
      if (imagesState !== state || state.mounted.get(index) !== entry) return;
      entry.url = URL.createObjectURL(blob); entry.image.src = entry.url;
    } catch (error) {
      if (imagesState === state && state.mounted.get(index) === entry && error?.name !== 'AbortError') {
        entry.failed = true; entry.image.alt = `${imageLabel(entry.item)} unavailable`;
      }
    } finally { entry.loading = false; entry.controller = null; }
  })();
}
function renderImages(state) {
  if (imagesState !== state || !state.grid) return;
  const container = $('#images-entries');
  const style = globalThis.getComputedStyle?.(container);
  const padding = (parseFloat(style?.paddingLeft) || 0) + (parseFloat(style?.paddingRight) || 0);
  const width = Math.max(1, (container.clientWidth || 900) - padding);
  const height = container.clientHeight || 600;
  const gap = 8, minimum = 180;
  const columns = Math.max(1, Math.floor((width + gap) / (minimum + gap)));
  const step = (width - gap * (columns - 1)) / columns + 32 + gap;
  const rows = Math.ceil(state.items.length / columns);
  const firstRow = Math.min(Math.max(0, rows - 1), Math.max(0, Math.floor(container.scrollTop / step) - 2));
  const lastRow = Math.min(rows, Math.ceil((container.scrollTop + height) / step) + 2);
  const first = Math.min(state.items.length, firstRow * columns), last = Math.min(state.items.length, lastRow * columns);
  for (const [index, tile] of state.mounted) {
    if (index >= first && index < last) continue;
    state.observer?.unobserve(tile.button); tile.controller?.abort();
    if (tile.url) URL.revokeObjectURL(tile.url);
    tile.button.remove(); state.mounted.delete(index);
  }
  state.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  const children = [];
  for (let index = first; index < last; index++) {
    let tile = state.mounted.get(index);
    if (!tile) {
      const item = state.items[index], button = document.createElement('button'), image = document.createElement('img');
      button.type = 'button'; button.className = 'image-item'; button.setAttribute('aria-label', `Open ${imageLabel(item)}`);
      image.alt = imageLabel(item); image.loading = 'lazy';
      const date = item.createdAt ? displayDate(item.createdAt) : item.firstSeen ? `Observed ${displayDate(item.firstSeen)}` : 'Date unknown';
      button.append(image, textElement('span', date, `image-item__date${!item.createdAt && item.firstSeen ? ' image-item__date--observed' : ''}`));
      tile = { button, image, item, url: null, controller: null, loading: false, failed: false };
      button.addEventListener('click', () => { void openImageViewer(state, item, button); });
      state.mounted.set(index, tile); state.indices.set(button, index);
      if (state.observer) state.observer.observe(button); else loadImageThumbnail(state, index);
    }
    children.push(tile.button);
  }
  state.grid.replaceChildren(...children);
  state.top.style.height = `${firstRow * step}px`;
  state.bottom.style.height = `${Math.max(0, rows - lastRow) * step}px`;
  if (state.nextOffset !== null && !state.loading && (rows * step < container.scrollTop + height + step * 3)) void loadImages(state, state.nextOffset).catch(showError);
}
function ensureImages() {
  if (!selection.accountId || !selection.kinId || selection.legacy) return Promise.resolve();
  if (imagesState && imagesState.accountId === selection.accountId && imagesState.kinId === selection.kinId) return imagesState.loading ?? Promise.resolve();
  const state = { accountId: selection.accountId, kinId: selection.kinId, items: [], keys: new Set(), total: 0, nextOffset: 0, loading: null, mounted: new Map(), indices: new WeakMap(), observer: null, resizeObserver: null, frameHandle: null, grid: null };
  imagesState = state; ++imagesVersion;
  return loadImages(state, 0);
}
function loadImages(state, offset) {
  if (imagesState !== state || state.loading) return state.loading ?? Promise.resolve();
  const current = () => imagesState === state && selection.accountId === state.accountId && selection.kinId === state.kinId && currentSection === 'images';
  if (offset === 0) showLoading($('#images-entries'));
  const query = new URLSearchParams({ accountId: state.accountId, kinId: state.kinId, limit: '20', offset: String(offset) });
  const task = (async () => {
    try {
      const data = await api(`/api/kins/media?${query}`).then(r => r.json());
      if (!current()) return;
      if (data.accountId !== state.accountId || data.kinId !== state.kinId || !Array.isArray(data.items) || data.items.length > 20 || !Number.isSafeInteger(data.total) || data.total < 0 || !(data.nextOffset === null || (Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset && data.nextOffset < data.total))) throw new Error('Invalid images page.');
      for (const item of data.items) {
        if (!/^[0-9a-f]{64}$/.test(item.sha256)) continue;
        const key = JSON.stringify([item.kind, item.sourceId, item.variant, item.sha256]);
        if (!state.keys.has(key)) { state.keys.add(key); state.items.push(item); }
      }
      state.total = data.total; state.nextOffset = data.nextOffset;
      const container = $('#images-entries');
      if (!state.grid) {
        container.replaceChildren(); container.scrollTop = 0;
        if (!state.items.length && state.nextOffset === null) placeholder(container, 'No images archived for this Kin yet.');
        else {
          state.top = document.createElement('div'); state.bottom = document.createElement('div');
          state.grid = document.createElement('div'); state.grid.className = 'images-grid';
          container.append(state.top, state.grid, state.bottom);
          if (typeof IntersectionObserver === 'function') state.observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) { const index = state.indices.get(entry.target); if (index !== undefined) loadImageThumbnail(state, index); }
          }, { root: container, rootMargin: '300px' });
          if (typeof ResizeObserver === 'function') { state.resizeObserver = new ResizeObserver(() => scheduleImages(state)); state.resizeObserver.observe(container); }
        }
      }
      finishLoading(container); $('#images-count').textContent = countText(data.total, 'image');
    } catch (error) {
      if (!current()) return;
      if (offset === 0) { imagesState = null; placeholder($('#images-entries'), 'Could not load images.'); finishLoading($('#images-entries')); }
      throw error;
    } finally {
      if (imagesState === state) { state.loading = null; scheduleImages(state); }
    }
  })();
  state.loading = task; return task;
}
$('#images-entries').addEventListener('scroll', () => { if (imagesState) scheduleImages(imagesState); });
$('#image-viewer-close').addEventListener('click', () => closeImageViewer());
$('#image-viewer').addEventListener('click', event => { if (event.target === $('#image-viewer')) closeImageViewer(); });
$('#image-viewer').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeImageViewer(); }
  else if (event.key === 'Tab') {
    const controls = [$('#image-viewer-close'), $('#image-viewer-content'), ...($('#image-viewer-prompt-section').hidden ? [] : [$('#image-viewer-prompt')]), $('#image-viewer-download')];
    const index = controls.indexOf(document.activeElement);
    event.preventDefault(); controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length].focus();
  }
});
function clearJournal(message = 'Choose a Kin to view its journal.') {
  ++journalVersion; journalPaging = null;
  $('#journal-count').textContent = '';
  $('#journal-paging').hidden = true; $('#journal-paging').replaceChildren();
  selectionPlaceholder($('#journal-entries'), message); finishLoading($('#journal-entries'));
}
function ensureJournal() {
  if (!selection.accountId || !selection.kinId || selection.legacy) return Promise.resolve();
  if (journalPaging && journalPaging.accountId === selection.accountId && journalPaging.kinId === selection.kinId) return journalPaging.loading ?? Promise.resolve();
  const state = { accountId: selection.accountId, kinId: selection.kinId, offset: 0, nextOffset: null, total: 0, loading: null };
  journalPaging = state;
  return loadJournalPage(state, 0);
}
function journalIsCurrent(state, version) {
  return journalPaging === state && journalVersion === version && !selection.legacy && selection.accountId === state.accountId && selection.kinId === state.kinId;
}
function renderJournalEntry(entry) {
  const article = document.createElement('article'); article.className = 'journal-entry';
  article.append(textElement('time', displayDate(entry.createdAt), 'journal-entry__date'));
  article.append(textElement('p', typeof entry.description === 'string' ? entry.description : '', 'journal-entry__description'));
  if (Array.isArray(entry.keywords)) {
    const keywords = entry.keywords.filter(value => typeof value === 'string' && value.trim());
    if (keywords.length) article.append(textElement('p', keywords.join(', '), 'journal-entry__keywords'));
  }
  if (Array.isArray(entry.revisions) && entry.revisions.length) {
    const details = document.createElement('details');
    details.append(textElement('summary', countText(entry.revisions.length, 'other observation')));
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      for (const revision of entry.revisions) {
        const section = document.createElement('div'); section.className = 'revision';
        if (revision.recordedAt) section.append(textElement('small', `Recorded ${displayDate(revision.recordedAt)}`));
        section.append(textElement('p', typeof revision.description === 'string' ? revision.description : '', 'journal-entry__description'));
        if (Array.isArray(revision.keywords)) {
          const words = revision.keywords.filter(value => typeof value === 'string' && value.trim());
          if (words.length) section.append(textElement('p', words.join(', '), 'journal-entry__keywords'));
        }
        details.append(section);
      }
      rendered = true;
    });
    article.append(details);
  }
  return article;
}
function renderJournalPaging(state) {
  const container = $('#journal-paging'); container.replaceChildren();
  if (state.total <= JOURNAL_PAGE_SIZE && state.offset === 0 && state.nextOffset === null) { container.hidden = true; return; }
  const first = state.offset === 0 || !!state.loading;
  const last = state.nextOffset === null || !!state.loading;
  const oldestOffset = Math.max(0, Math.floor((state.total - 1) / JOURNAL_PAGE_SIZE) * JOURNAL_PAGE_SIZE);
  const go = offset => loadJournalPage(state, offset).catch(showError);
  container.append(
    pagingGroup(pagingButton('Newest journal entries', true, true, first, () => go(0)),
      pagingButton('Newer journal entries', true, false, first, () => go(Math.max(0, state.offset - JOURNAL_PAGE_SIZE)))),
    textElement('span', `Page ${Math.floor(state.offset / JOURNAL_PAGE_SIZE) + 1} of ${Math.max(1, Math.ceil(state.total / JOURNAL_PAGE_SIZE))}`, 'message-paging__label'),
    pagingGroup(pagingButton('Older journal entries', false, false, last, () => go(state.nextOffset)),
      pagingButton('Oldest journal entries', false, true, last, () => go(oldestOffset)))
  );
  container.hidden = false;
}
function loadJournalPage(state, offset) {
  if (journalPaging !== state) return Promise.resolve();
  const version = ++journalVersion;
  if (offset === 0 && state.total === 0) showLoading($('#journal-entries'));
  else $('#journal-entries').setAttribute('aria-busy', 'true');
  const query = new URLSearchParams({ accountId: state.accountId, kinId: state.kinId, limit: String(JOURNAL_PAGE_SIZE), offset: String(offset) });
  const task = (async () => {
    try {
      const data = await api(`/api/kins/journal?${query}`).then(response => response.json());
      if (!journalIsCurrent(state, version)) return;
      if (data.accountId !== state.accountId || data.kinId !== state.kinId || !Array.isArray(data.entries) || data.entries.length > JOURNAL_PAGE_SIZE || !Number.isSafeInteger(data.total) || data.total < 0 || !(data.nextOffset === null || (Number.isSafeInteger(data.nextOffset) && data.nextOffset > offset && data.nextOffset < data.total))) throw new Error('Invalid journal page.');
      const container = $('#journal-entries'); container.replaceChildren();
      if (!data.entries.length) placeholder(container, 'No journal entries archived for this Kin yet.');
      for (const entry of data.entries.slice().sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))) container.append(renderJournalEntry(entry));
      container.scrollTop = 0; finishLoading(container);
      $('#journal-count').textContent = countText(data.total, 'entry', 'entries');
      state.offset = offset; state.total = data.total; state.nextOffset = data.nextOffset;
    } catch (error) {
      if (!journalIsCurrent(state, version)) return;
      if (offset === 0) { placeholder($('#journal-entries'), 'Could not load journal entries.'); journalPaging = null; }
      finishLoading($('#journal-entries'));
      throw error;
    } finally {
      if (journalIsCurrent(state, version)) { state.loading = null; renderJournalPaging(state); }
    }
  })();
  state.loading = task;
  if (state.total) renderJournalPaging(state);
  return task;
}
function renderMessage(message, kinName = '') {
  const originalSender = typeof message.sender === 'string' ? message.sender.trim() : '';
  const isSelf = /^(?:user|self|me)$/i.test(originalSender);
  const isKin = /^kin$/i.test(originalSender) || (!!kinName && originalSender === kinName);
  const senderName = isSelf ? 'You' : isKin ? (kinName || 'Kin') : (originalSender || 'Unknown sender');
  const article = document.createElement('article');
  article.className = `message ${isSelf ? 'message--self' : isKin ? 'message--kin' : 'message--other'}`;
  const bubble = document.createElement('div'); bubble.className = 'message__bubble';
  const meta = document.createElement('div'); meta.className = 'message__meta';
  const sender = textElement('strong', senderName);
  const time = textElement('small', message.timestamp ? displayDate(message.timestamp) : `First observed ${displayDate(message.firstSeen)}`);
  const body = messageText(message.content);
  meta.append(sender, time); bubble.append(meta, body);
  if (message.revisions?.length) {
    const details = document.createElement('details');
    details.append(textElement('summary', countText(message.revisions.length, 'earlier version')));
    let rendered = false;
    details.addEventListener('toggle', () => {
      if (!details.open || rendered) return;
      for (const revision of message.revisions) {
        const section = document.createElement('div'); section.className = 'revision';
        section.append(textElement('small', `Recorded ${displayDate(revision.recordedAt)}`), messageText(revision.content));
        details.append(section);
      }
      rendered = true;
    });
    bubble.append(details);
  }
  article.append(bubble);
  return article;
}
async function selectConversation(conversation) {
  selection.conversationId = conversation.id; renderConversations();
  $('#messages-title').textContent = 'Messages';
  $('#selected-message-count').textContent = Number.isSafeInteger(conversation.messageCount) ? countText(conversation.messageCount, 'message') : '';
  showLoading($('#messages'));
  $('#message-paging').hidden = true;
  const state = { conversationId: conversation.id, accountId: selection.accountId, kinId: selection.kinId,
    legacy: selection.legacy, page: null, nextCursor: null, newerCursor: null };
  messagePaging = state;
  updateMessageScrollControls();
  await loadMessagePage(state, 'newest');
}
function renderMessagePaging(state) {
  const container = $('#message-paging'); container.replaceChildren();
  if (state.total === 0) { container.hidden = true; return; }
  const pages = Math.max(1, Math.ceil(state.total / MESSAGE_PAGE_SIZE));
  const go = direction => loadMessagePage(state, direction).catch(showError);
  container.append(
    pagingGroup(pagingButton('Oldest messages', true, true, !state.nextCursor, () => go('oldest')),
      pagingButton('Older messages', true, false, !state.nextCursor, () => go('older'))),
    textElement('span', `Page ${state.page} of ${pages}`, 'message-paging__label'),
    pagingGroup(pagingButton('Newer messages', false, false, !state.newerCursor, () => go('newer')),
      pagingButton('Newest messages', false, true, !state.newerCursor, () => go('newest')))
  );
  container.hidden = false;
}
function revealMessagesAtBottom() {
  const container = $('#messages');
  if (!container.classList.contains('messages--concealed')) return;
  // A hidden archive or inactive panel has no layout; keep the new page
  // concealed until it can be scrolled, then reveal it in the same frame.
  if (container.getClientRects().length === 0) return;
  // Messages are paginated, so their heights are known before the first paint.
  container.scrollTop = container.scrollHeight;
  container.classList.remove('messages--concealed');
}
async function loadMessagePage(state, direction) {
  if (messagePaging !== state) return;
  const version = ++viewVersion;
  const initialPage = state.page === null;
  if (!initialPage) $('#messages').setAttribute('aria-busy', 'true');
  const query = new URLSearchParams({ conversationId: state.conversationId, limit: String(MESSAGE_PAGE_SIZE) });
  if (!state.legacy) { query.set('accountId', state.accountId); query.set('kinId', state.kinId); }
  if (direction === 'oldest') query.set('direction', 'oldest');
  if (direction === 'older') query.set('cursor', state.nextCursor);
  if (direction === 'newer') { query.set('direction', 'newer'); query.set('cursor', state.newerCursor); }
  try {
    const data = await api(`/api/messages?${query}`).then((r) => r.json());
    if (version !== viewVersion || messagePaging !== state) return;
    if (!Array.isArray(data.messages) || !Number.isSafeInteger(data.total) || data.total < 0 || !(data.nextCursor === null || typeof data.nextCursor === 'string') || !(data.newerCursor === null || typeof data.newerCursor === 'string')) throw new Error('Invalid message page.');
    const container = $('#messages');
    container.classList.add('messages--concealed');
    container.replaceChildren();
    if (!data.messages.length) placeholder(container, 'No messages archived in this conversation yet.');
    const kinName = state.legacy
      ? (legacyConversations.find((item) => item.id === state.conversationId)?.kinName || '')
      : (kins.find((item) => item.kinId === state.kinId)?.name || '');
    // The API returns a stable newest-first cursor order (including ties).
    // Reverse it exactly, rather than re-sorting timestamps in the browser.
    for (const message of data.messages.slice().reverse()) container.append(renderMessage(message, kinName));
    finishLoading(container);
    $('#selected-message-count').textContent = countText(data.total, 'message');
    const pages = Math.max(1, Math.ceil(data.total / MESSAGE_PAGE_SIZE));
    state.page = direction === 'newest' ? pages : direction === 'oldest' ? 1 : Math.max(1, Math.min(pages, state.page + (direction === 'older' ? -1 : 1)));
    state.nextCursor = data.nextCursor; state.newerCursor = data.newerCursor; state.total = data.total;
    renderMessagePaging(state);
    if (initialPage) revealMessagesAtBottom();
    else { container.scrollTop = 0; container.classList.remove('messages--concealed'); }
    updateMessageScrollControls();
  } catch (error) {
    if (version !== viewVersion || messagePaging !== state) return;
    if (state.page === null) placeholder($('#messages'), 'Could not load messages.');
    $('#messages').classList.remove('messages--concealed');
    finishLoading($('#messages'));
    updateMessageScrollControls();
    throw error;
  }
}
async function refresh() {
  const previous = { ...selection };
  const version = ++viewVersion;
  const [digest, accountListing, legacyListing] = await Promise.all([
    api('/api/digest').then((r) => r.json()), api('/api/accounts').then((r) => r.json()),
    api('/api/conversations').then((r) => r.json()),
  ]);
  if (version !== viewVersion) return;
  $('#kin-count').textContent = digest.kins;
  $('#conversation-count').textContent = digest.conversations;
  $('#message-count').textContent = digest.messages;
  $('#last-archived').textContent = digest.lastArchivedAt ? displayDate(digest.lastArchivedAt) : '—';
  accounts = accountListing.accounts; legacyConversations = legacyListing.conversations;
  // Rebuild navigation after a refresh or import, retaining valid selections.
  selection = { accountId: null, kinId: null, conversationId: null, legacy: false };
  kins = []; renderAccounts(); renderKins(); clearConversations(); clearProfile();
  if (previous.legacy && legacyConversations.length) {
    await selectLegacy(previous);
  } else {
    const account = accounts.find((item) => item.accountId === previous.accountId) ||
      (accounts.length === 1 && !legacyConversations.length ? accounts[0] : null);
    if (account) await selectAccount(account.accountId, previous);
  }
}
function showError(e) { showToast(e?.message || 'Something went wrong.', 'error'); }
async function open() {
  await refresh(); sessionStorage.setItem('kinexport-token', token);
  $('#login').hidden = true; $('#archive').hidden = false; $('#lock').hidden = false;
  revealMessagesAtBottom();
}
$('#login-form').addEventListener('submit', async (e) => { e.preventDefault(); token = $('#token').value; try { await open(); } catch (err) { token = ''; showError(err); } });
$('#lock').addEventListener('click', lock);
$('#refresh').addEventListener('click', () => refresh().then(() => showToast('Archive refreshed.')).catch(showError));
$('#search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const version = viewVersion;
  try {
    const result = await api(`/api/search?q=${encodeURIComponent($('#search').value.trim())}`).then((r) => r.json());
    if (version !== viewVersion) return;
    const container = $('#search-results'); container.replaceChildren();
    const close = document.createElement('button'); close.type = 'button'; close.className = 'secondary search-dismiss';
    close.textContent = 'Close'; close.setAttribute('aria-label', 'Close search results');
    close.addEventListener('click', () => container.replaceChildren());
    container.append(close);
    container.append(textElement('p', `${result.messages.length} result(s)${result.messages.length === 100 ? ' (showing first 100)' : ''}.`));
    for (const message of newestMessages(result.messages)) {
      const article = renderMessage(message, message.kinName || '');
      const context = message.kinName || (message.accountId ? 'Unnamed Kin' : 'Unassigned conversation');
      const sender = article.querySelector('strong');
      if (sender.textContent !== context) sender.prepend(textElement('span', `${context}: `, 'search-kin'));
      container.append(article);
    }
  } catch (err) { showError(err); }
});
$('#search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('#search-results').replaceChildren();
});
async function startDownload(format) {
  const timestamp = downloadTimestamp();
  await api('/api/download-ticket', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({format, timestamp}) });
  const link=document.createElement('a'); link.href=`/api/download/${format}`; link.download=format === 'portable' ? `kinexport-${timestamp}.zip` : `kinexport-backup-${timestamp}.sqlite3`; link.click();
  showToast('Preparing download.');
}
$('#export').addEventListener('click', () => startDownload('portable').catch(showError));
$('#backup-download').addEventListener('click', () => { closeDropdown(dropdowns[3], true); return startDownload('sqlite').catch(showError); });
$('#backup-restore').addEventListener('click', () => { closeDropdown(dropdowns[3], true); $('#backup-file').click(); });
$('#backup-file').addEventListener('change', async event => {
  const file=event.target.files?.[0]; if (!file) return;
  try {
    if (!confirm(`Restore "${file.name}"? This replaces the current archive. KinExport will first save a SQLite backup of the current archive on the server.`)) return;
    $('#backup-label').textContent='Restoring…'; $('#backup-restore').disabled=true;
    const result=await api('/api/restore/sqlite',{method:'POST',headers:{'Content-Type':'application/vnd.sqlite3'},body:file}).then(r=>r.json());
    await refresh(); showToast(result.previousBackup ? 'Backup restored. The previous archive was saved on the server.' : 'Backup restored.');
  } catch (error) { showError(error); } finally { event.target.value=''; $('#backup-label').textContent='SQLite backups'; $('#backup-restore').disabled=false; }
});
$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    event.target.disabled=true; $('#import-label').textContent='Importing…';
    await api('/api/import/portable', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file }).then(r => r.json());
    await refresh(); showToast('Import complete.');
  } catch (err) { showError(err); } finally { event.target.value = ''; event.target.disabled=false; $('#import-label').textContent='Import ZIP'; }
});
if (token) open().catch(() => lock());
