import { createHash } from 'node:crypto';
import { createThumbnail } from './thumbnail.js';

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_BATCH = 8;
const MAX_PENDING_THUMBNAILS = 64;
const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() && value.length <= 2048;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const optional = (value, limit) => value == null || (typeof value === 'string' && value.length <= limit);
const hash = data => createHash('sha256').update(data).digest('hex');
function image(value, mime) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('Invalid image data');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE || bytes.toString('base64') !== value) fail('Invalid image data');
  return imageBytes(bytes, mime);
}
function imageBytes(value, mime) {
  const bytes = Buffer.from(value);
  if (!bytes.length || bytes.length > MAX_IMAGE) fail('Invalid image data');
  const valid = mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) :
    mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
    mime === 'image/webp' ? bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' : false;
  if (!valid) fail('Unsupported image');
  return bytes;
}
function validateItem(raw, importing = false) {
  if (!record(raw)) fail('Invalid media item');
  const allowed = ['sourceId','kind','variant','createdAt','prompt','messageId', ...(importing ? ['accountId','kinId','sha256','firstSeen','lastSeen'] : ['mime','data'])];
  if (Object.keys(raw).some(k => !allowed.includes(k)) || !id(raw.sourceId) || !['selfie','portrait'].includes(raw.kind) || !['preview','original','avatar'].includes(raw.variant) || (raw.kind === 'selfie' && !iso(raw.createdAt)) || (raw.createdAt != null && !iso(raw.createdAt)) || !optional(raw.prompt, 100000) || !optional(raw.messageId, 2048)) fail('Invalid media item');
  if ((raw.kind === 'portrait') !== (raw.variant === 'avatar')) fail('Invalid media variant');
  if (raw.messageId != null && !id(raw.messageId)) fail('Invalid media message');
  const out = { sourceId: raw.sourceId, kind: raw.kind, variant: raw.variant, createdAt: raw.createdAt ?? null, prompt: raw.prompt ?? null, messageId: raw.messageId ?? null };
  if (importing) {
    if (!/^[0-9a-f]{64}$/.test(raw.sha256) || !iso(raw.firstSeen) || !iso(raw.lastSeen) || raw.firstSeen > raw.lastSeen) fail('Invalid media archive item');
    return { ...out, sha256: raw.sha256, firstSeen: raw.firstSeen, lastSeen: raw.lastSeen };
  }
  const bytes = image(raw.data, raw.mime);
  return { ...out, bytes, mime: raw.mime, sha256: hash(bytes) };
}
export function createMediaStore(db, { requireScope, transact, generateThumbnail = createThumbnail }) {
  db.exec(`CREATE TABLE IF NOT EXISTS media_blobs(sha256 TEXT PRIMARY KEY,mime TEXT NOT NULL,bytes BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS media_thumbnails(sha256 TEXT PRIMARY KEY,bytes BLOB NOT NULL,FOREIGN KEY(sha256) REFERENCES media_blobs(sha256));
  CREATE TABLE IF NOT EXISTS media_items(account_id TEXT NOT NULL,kin_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,variant TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT,prompt TEXT,message_id TEXT,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(account_id,kin_id,kind,source_id,variant,sha256),FOREIGN KEY(account_id,kin_id) REFERENCES kins(account_id,kin_id),FOREIGN KEY(sha256) REFERENCES media_blobs(sha256));
  CREATE INDEX IF NOT EXISTS media_items_page ON media_items(account_id,kin_id,created_at DESC,first_seen DESC);
  CREATE INDEX IF NOT EXISTS media_items_recent ON media_items(account_id,kin_id,COALESCE(created_at,first_seen) DESC,source_id,variant,sha256);`);
  const addBlob = db.prepare('INSERT OR IGNORE INTO media_blobs(sha256,mime,bytes) VALUES(?,?,?)');
  const getBlob = db.prepare('SELECT mime,bytes FROM media_blobs WHERE sha256=?');
  const hasBlob = db.prepare('SELECT 1 FROM media_blobs WHERE sha256=?');
  const add = db.prepare(`INSERT INTO media_items(account_id,kin_id,kind,source_id,variant,sha256,created_at,prompt,message_id,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,kin_id,kind,source_id,variant,sha256) DO UPDATE SET last_seen=max(last_seen,excluded.last_seen),first_seen=min(first_seen,excluded.first_seen),prompt=COALESCE(prompt,excluded.prompt),message_id=COALESCE(message_id,excluded.message_id)`);
  function saveInside(scope, items, importing = false) {
    requireScope(scope); const now = new Date().toISOString(); let inserted = 0;
    for (const item of items) {
      if (!importing) addBlob.run(item.sha256,item.mime,item.bytes);
      if (!getBlob.get(item.sha256)) fail('Missing media file');
      const exists = db.prepare('SELECT 1 FROM media_items WHERE account_id=? AND kin_id=? AND kind=? AND source_id=? AND variant=? AND sha256=?').get(scope.accountId,scope.kinId,item.kind,item.sourceId,item.variant,item.sha256);
      add.run(scope.accountId,scope.kinId,item.kind,item.sourceId,item.variant,item.sha256,item.createdAt,item.prompt,item.messageId,item.firstSeen || now,item.lastSeen || now);
      if (!exists) inserted++;
    }
    return { inserted, unchanged: items.length-inserted };
  }
  function save(scope, raw) { if (!Array.isArray(raw) || raw.length > MAX_BATCH) fail('Invalid media batch'); const items=raw.map(x=>validateItem(x)); return transact(()=>saveInside(scope,items)); }
  function list(scope, limit=50, offset=0) {
    requireScope(scope);if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>250000)fail('Invalid media page');
    const total=db.prepare('SELECT count(*) AS n FROM media_items WHERE account_id=? AND kin_id=?').get(scope.accountId,scope.kinId).n;
    const items=db.prepare(`SELECT kind,source_id AS sourceId,variant,sha256,created_at AS createdAt,prompt,message_id AS messageId,first_seen AS firstSeen,last_seen AS lastSeen FROM media_items WHERE account_id=? AND kin_id=? ORDER BY COALESCE(created_at,first_seen) DESC,source_id,variant,sha256 LIMIT ? OFFSET ?`).all(scope.accountId,scope.kinId,limit,offset);
    return { ...scope, items,total,nextOffset:offset+limit<total?offset+limit:null };
  }
  function blob(sha256) { if(typeof sha256!=='string'||!/^[0-9a-f]{64}$/.test(sha256))fail('Invalid media digest');const row=getBlob.get(sha256);return row?{mime:row.mime,bytes:Buffer.from(row.bytes)}:null; }
  const pendingThumbnails = new Map(), thumbnailQueue = [];
  let activeThumbnails = 0;
  function runThumbnailQueue() {
    while (activeThumbnails < 3 && thumbnailQueue.length) {
      const job = thumbnailQueue.shift(); activeThumbnails++;
      // Load at most the active images into memory. Queued requests keep only
      // a digest, rather than retaining up to 8 MiB each while waiting.
      Promise.resolve().then(() => {
        const original = blob(job.sha256);
        return original ? generateThumbnail(original.bytes) : null;
      }).then(bytes => {
        if (!bytes) { job.resolve(null); return; }
        db.prepare('INSERT OR IGNORE INTO media_thumbnails(sha256,bytes) VALUES(?,?)').run(job.sha256, bytes);
        job.resolve({ mime: 'image/webp', bytes });
      }).catch(job.reject).finally(() => { activeThumbnails--; pendingThumbnails.delete(job.sha256); runThumbnailQueue(); });
    }
  }
  function thumbnail(sha256) {
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('Invalid media digest');
    const existing = db.prepare('SELECT bytes FROM media_thumbnails WHERE sha256=?').get(sha256);
    if (existing) return Promise.resolve({ mime:'image/webp', bytes:Buffer.from(existing.bytes) });
    if (pendingThumbnails.has(sha256)) return pendingThumbnails.get(sha256);
    if (!hasBlob.get(sha256)) return Promise.resolve(null);
    if (pendingThumbnails.size >= MAX_PENDING_THUMBNAILS) throw Object.assign(new Error('Thumbnail generation is busy. Please retry.'), { status: 503 });
    const task = new Promise((resolve,reject) => thumbnailQueue.push({ sha256, resolve, reject }));
    pendingThumbnails.set(sha256, task); runThumbnailQueue(); return task;
  }
  function count() { return db.prepare('SELECT count(*) AS n FROM media_items').get().n; }
  function exportData() {
    const blobs=db.prepare('SELECT sha256,mime,bytes FROM media_blobs ORDER BY sha256').all().map(x=>({sha256:x.sha256,mime:x.mime,data:Buffer.from(x.bytes).toString('base64')}));
    const items=db.prepare('SELECT account_id AS accountId,kin_id AS kinId,kind,source_id AS sourceId,variant,sha256,created_at AS createdAt,prompt,message_id AS messageId,first_seen AS firstSeen,last_seen AS lastSeen FROM media_items ORDER BY account_id,kin_id,kind,source_id,variant,sha256').all();
    return {blobs,items};
  }
  function validateArchive(raw) {
    if(!record(raw)||Object.keys(raw).some(x=>!['blobs','items'].includes(x))||!Array.isArray(raw.blobs)||!Array.isArray(raw.items)||raw.blobs.length>250000||raw.items.length>250000)fail('Invalid media archive');
    const blobs=raw.blobs.map(x=>{if(!record(x)||Object.keys(x).some(k=>!['sha256','mime','data'].includes(k))||!/^[0-9a-f]{64}$/.test(x.sha256))fail('Invalid media file');const bytes=image(x.data,x.mime);if(hash(bytes)!==x.sha256)fail('Media digest mismatch');return {...x,bytes};});
    const ids=new Set(blobs.map(x=>x.sha256));if(ids.size!==blobs.length)fail('Duplicate media file');
    const items=raw.items.map(x=>{if(!id(x.accountId)||!id(x.kinId)||!ids.has(x.sha256))fail('Invalid media scope');return {scope:{accountId:x.accountId,kinId:x.kinId},item:validateItem(x,true)}});
    return {blobs,items};
  }
  function importInside(data) { for(const b of data.blobs)addBlob.run(b.sha256,b.mime,b.bytes);for(const x of data.items)saveInside(x.scope,[x.item],true); }
  function importBlob(sha256, mime, data) {
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('Invalid media digest');
    const bytes = imageBytes(data, mime);
    if (hash(bytes) !== sha256) fail('Media digest mismatch');
    addBlob.run(sha256, mime, bytes);
  }
  function importItem(raw) {
    const scope = { accountId: raw.accountId, kinId: raw.kinId };
    return saveInside(scope, [validateItem(raw, true)], true);
  }
  return { save,list,blob,thumbnail,count,exportData,validateArchive,importInside,importBlob,importItem };
}
