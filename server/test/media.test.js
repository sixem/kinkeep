import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../server.js';
const create = () => createArchive({ databasePath: ':memory:', token: 'test-token' });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
const scope = { accountId: 'a', kinId: 'k' };
const item = { sourceId: 'selfie-1', kind: 'selfie', variant: 'preview', createdAt: '2026-01-01T12:00:00.000Z', prompt: 'sample prompt', messageId: 'message-1', mime: 'image/png', data: png };
function setup(a) { a.upsertAccount({accountId:'a'}); a.upsertKin(scope); }
test('scoped image storage deduplicates files and retains portable metadata', () => {
  const a=create(),b=create(); try { setup(a);
    assert.deepEqual(a.media.save(scope,[item]),{inserted:1,unchanged:0});
    assert.deepEqual(a.media.save(scope,[item]),{inserted:0,unchanged:1});
    const page=a.media.list(scope); assert.equal(page.total,1); assert.equal(page.items[0].variant,'preview');
    assert.equal(a.media.blob(page.items[0].sha256).bytes.toString('base64'),png);
    assert.throws(()=>a.exportArchive(4),/cannot represent media/);
    const snapshot=a.exportArchive(); assert.equal(snapshot.version,5); assert.equal(snapshot.media.blobs.length,1);
    b.importArchive(snapshot); b.importArchive(snapshot); assert.deepEqual(b.media.exportData(),snapshot.media);
    const bad=structuredClone(snapshot);bad.media.blobs[0].data=Buffer.from('bad').toString('base64');
    assert.throws(()=>b.importArchive(bad),/Invalid|Unsupported|digest/);assert.equal(b.media.list(scope).total,1);
  } finally {a.db.close();b.db.close();}
});
test('rejects unsupported images and does not mix scopes',()=>{ const a=create();try{setup(a);a.upsertKin({accountId:'a',kinId:'other'});
  assert.throws(()=>a.media.save(scope,[{...item,mime:'image/jpeg'}]),/Unsupported/);
  assert.throws(()=>a.media.save(scope,[{...item,createdAt:null}]),/Invalid/);
  assert.equal(a.media.save(scope,[item]).inserted,1);assert.equal(a.media.list({accountId:'a',kinId:'other'}).total,0);
}finally{a.db.close()}});

test('images are listed most recent first, with stable ordering for equal dates', () => {
  const a=create();try {setup(a);
    a.media.save(scope,[{...item,sourceId:'older',createdAt:'2025-01-01T00:00:00.000Z'},{...item,sourceId:'newer-b'},{...item,sourceId:'newer-a'}]);
    assert.deepEqual(a.media.list(scope).items.map(x=>x.sourceId),['newer-a','newer-b','older']);
    assert.deepEqual(a.media.list(scope,1,1).items.map(x=>x.sourceId),['newer-b']);
  }finally{a.db.close()}
});

test('thumbnail generation is cached and keeps the original export intact', async () => {
  const a=create(); try { setup(a);
    const data='iVBORw0KGgoAAAANSUhEUgAAABQAAAAeAQMAAAAW3KwoAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURQAA/////3vcmSwAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gsQEg0c4s+h1gAAAAxJREFUCNdjYBgYAAAAeAAB2u2iVwAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0xMS0xNlQxODoxMzoyOCswMDowMISgOgkAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMTEtMTZUMTg6MTM6MjgrMDA6MDD1/YK1AAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTExLTE2VDE4OjEzOjI4KzAwOjAwouijagAAAABJRU5ErkJggg==';
    a.media.save(scope,[{...item,data}]);const sha=a.media.list(scope).items[0].sha256;
    const [one,two]=await Promise.all([a.media.thumbnail(sha),a.media.thumbnail(sha)]);
    assert.equal(one.mime,'image/webp');assert.equal(one.bytes.subarray(8,12).toString(),'WEBP');assert.deepEqual(one.bytes,two.bytes);
    assert.equal(one.bytes.subarray(12,16).toString(), 'VP8 ');
    assert.equal(one.bytes.readUInt16LE(26) & 0x3fff, 384);
    assert.equal(one.bytes.readUInt16LE(28) & 0x3fff, 384);
    assert.equal(a.db.prepare('SELECT count(*) AS n FROM media_thumbnails').get().n,1);
    assert.equal(a.media.blob(sha).bytes.toString('base64'),data);
    assert.equal(a.media.exportData().blobs[0].data,data);
  } finally { a.db.close(); }
});
