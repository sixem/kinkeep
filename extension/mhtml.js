// Extract only already-loaded image parts whose exact URLs were observed in the
// current Kindroid page. This parser never fetches URLs or exposes page HTML.
const MAX_SNAPSHOT = 64 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024;
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function extractImages(mhtml, urls) {
  if (typeof mhtml !== 'string' || mhtml.length > MAX_SNAPSHOT || !Array.isArray(urls) || urls.length > 100) return new Map();
  const wanted = new Set(urls.filter(url => typeof url === 'string' && url.length > 0 && url.length <= 8192));
  if (!wanted.size) return new Map();
  const separator = /\r?\n\r?\n/.exec(mhtml);
  if (!separator) return new Map();
  const header = mhtml.slice(0, separator.index).replace(/\r?\n[ \t]+/g, ' ');
  const boundary = /(?:^|;)\s*boundary\s*=\s*(?:"([^"\r\n]{1,200})"|([^;\s\r\n]{1,200}))/i.exec(header)?.slice(1).find(Boolean);
  if (!boundary) return new Map();
  const result = new Map();
  for (const part of mhtml.slice(separator.index + separator[0].length).split(`--${boundary}`)) {
    const split = /\r?\n\r?\n/.exec(part);
    if (!split) continue;
    const headers = part.slice(0, split.index).replace(/=\r?\n/g, '').replace(/\r?\n[ \t]+/g, ' ');
    const get = key => new RegExp(`^${key}:\\s*([^\\r\\n]+)`, 'im').exec(headers)?.[1]?.trim();
    const location = get('Content-Location');
    const mime = get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!wanted.has(location) || !imageTypes.has(mime) || get('Content-Transfer-Encoding')?.toLowerCase() !== 'base64') continue;
    const data = part.slice(split.index + split[0].length).replace(/\s/g, '');
    if (!data || data.length > MAX_IMAGE_BASE64 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) continue;
    const previous = result.get(location);
    if (previous && (previous.mime !== mime || previous.data !== data)) result.set(location, null);
    else if (previous !== null) result.set(location, { mime, data });
  }
  for (const [url, value] of result) if (!value) result.delete(url);
  return result;
}
