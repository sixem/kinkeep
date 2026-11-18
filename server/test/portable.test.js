import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { createArchive, createHttpServer } from '../server.js';
import { archiveSchema } from '../archive.js';
import { streamPortable, streamBackup, importPortable, restoreBackup, validateSnapshot } from '../portable.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAeAQMAAAAW3KwoAAAAIGNIUk0AAHomAACAhAAA+gAAAID6AACAhAAA6mAAADqYAAAXcJy6UTwAAAAGUExURQAA/////3vcmSwAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gsQEg0c4s+h1gAAAAxJREFUCNdjYBgYAAAAeAAB2u2iVwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xNlQxODoxMzoyOCswMDowMISgOgkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTZUMTg6MTM6MjgrMDA6MDD1/YK1AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTExLTE2VDE4OjEzOjI4KzAwOjAwouijagAAAABJRU5ErkJggg==';
const timestamp='2026-01-01T12:00:00.000Z';
function archive(dir,name) { return createArchive({ databasePath:join(dir,`${name}.sqlite3`),token:'test-token' }); }
function populate(a) {
  a.upsertAccount({accountId:'a',displayName:'Account'}); a.upsertKin({accountId:'a',kinId:'k',name:'Kin'});
  a.upsertProfile({accountId:'a',kinId:'k',fields:{ai_backstory_plaintext:{value:'Earlier',observedAt:timestamp}}});
  a.upsertProfile({accountId:'a',kinId:'k',fields:{ai_backstory_plaintext:{value:'Current',observedAt:'2026-01-02T12:00:00.000Z'}}});
  a.upsertJournal({accountId:'a',kinId:'k',entries:[{entryId:'j',createdAt:timestamp,description:'Journal text'}]});
  a.upsertJournal({accountId:'a',kinId:'k',entries:[{entryId:'j',createdAt:timestamp,description:'Journal alternative'}]});
  a.scopedIngest({accountId:'a',kinId:'k'},[{conversationId:'main',messageId:'m',fingerprint:'one',sender:'kin',timestamp,content:'Original',data:{captureSource:'cache',reactions:{actor:'❤️'}}}]);
  a.scopedIngest({accountId:'a',kinId:'k'},[{conversationId:'main',messageId:'m',fingerprint:'two',sender:'kin',timestamp,content:'Edited',data:{captureSource:'cache',reactions:{actor:'👩🏽‍🚀'}}}]);
  a.media.save({accountId:'a',kinId:'k'},[{sourceId:'image',kind:'selfie',variant:'preview',createdAt:timestamp,mime:'image/png',data:png}]);
}
function snapshot(archive) {
  return Object.fromEntries(archiveSchema(archive.db).filter(([type]) => type === 'table')
    .map(([, name]) => [name, archive.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
function output() { const chunks=[];const stream=new Writable({write(chunk,_enc,done){chunks.push(Buffer.from(chunk));done()}});stream.writeHead=(status,headers)=>{stream.status=status;stream.headers=headers};return {stream,bytes:()=>Buffer.concat(chunks)}; }
async function zipBuffer(entries, { zip64=false } = {}) { const z=new yazl.ZipFile(),sink=output();z.on('error',e=>sink.stream.destroy(e));z.outputStream.pipe(sink.stream);for(const [name,data] of entries)z.addBuffer(Buffer.from(data),name,{forceZip64Format:zip64});z.end({forceZip64Format:zip64});await new Promise((resolve,reject)=>{sink.stream.on('finish',resolve);sink.stream.on('error',reject)});return sink.bytes(); }
async function unzipEntries(bytes) {
  const zip=await yauzl.fromBufferPromise(bytes),entries=[];
  for await(const entry of zip.eachEntry()) { const chunks=[]; for await(const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk); entries.push([entry.fileName,Buffer.concat(chunks)]); }
  return entries;
}

test('portable ZIP streams and merges a complete archive without duplicating existing records', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-portable-test-'));const src=archive(dir,'source'),dst=archive(dir,'target');
  try { populate(src);const expected=snapshot(src),sink=output();await streamPortable(src,sink.stream);assert.equal(sink.stream.headers['Content-Type'],'application/zip');
    const bytes=sink.bytes(),zip=await yauzl.fromBufferPromise(bytes),names=[];for await(const entry of zip.eachEntry())names.push(entry.fileName);
    assert.ok(names.includes('manifest.json'));assert.ok(names.includes('archive.sqlite3'));assert.equal(names.filter(n=>/^media\/[a-f0-9]{64}\.png$/.test(n)).length,1);
    const imported=await importPortable(dst,Readable.from(bytes));assert.equal(imported.inserted,1);assert.deepEqual(snapshot(dst),expected);
    const repeat=await importPortable(dst,Readable.from(await zipBuffer(await unzipEntries(bytes),{zip64:true})));assert.equal(repeat.inserted,0);assert.deepEqual(snapshot(dst),expected);
  } finally {src.db.close();dst.db.close();await rm(dir,{recursive:true,force:true})}
});
test('invalid portable archives do not change the existing archive', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-portable-test-'));const dst=archive(dir,'target');
  try {populate(dst);const before=snapshot(dst);for(const bytes of [Buffer.from('not a zip'),await zipBuffer([['manifest.json','{}'],['archive.sqlite3','invalid']]),await zipBuffer([['unexpected.txt','bad']])]) {await assert.rejects(importPortable(dst,Readable.from(bytes)));assert.deepEqual(snapshot(dst),before)}}
  finally {dst.db.close();await rm(dir,{recursive:true,force:true})}
});
test('corrupted image data is rejected before changing the archive', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-portable-test-'));const src=archive(dir,'source'),dst=archive(dir,'target');
  try {
    populate(src);dst.upsertAccount({accountId:'existing'});const before=snapshot(dst),sink=output();await streamPortable(src,sink.stream);
    const entries=await unzipEntries(sink.bytes()),image=entries.find(([name])=>name.startsWith('media/'));image[1][image[1].length-1]^=1;
    await assert.rejects(importPortable(dst,Readable.from(await zipBuffer(entries))),/digest mismatch/);assert.deepEqual(snapshot(dst),before);
  } finally {src.db.close();dst.db.close();await rm(dir,{recursive:true,force:true})}
});
test('a late invalid record rolls back the entire portable import', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-portable-test-'));const src=archive(dir,'source'),dst=archive(dir,'target');
  try {
    populate(src); dst.upsertAccount({accountId:'existing'}); const before=snapshot(dst);
    src.db.prepare('INSERT INTO kin_profile_fields VALUES(?,?,?,?,?,?,?)').run('a','k','unsupported_field','"bad"',timestamp,timestamp,'invalid-event');
    const sink=output();await streamPortable(src,sink.stream);
    await assert.rejects(importPortable(dst,Readable.from(sink.bytes())),/Unsupported profile field/);
    assert.deepEqual(snapshot(dst),before);
  } finally {src.db.close();dst.db.close();await rm(dir,{recursive:true,force:true})}
});
test('SQLite backup restores exactly and saves the previous archive; invalid backups change nothing', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-backup-test-'));const src=archive(dir,'source'),dst=archive(dir,'target');
  try {populate(src);const expected=snapshot(src),sink=output();await streamBackup(src,sink.stream);assert.equal(sink.stream.headers['Content-Type'],'application/vnd.sqlite3');dst.upsertAccount({accountId:'other'});const before=snapshot(dst);
    await assert.rejects(restoreBackup(dst,Readable.from(Buffer.from('not sqlite')),createArchive));assert.deepEqual(snapshot(dst),before);
    const result=await restoreBackup(dst,Readable.from(sink.bytes()),createArchive);assert.equal(result.ok,true);assert.ok(result.previousBackup);assert.deepEqual(snapshot(dst),expected);assert.ok((await readdir(join(dir,'backups'))).includes(result.previousBackup));
    const recoveryPath=join(dir,'backups',result.previousBackup),saved=await readFile(recoveryPath);assert.equal(saved.subarray(0,16).toString('binary'),'SQLite format 3\u0000');
    const recovered=new DatabaseSync(recoveryPath,{readOnly:true});try {assert.equal(recovered.prepare('SELECT count(*) AS n FROM accounts WHERE account_id=?').get('other').n,1)} finally {recovered.close()}
  } finally {src.db.close();dst.db.close();await rm(dir,{recursive:true,force:true})}
});

test('snapshot validation checks user tables whose names start with sqlite', () => {
  const src = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    src.db.exec('CREATE TABLE sqliteExtra(note TEXT)');
    assert.throws(() => validateSnapshot(src.db), /Unsupported SQLite archive schema/);
  } finally { src.db.close(); }
});

test('opening an incompatible database leaves its schema and contents intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinkeep-schema-test-'));
  const path = join(dir, 'archive.sqlite3');
  try {
    const other = new DatabaseSync(path);
    try { other.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('sample');"); }
    finally { other.close(); }
    const before = await readFile(path);
    assert.throws(() => createArchive({ databasePath: path, token: 'test-token' }), /Unsupported SQLite archive schema/);
    assert.deepEqual(await readFile(path), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('restore preserves capture writes made while its recovery copy is being prepared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinkeep-restore-race-'));
  const src = archive(dir, 'source'), dst = archive(dir, 'target');
  try {
    src.upsertAccount({ accountId: 'replacement' });
    const sink = output();
    await streamBackup(src, sink.stream);
    for (const writer of ['capture', 'other-connection']) {
      const target = { ...dst, replaceSnapshot(path, stamp) {
        if (writer === 'capture') dst.upsertAccount({ accountId: writer });
        else {
          const other = archive(dir, 'target');
          try { other.upsertAccount({ accountId: writer }); } finally { other.db.close(); }
        }
        return dst.replaceSnapshot(path, stamp);
      } };
      await assert.rejects(restoreBackup(target, Readable.from(sink.bytes()), createArchive), err => err.status === 409);
      assert.ok(dst.accounts().some(row => row.accountId === writer));
      assert.ok(dst.accounts().every(row => row.accountId !== 'replacement'));
      assert.deepEqual(await readdir(join(dir, 'backups')), []);
    }
  } finally { src.db.close(); dst.db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('file uploads with oversized declared lengths are refused before consuming the body', async () => {
  const dst = createArchive({ databasePath: ':memory:', token: 'test-token' });
  try {
    for (const upload of [importPortable, restoreBackup]) {
      const req = new Readable({ read() { assert.fail('unexpected body read'); } });
      req.headers = { 'content-length': String(64 * 1024 ** 3 + 1) };
      await assert.rejects(upload(dst, req, createArchive), err => err.status === 413);
      req.destroy();
    }
  } finally { dst.db.close(); }
});

test('HTTP downloads require authentication or a one-use format-specific cookie', async () => {
  const dir=await mkdtemp(join(tmpdir(),'kinkeep-http-test-'));const src=archive(dir,'source'),dst=archive(dir,'target');
  function client(a) {
    const server=createHttpServer({archive:a,token:'secret'});
    return async (method,path,{token,cookie,type,body}={}) => {
      const req=Readable.from(body == null ? [] : [Buffer.isBuffer(body)?body:Buffer.from(body)]);
      Object.assign(req,{method,url:path,headers:{host:'127.0.0.1:8765',...(token?{authorization:`Bearer ${token}`}:{ }),...(cookie?{cookie}:{ }),...(type?{'content-type':type}:{ })}});
      const chunks=[]; const res=new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done()}});res.headers={};
      res.setHeader=(k,v)=>{res.headers[k]=v};res.writeHead=(status,headers)=>{res.status=status;Object.assign(res.headers,headers)};
      const finished=new Promise((resolve,reject)=>{res.on('finish',()=>resolve({status:res.status,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject)});
      server.emit('request',req,res);return finished;
    };
  }
  try {
    populate(src);const request=client(src),target=client(dst);
    async function whenReady(method,path,options) {
      for (let attempt=0;attempt<50;attempt++) {
        const response=await request(method,path,options);
        if (response.status!==409) return response;
        await delay(10);
      }
      throw new Error('Archive transfer did not finish cleanup');
    }
    assert.equal((await request('GET','/api/download/portable')).status,401);
    assert.equal((await request('POST','/api/download-ticket',{type:'application/json',body:'{"format":"portable"}'})).status,401);
    const ticket=await request('POST','/api/download-ticket',{token:'secret',type:'application/json',body:'{"format":"portable"}'});assert.equal(ticket.status,200);
    assert.match(ticket.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);const cookie=ticket.headers['Set-Cookie'].split(';')[0];
    const zipped=await request('GET','/api/download/portable',{cookie});assert.equal(zipped.status,200);assert.equal(zipped.headers['Content-Type'],'application/zip');
    assert.equal(zipped.headers['Content-Disposition'],'attachment; filename="kinkeep.zip"');
    assert.equal((await request('GET','/api/download/portable',{cookie})).status,401);
    assert.equal((await target('POST','/api/import/portable',{type:'application/zip',body:zipped.body})).status,401);
    assert.equal((await target('POST','/api/import/portable',{token:'secret',type:'application/zip',body:zipped.body})).status,200);
    assert.deepEqual(snapshot(dst),snapshot(src));
    const raw=await request('GET','/api/download/sqlite',{token:'secret'});assert.equal(raw.status,200);assert.equal(raw.body.subarray(0,16).toString('binary'),'SQLite format 3\u0000');
    assert.equal(raw.headers['Content-Disposition'],'attachment; filename="kinkeep-backup.sqlite3"');
    for (const [format, date, expected] of [
      ['sqlite','2026-11-17T02-45-31+01-00','kinkeep-backup-2026-11-17T02-45-31+01-00.sqlite3'],
      ['portable','2026-11-16T17-15-31-08-00','kinkeep-2026-11-16T17-15-31-08-00.zip'],
      ['sqlite','2026-11-17T01-45-31Z','kinkeep-backup-2026-11-17T01-45-31Z.sqlite3'],
    ]) {
      const issued=await whenReady('POST','/api/download-ticket',{token:'secret',type:'application/json',body:JSON.stringify({format,timestamp:date})});
      assert.equal(issued.status,200);
      const oneUse=issued.headers['Set-Cookie'].split(';')[0];
      const downloaded=await request('GET',`/api/download/${format}`,{cookie:oneUse});
      assert.equal(downloaded.status,200);
      assert.equal(downloaded.headers['Content-Disposition'],`attachment; filename="${expected}"`);
      assert.equal((await request('GET',`/api/download/${format}`,{cookie:oneUse})).status,401);
    }
    for (const date of [null, 123, '', '2026-11-17T02:45:31Z', '2026-11-17T02-45-31Z\r\nInjected: yes',
      '2026-02-30T02-45-31Z', '2026-11-17T24-45-31Z', '2026-11-17T02-45-31+15-00', '2026-11-17T02-45-31+14-30']) {
      const rejected=await request('POST','/api/download-ticket',{token:'secret',type:'application/json',body:JSON.stringify({format:'sqlite',timestamp:date})});
      assert.equal(rejected.status,400,`reject invalid timestamp ${JSON.stringify(date)}`);
      assert.equal(rejected.headers['Set-Cookie'],undefined);
    }
    const wrong=await whenReady('POST','/api/download-ticket',{token:'secret',type:'application/json',body:JSON.stringify({format:'portable',timestamp:'2026-11-17T01-45-31Z'})});
    const wrongCookie=wrong.headers['Set-Cookie'].split(';')[0];
    const bearer=await request('GET','/api/download/sqlite',{token:'secret',cookie:wrongCookie});
    assert.equal(bearer.status,200);
    assert.equal(bearer.headers['Content-Disposition'],'attachment; filename="kinkeep-backup.sqlite3"');
  } finally {src.db.close();dst.db.close();await rm(dir,{recursive:true,force:true})}
});
