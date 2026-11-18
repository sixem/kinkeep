import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchive } from './archive.js';
import { streamPortable, streamBackup, importPortable, restoreBackup } from './portable.js';
import { MAX_BODY, error, object, onlyKeys, requiredString, scopeFrom } from './validation.js';

export { createArchive };

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

function downloadTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})(?:Z|([+-])(\d{2})-(\d{2}))$/.exec(value);
  if (!match) throw error(400, 'Invalid download timestamp');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = Number(offsetHourText), offsetMinute = Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59 ||
      (sign && (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)))) {
    throw error(400, 'Invalid download timestamp');
  }
  return value;
}

function parseMessagePage(query) {
  if (!query.has('limit') && !query.has('cursor') && !query.has('direction')) return null;
  const value = query.get('limit');
  if (value !== null && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) throw error(400, 'Invalid message page limit');
  const cursor = query.get('cursor');
  if (cursor !== null && !cursor) throw error(400, 'Invalid message cursor');
  const direction = query.get('direction') ?? 'older';
  if (!['older', 'newer', 'oldest'].includes(direction) || (direction === 'oldest' && cursor !== null) || (direction === 'newer' && cursor === null)) throw error(400, 'Invalid message page direction');
  return { limit: value === null ? 50 : Number(value), cursor, direction };
}

function validToken(provided, expected) {
  if (typeof provided !== 'string' || !provided.startsWith('Bearer ')) return false;
  const a = Buffer.from(provided.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let finished = false;
    const fail = (err) => { if (finished) return; finished = true; chunks.length = 0; reject(err); };
    req.on('data', (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) { fail(error(413, 'Request too large')); req.resume(); }
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(error(400, 'Invalid JSON')); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(error(400, 'Request aborted')));
    // Reject a known oversized body immediately, without waiting for the sender.
    const length = req.headers?.['content-length'];
    if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > limit) {
      fail(error(413, 'Request too large')); req.resume();
    }
  });
}
function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/favicon.png', ['favicon.png', 'image/png']],
  ['/fonts/InterVariable.woff2', ['fonts/InterVariable.woff2', 'font/woff2']],
  ['/fonts/InterVariable-Italic.woff2', ['fonts/InterVariable-Italic.woff2', 'font/woff2']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['messages', 'personality', 'journal', 'images', 'settings', 'download', 'upload', 'refresh', 'search', 'lock', 'arrow-up']
    .map(name => [`/icons/${name}.svg`, [`icons/${name}.svg`, 'image/svg+xml']]),
]);
export function createHttpServer({ archive, token, allowedHosts = ['127.0.0.1', 'localhost', '::1'] }) {
  const tickets = new Map();
  let transferBusy = false;
  async function transfer(fn) {
    if (transferBusy) throw error(409, 'Another archive transfer is in progress.');
    transferBusy = true;
    try { return await fn(); } finally { transferBusy = false; }
  }
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      // A restrictive Host allowlist prevents a hostile DNS name from rebinding to the local archive.
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
      catch { return sendJson(res, 400, { error: 'Invalid host' }); }
      if (!allowedHosts.includes(hostname)) return sendJson(res, 403, { error: 'Host not allowed' });
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(publicDir, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { status: 'ok' });
      if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
      if (req.method === 'GET' && ['/api/download/portable','/api/download/sqlite'].includes(url.pathname)) {
        const value = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('kinkeep_download='))?.slice('kinkeep_download='.length);
        const ticket = value ? tickets.get(value) : null;
        if (value) tickets.delete(value);
        const format = url.pathname.endsWith('/portable') ? 'portable' : 'sqlite';
        const validTicket = ticket && ticket.expires >= Date.now() && ticket.format === format ? ticket : null;
        if (!validToken(req.headers.authorization, token) && !validTicket) return sendJson(res, 401, { error:'Unauthorized' });
        res.setHeader('Set-Cookie','kinkeep_download=; Path=/api/download; Max-Age=0; HttpOnly; SameSite=Strict');
        return await transfer(() => format === 'portable' ? streamPortable(archive,res,validTicket?.timestamp) : streamBackup(archive,res,validTicket?.timestamp));
      }
      if (!validToken(req.headers.authorization, token)) return sendJson(res, 401, { error: 'Unauthorized' });
      if (req.method === 'GET' && url.pathname === '/api/session') return sendJson(res, 200, { authenticated: true });
      const contentType = req.headers['content-type']?.split(';')[0].trim();
      if (req.method === 'POST' && url.pathname === '/api/import/portable') {
        if (contentType !== 'application/zip') throw error(415, 'Expected application/zip');
        return sendJson(res,200,await transfer(() => importPortable(archive,req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/restore/sqlite') {
        if (contentType !== 'application/vnd.sqlite3') throw error(415, 'Expected application/vnd.sqlite3');
        return sendJson(res,200,await transfer(() => restoreBackup(archive,req,createArchive)));
      }
      if (req.method === 'POST' && contentType !== 'application/json') throw error(415, 'Expected application/json');
      if (req.method === 'POST' && url.pathname === '/api/download-ticket') {
        const body=await readJson(req); object(body,'download'); onlyKeys(body,['format','timestamp'],'download');
        if (!['portable','sqlite'].includes(body.format)) throw error(400,'Invalid download format');
        const timestamp = Object.hasOwn(body,'timestamp') ? downloadTimestamp(body.timestamp) : undefined;
        if (transferBusy) throw error(409,'Another archive transfer is in progress.');
        const now=Date.now(); for (const [key,ticket] of tickets) if (ticket.expires < now) tickets.delete(key);
        if (tickets.size >= 20) throw error(429,'Too many pending downloads.');
        const value=randomBytes(32).toString('base64url'); tickets.set(value,{format:body.format,timestamp,expires:now+120_000});
        return sendJson(res,200,{ok:true},{'Set-Cookie':`kinkeep_download=${value}; Path=/api/download; Max-Age=120; HttpOnly; SameSite=Strict`});
      }
      if (req.method === 'POST' && url.pathname === '/api/inventory') return sendJson(res, 200, archive.upsertInventory(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/kins/profile') return sendJson(res, 200, archive.upsertProfile(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/kins/media') {
        const body = await readJson(req); object(body, 'media batch'); onlyKeys(body, ['accountId', 'kinId', 'items'], 'media batch');
        return sendJson(res, 200, archive.media.save(scopeFrom(body), body.items));
      }
      if (req.method === 'GET' && url.pathname === '/api/kins/media') {
        const limit=url.searchParams.get('limit'), offset=url.searchParams.get('offset');
        if ((limit !== null && !/^\d+$/.test(limit)) || (offset !== null && !/^\d+$/.test(offset))) throw error(400, 'Invalid media page');
        return sendJson(res, 200, archive.media.list(scopeFrom(Object.fromEntries(url.searchParams)), limit===null?50:Number(limit), offset===null?0:Number(offset)));
      }
      if (req.method === 'GET' && url.pathname === '/api/media/blob') {
        const blob=archive.media.blob(url.searchParams.get('sha256'));
        if (!blob) return sendJson(res, 404, {error:'Media not found'});
        res.writeHead(200, {'Content-Type':blob.mime,'Content-Length':blob.bytes.length,'Cache-Control':'no-store'}); return res.end(blob.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/media/thumbnail') {
        const thumbnail = await archive.media.thumbnail(url.searchParams.get('sha256'));
        if (!thumbnail) return sendJson(res, 404, {error:'Media not found'});
        res.writeHead(200, {'Content-Type':thumbnail.mime,'Content-Length':thumbnail.bytes.length,'Cache-Control':'no-store'}); return res.end(thumbnail.bytes);
      }
      if (req.method === 'GET' && url.pathname === '/api/kins/profile') return sendJson(res, 200, archive.readProfile(scopeFrom(Object.fromEntries(url.searchParams))));
      if (req.method === 'POST' && url.pathname === '/api/kins/journal') return sendJson(res, 200, archive.upsertJournal(await readJson(req)));
      if (req.method === 'GET' && url.pathname === '/api/kins/journal') {
        const limit = url.searchParams.get('limit'); const offset = url.searchParams.get('offset');
        if ((limit !== null && !/^\d+$/.test(limit)) || (offset !== null && !/^\d+$/.test(offset))) throw error(400, 'Invalid journal page');
        return sendJson(res, 200, archive.journalPage(scopeFrom(Object.fromEntries(url.searchParams)), limit === null ? 50 : Number(limit), offset === null ? 0 : Number(offset)));
      }
      if (req.method === 'GET' && url.pathname === '/api/accounts') return sendJson(res, 200, { accounts: archive.accounts() });
      if (req.method === 'GET' && url.pathname === '/api/kins') return sendJson(res, 200, { kins: archive.kins(requiredString(url.searchParams.get('accountId'), 'accountId')) });
      if (req.method === 'POST' && (url.pathname === '/api/probe' || url.pathname === '/api/messages')) {
        const body = await readJson(req); const probe = url.pathname === '/api/probe'; const scope = scopeFrom(body);
        return sendJson(res, 200, probe ? archive.scopedProbe(scope, body.messages) : archive.scopedIngest(scope, body.messages));
      }
      if (req.method === 'GET' && url.pathname === '/api/digest') return sendJson(res, 200, archive.digest());
      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        const scope = scopeFrom(Object.fromEntries(url.searchParams));
        return sendJson(res, 200, { conversations: archive.scopedConversations(scope) });
      }
      if (req.method === 'GET' && url.pathname === '/api/search') return sendJson(res, 200, { messages: archive.search(requiredString(url.searchParams.get('q'), 'search query', 500)) });
      if (req.method === 'GET' && url.pathname === '/api/messages') {
        const scope = scopeFrom(Object.fromEntries(url.searchParams));
        const conversationId = url.searchParams.get('conversationId');
        const page = parseMessagePage(url.searchParams);
        if (page) return sendJson(res, 200, archive.archiveMessagePage(scope, conversationId, page));
        return sendJson(res, 200, { messages: archive.scopedArchiveMessages(scope, conversationId) });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (e) {
      if (res.headersSent || res.destroyed) { if (!res.destroyed) res.destroy(e); return; }
      // An oversized request may still be streaming. Send the 413 and close the
      // connection instead of keeping it open for an arbitrary remaining body.
      if (e.status === 413) { res.shouldKeepAlive = false; res.setHeader('Connection', 'close'); }
      if (!e.status) console.error('[KinKeep] Server error:', e.message);
      return sendJson(res, e.status || 500, { error: e.status ? e.message : 'Internal server error' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.KINKEEP_TOKEN;
  if (!token || token.length < 32) throw new Error('KINKEEP_TOKEN must be at least 32 characters');
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8765);
  const archive = createArchive({ databasePath: process.env.DATABASE_PATH || './data/kinkeep.sqlite', token });
  const allowedHosts = (process.env.ALLOWED_HOSTS || '127.0.0.1,localhost,::1').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  createHttpServer({ archive, token, allowedHosts }).listen(port, host, () => console.log(`KinKeep archive listening on ${host}:${port}`));
}
