import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { createArchive, createHttpServer, readJson } from '../server.js';

test('oversized chunked JSON is rejected before the sender finishes', async () => {
  const input = new PassThrough();
  input.headers = {};
  const parsed = readJson(input, 8);
  input.write(Buffer.from('{"data":'));
  input.write(Buffer.from('"too long"'));
  await assert.rejects(parsed, err => err.status === 413);
  assert.equal(input.readableEnded, false);
  input.end();
});

test('declared oversized JSON gets an immediate 413 and closes the HTTP connection', async () => {
  const archive = createArchive({ databasePath: ':memory:', token: 'synthetic-token' });
  const server = createHttpServer({ archive, token: 'synthetic-token' });
  const req = new PassThrough();
  Object.assign(req, { url: '/api/accounts', method: 'POST', headers: { host: '127.0.0.1:8765',
    authorization: 'Bearer synthetic-token', 'content-type': 'application/json', 'content-length': String(128 * 1024 * 1024 + 1) } });
  try {
    const result = await new Promise(resolve => {
      const res = { headers: {}, setHeader(key, value) { this.headers[key] = value; },
        writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
        end() { resolve({ status: this.status, connection: this.headers.Connection, keepAlive: this.shouldKeepAlive }); } };
      // Do not send or end the body: the declared length alone must be enough.
      server.emit('request', req, res);
    });
    assert.equal(result.status, 413);
    assert.equal(result.connection, 'close');
    assert.equal(result.keepAlive, false);
    assert.equal(req.readableEnded, false);
  } finally { req.destroy(); archive.db.close(); }
});

test('an actual HTTP client receives 413 without sending the declared oversized body', async t => {
  const archive = createArchive({ databasePath: ':memory:', token: 'synthetic-token' });
  const server = createHttpServer({ archive, token: 'synthetic-token' });
  let listening = false;
  try {
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      listening = true;
    } catch (err) {
      // Some restricted build sandboxes prohibit all listening sockets.
      if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip('Loopback listening is not permitted'); return; }
      throw err;
    }
    const result = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/accounts', method: 'POST',
        headers: { authorization: 'Bearer synthetic-token', 'content-type': 'application/json', 'content-length': String(128 * 1024 * 1024 + 1) } }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Server waited for oversized request body')));
      req.flushHeaders();
    });
    assert.equal(result.status, 413);
    assert.equal(result.connection, 'close');
  } finally {
    if (listening) await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    archive.db.close();
  }
});
