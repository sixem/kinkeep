export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, endpoint: 'http://127.0.0.1:8765', token: '' });

export function normalizeEndpoint(value) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Enter an HTTP(S) URL without credentials, query, or fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function permissionFor(endpoint) {
  const url = new URL(normalizeEndpoint(endpoint));
  return `${url.protocol}//${url.hostname}/*`;
}

export function isKindroidImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === 'kindroid.ai' || url.hostname.endsWith('.kindroid.ai'));
  } catch { return false; }
}

export function selectMissing(messages, response) {
  if (!Array.isArray(response?.results) || response.results.length !== messages.length) {
    throw new Error('The archive returned an invalid probe response.');
  }
  return messages.filter((_, index) => {
    const status = response.results[index]?.status;
    if (!['missing', 'changed', 'unchanged'].includes(status)) {
      throw new Error('The archive returned an unknown probe status.');
    }
    return status !== 'unchanged';
  });
}

export function isCaptureMessage(message) {
  return Boolean(message && typeof message === 'object' &&
    typeof message.conversationId === 'string' && message.conversationId.length > 0 &&
    typeof message.fingerprint === 'string' && message.fingerprint.length > 0 &&
    typeof message.content === 'string' &&
    (message.messageId === undefined || typeof message.messageId === 'string'));
}
