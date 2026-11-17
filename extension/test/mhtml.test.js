import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractImages } from '../mhtml.js';

const url = 'https://images.example.test/a.webp';
const sample = `MIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n boundary="abc123"\r\n\r\n--abc123\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Location: https://example.test/\r\n\r\nprivate page\r\n--abc123\r\nContent-Type: image/webp\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${url}\r\n\r\nQUJD\r\n--abc123--\r\n`;
test('extracts only explicitly requested image bodies', () => {
  assert.deepEqual([...extractImages(sample, [url])], [[url, { mime: 'image/webp', data: 'QUJD' }]]);
  assert.equal(extractImages(sample, ['https://example.test/']).size, 0);
});
test('does not accept bad encoding, unwanted MIME or conflicting copies', () => {
  assert.equal(extractImages(sample.replace('Content-Type: image/webp', 'Content-Type: image/svg+xml'), [url]).size, 0);
  assert.equal(extractImages(sample.replace('QUJD', 'not-base64'), [url]).size, 0);
  const duplicate = sample.replace('--abc123--', `--abc123\r\nContent-Type: image/webp\r\nContent-Transfer-Encoding: base64\r\nContent-Location: ${url}\r\n\r\nREVG\r\n--abc123--`);
  assert.equal(extractImages(duplicate, [url]).size, 0);
});
