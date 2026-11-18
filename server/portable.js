import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

import { archiveSchema, matchesArchiveSchema } from './archive.js';

const FORMAT = 'kinkeep-portable';
const VERSION = 1;
const MAX_UPLOAD = 64 * 1024 ** 3;
const MAX_EXPANDED = 128 * 1024 ** 3;
const MAX_DATABASE = 64 * 1024 ** 3;
const MAX_IMAGE = 8 * 1024 ** 2;
const MAX_SMALL_FILE = 64 * 1024;
const MAX_ENTRIES = 500_000;
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const failure = message => Object.assign(new Error(message), { status: 400 });

async function workspace(archive) {
  const base = archive.databasePath === ':memory:' ? tmpdir() : dirname(archive.databasePath);
  return mkdtemp(join(base, '.kinkeep-'));
}
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function openSnapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA foreign_keys=ON'); }
  catch (error) { db.close(); throw error; }
  return db;
}
export function validateSnapshot(source) {
  try {
    if (!matchesArchiveSchema(source)) throw failure('Unsupported SQLite archive schema.');
    const integrity = source.prepare('PRAGMA integrity_check').iterate();
    for (const row of integrity) if (Object.values(row)[0] !== 'ok') throw failure('SQLite archive failed integrity checks.');
    if (source.prepare('PRAGMA foreign_key_check').get()) throw failure('SQLite archive has invalid references.');
    if (source.prepare(`SELECT 1 FROM kin_profile_history h LEFT JOIN kin_profile_fields f ON f.account_id=h.account_id AND f.kin_id=h.kin_id AND f.field=h.field WHERE f.field IS NULL LIMIT 1`).get()) throw failure('SQLite archive has unassociated profile history.');
  } catch (error) {
    if (error.status) throw error;
    throw failure('Invalid SQLite archive.');
  }
}

async function materializePortable(archive, dir) {
  const snapshotPath = join(dir, 'snapshot.sqlite3'), databasePath = join(dir, 'archive.sqlite3');
  await backup(archive.db, snapshotPath);
  const source = openSnapshot(snapshotPath);
  const mediaDir = join(dir, 'media'); await mkdir(mediaDir);
  const media = []; let mediaBytes = 0;
  try {
    if (!matchesArchiveSchema(source)) throw Object.assign(new Error('This database schema cannot be exported as portable format version 1.'),{status:409});
    const getBlob = source.prepare('SELECT bytes FROM media_blobs WHERE sha256=?');
    for (const row of source.prepare('SELECT sha256,mime FROM media_blobs ORDER BY sha256').iterate()) {
      const ext = extensions[row.mime];
      if (!ext || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new Error('Archive contains an unsupported image.');
      const bytes = Buffer.from(getBlob.get(row.sha256).bytes);
      if (!bytes.length || bytes.length > MAX_IMAGE || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error('Archive contains a damaged image.');
      mediaBytes += bytes.length;
      if (media.length >= MAX_ENTRIES - 3 || mediaBytes > MAX_UPLOAD) throw Object.assign(new Error('Archive exceeds the portable export limit.'),{status:413});
      const name = `${row.sha256}.${ext}`;
      await writeFile(join(mediaDir, name), bytes, { mode:0o600, flag:'wx' });
      media.push(name);
    }
    // Build a metadata-only database from the consistent snapshot. This avoids
    // duplicating all image bytes inside the ZIP or vacuuming a full-size copy.
    const metadata = new DatabaseSync(databasePath);
    try {
      metadata.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=OFF; PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF');
      metadata.prepare('ATTACH DATABASE ? AS snapshot_source').run(snapshotPath);
      const objects = archiveSchema(source);
      for (const [type,,,sql] of objects) if (type === 'table') metadata.exec(sql);
      metadata.exec('BEGIN');
      try {
        for (const [type,name] of objects) {
          if (type !== 'table' || name === 'media_thumbnails') continue;
          if (name === 'media_blobs') metadata.exec("INSERT INTO main.media_blobs(sha256,mime,bytes) SELECT sha256,mime,X'' FROM snapshot_source.media_blobs");
          else metadata.exec(`INSERT INTO main."${name}" SELECT * FROM snapshot_source."${name}"`);
        }
        metadata.exec('COMMIT');
      } catch (error) { metadata.exec('ROLLBACK'); throw error; }
      for (const [type,,,sql] of objects) if (type === 'index' && sql) metadata.exec(sql);
      metadata.exec('DETACH DATABASE snapshot_source');
      if (!matchesArchiveSchema(metadata)) throw new Error('Could not construct the portable database schema.');
    } finally { metadata.close(); }
  } finally { source.close(); }
  const databaseSize = (await stat(databasePath)).size;
  // Include a conservative allowance for ZIP metadata and deflate overhead so
  // every generated export remains within the upload limit on re-import.
  if (databaseSize > MAX_DATABASE || Math.ceil(databaseSize * 1.01) + mediaBytes + media.length * 512 + MAX_SMALL_FILE * 2 > MAX_UPLOAD) throw Object.assign(new Error('Archive exceeds the portable export limit.'),{status:413});
  const manifest = { format:FORMAT, version:VERSION, createdAt:new Date().toISOString(), database:'archive.sqlite3', databaseSha256:await sha256(databasePath), mediaDirectory:'media/', mediaCount:media.length };
  return { databasePath, mediaDir, media, manifest };
}
export async function streamPortable(archive, response, timestamp) {
  const dir = await workspace(archive);
  try {
    const data = await materializePortable(archive, dir);
    const zip = new yazl.ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    zip.addBuffer(Buffer.from(JSON.stringify(data.manifest, null, 2) + '\n'), 'manifest.json', { mode:0o100600 });
    zip.addBuffer(Buffer.from('KinKeep portable archive\n\narchive.sqlite3 contains archive metadata. Images are in media/ and named by their SHA-256 digest. The database references those files by digest; KinKeep restores them during import. This archive is not encrypted.\n'), 'README.txt', { mode:0o100600 });
    zip.addFile(data.databasePath, 'archive.sqlite3', { mode:0o100600 });
    for (const name of data.media) zip.addFile(join(data.mediaDir,name), `media/${name}`, { compress:false, mode:0o100600 });
    response.writeHead(200, { 'Content-Type':'application/zip', 'Content-Disposition':`attachment; filename="kinkeep${timestamp ? `-${timestamp}` : ''}.zip"`, 'Cache-Control':'no-store' });
    zip.end();
    await pipeline(zip.outputStream, response);
  } finally { await rm(dir, {recursive:true,force:true}); }
}
export async function streamBackup(archive, response, timestamp) {
  const dir = await workspace(archive);
  try {
    const path = join(dir,'kinkeep.sqlite3'); await backup(archive.db,path);
    if ((await stat(path)).size > MAX_UPLOAD) throw Object.assign(new Error('Archive exceeds the SQLite backup restore limit.'),{status:413});
    response.writeHead(200, { 'Content-Type':'application/vnd.sqlite3', 'Content-Disposition':`attachment; filename="kinkeep-backup${timestamp ? `-${timestamp}` : ''}.sqlite3"`, 'Cache-Control':'no-store' });
    await pipeline(createReadStream(path),response);
  } finally { await rm(dir,{recursive:true,force:true}); }
}
async function receive(req, path) {
  if (Number(req.headers?.['content-length']) > MAX_UPLOAD) {
    throw Object.assign(new Error('File exceeds the upload limit.'), { status: 413 });
  }
  let size = 0;
  const limiter = new Transform({ transform(chunk,_encoding,done) { size += chunk.length; done(size > MAX_UPLOAD ? Object.assign(new Error('File exceeds the upload limit.'),{status:413}) : null,chunk); } });
  await pipeline(req,limiter,createWriteStream(path,{mode:0o600,flags:'wx'}));
  if (!size) throw failure('The file is empty.');
}
async function extractPortable(path, dir) {
  const zip = await yauzl.openPromise(path,{ strictFileNames:true,validateEntrySizes:true });
  const names = new Set(), media = new Map(); let total = 0, entries = 0, databaseDigest;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (++entries > MAX_ENTRIES || names.has(name)) throw failure('Invalid or duplicate archive entry.');
      names.add(name);
      const match = /^media\/([0-9a-f]{64})\.(png|jpg|webp)$/.exec(name);
      if (!['manifest.json','README.txt','archive.sqlite3'].includes(name) && !match) throw failure('Unexpected archive entry.');
      if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000 || entry.generalPurposeBitFlag & 1) throw failure('Unsupported archive entry.');
      const limit = match ? MAX_IMAGE : name === 'archive.sqlite3' ? MAX_DATABASE : MAX_SMALL_FILE;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limit || (total += entry.uncompressedSize) > MAX_EXPANDED) throw failure('Archive entry exceeds its size limit.');
      const output = match ? join(dir,`media-${match[1]}.${match[2]}`) : join(dir,name);
      const hash = createHash('sha256');
      const hashing = new Transform({transform(chunk,_encoding,done){hash.update(chunk);done(null,chunk)}});
      await pipeline(await zip.openReadStreamPromise(entry),hashing,createWriteStream(output,{mode:0o600,flags:'wx'}));
      const digest = hash.digest('hex');
      if (name === 'archive.sqlite3') databaseDigest = digest;
      if (match) {
        if (digest !== match[1] || media.has(match[1])) throw failure('Image digest mismatch or duplicate image.');
        media.set(match[1], {path:output,ext:match[2]});
      }
    }
  } finally { zip.close(); }
  if (!names.has('manifest.json') || !names.has('archive.sqlite3')) throw failure('Archive is missing its manifest or database.');
  let manifest; try { manifest = JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')); } catch { throw failure('Invalid archive manifest.'); }
  if (!manifest || manifest.format !== FORMAT || manifest.version !== VERSION || manifest.database !== 'archive.sqlite3' || manifest.mediaDirectory !== 'media/' || !/^[0-9a-f]{64}$/.test(manifest.databaseSha256) || !Number.isSafeInteger(manifest.mediaCount) || manifest.mediaCount !== media.size) throw failure('Unsupported archive manifest.');
  const databasePath = join(dir,'archive.sqlite3');
  if (databaseDigest !== manifest.databaseSha256) throw failure('Archive database digest mismatch.');
  return {databasePath,media};
}
async function restoreMedia(path, media) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON');
    const update = db.prepare('UPDATE media_blobs SET bytes=? WHERE sha256=?'); let count=0;
    for (const row of db.prepare('SELECT sha256,mime,length(bytes) AS size FROM media_blobs').iterate()) {
      const item=media.get(row.sha256), ext=extensions[row.mime];
      if (!item || !ext || item.ext !== ext || row.size !== 0) throw failure('Archive image list does not match its database.');
      update.run(await readFile(item.path),row.sha256); count++;
    }
    if (count !== media.size) throw failure('Archive contains an unreferenced image file.');
  } finally { db.close(); }
}
export async function importPortable(archive, req) {
  const dir=await workspace(archive);
  try {
    const input=join(dir,'incoming.zip'); await receive(req,input);
    const {databasePath,media}=await extractPortable(input,dir);
    const metadata=openSnapshot(databasePath);
    try { validateSnapshot(metadata); } finally { metadata.close(); }
    await restoreMedia(databasePath,media);
    const source=openSnapshot(databasePath);
    try { validateSnapshot(source); return archive.mergeSnapshot(source); }
    finally { source.close(); }
  } catch (error) {
    if (error.status || error.code === 'ENOSPC' || error.code === 'EACCES') throw error;
    throw failure('Invalid or damaged portable archive.');
  } finally { await rm(dir,{recursive:true,force:true}); }
}
export async function restoreBackup(archive, req, createArchive) {
  const dir=await workspace(archive);
  try {
    const input=join(dir,'incoming.sqlite3'); await receive(req,input);
    const source=openSnapshot(input);
    try {
      validateSnapshot(source);
      // Validate record contents against the normal import rules before replacing anything.
      const scratch=createArchive({databasePath:join(dir,'validation.sqlite3'),token:'backup-validation'});
      try { scratch.mergeSnapshot(source); } finally { scratch.db.close(); }
      const backupDir=archive.databasePath === ':memory:' ? dir : join(dirname(archive.databasePath),'backups');
      await mkdir(backupDir,{recursive:true,mode:0o700});
      const saved=join(backupDir,`pre-restore-${new Date().toISOString().replaceAll(':','-')}-${randomUUID()}.sqlite3`);
      // Publish only a complete copy, including when backups is a separate mount.
      const stagingDir = await mkdtemp(join(backupDir,'.recovery-'));
      try {
        const staged = join(stagingDir,'recovery.sqlite3');
        const beforeBackup = archive.changeStamp();
        await backup(archive.db,staged);
        await chmod(staged,0o600);
        await rename(staged,saved);
        try { archive.replaceSnapshot(input, beforeBackup); }
        catch (error) {
          // A concurrent capture vetoes the restore before any records are replaced.
          if (error.status === 409) await rm(saved);
          throw error;
        }
      } finally { await rm(stagingDir, {recursive:true,force:true}); }
      return {ok:true,previousBackup:archive.databasePath === ':memory:' ? null : saved.split(/[\\/]/).at(-1)};
    } finally { source.close(); }
  } catch (error) {
    if (error.status || error.code === 'ENOSPC' || error.code === 'EACCES') throw error;
    throw failure('Invalid or damaged SQLite backup.');
  } finally { await rm(dir,{recursive:true,force:true}); }
}
