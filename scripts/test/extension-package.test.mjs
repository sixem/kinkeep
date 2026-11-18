import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExtension } from '../build-extension.mjs';
import { buildFirefox } from '../build-firefox.mjs';

test('Firefox package contains its runtime files and browser-compatible permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinexport-firefox-test-'));
  try {
    const output = join(dir, 'extension');
    const chromiumPath = new URL('../../extension/manifest.json', import.meta.url);
    const chromium = await readFile(chromiumPath, 'utf8');
    await buildFirefox(output);
    assert.equal(await readFile(chromiumPath, 'utf8'), chromium);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, JSON.parse(chromium).version);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.permissions.includes('pageCapture'), false);
    assert.ok(manifest.host_permissions.includes('https://kindroid.ai/*'));
    assert.deepEqual(manifest.background, { scripts: ['background.js'], type: 'module' });
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '140.0');
    const data = manifest.browser_specific_settings.gecko.data_collection_permissions.required;
    for (const category of ['authenticationInfo', 'personallyIdentifyingInfo', 'personalCommunications', 'websiteContent']) assert.ok(data.includes(category));
    for (const file of [manifest.background.scripts[0], manifest.action.default_popup, 'popup.js', 'popup.css', 'common.js', 'mhtml.js', 'fonts/InterVariable.woff2',
      ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(script => script.js)]) {
      assert.ok((await stat(join(output, file))).isFile(), `${file} must be present`);
    }
    await assert.rejects(stat(join(output, 'test')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('browser builds exclude development files and preserve the previous package on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kinexport-firefox-private-test-'));
  try {
    const input = join(dir, 'source'), output = join(dir, 'extension');
    await cp(new URL('../../extension/', import.meta.url), input, { recursive: true });
    await writeFile(join(input, 'local-debug.js'), 'synthetic private scratch data');
    await writeFile(join(input, 'icons', 'local-private.png'), 'synthetic private image');
    await writeFile(join(input, 'fonts', 'local-private.txt'), 'synthetic private notes');
    for (const browser of ['chromium', 'firefox']) {
      await buildExtension(browser, output, input);
      const built = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
      if (browser === 'chromium') {
        assert.deepEqual(built, JSON.parse(await readFile(join(input, 'manifest.json'), 'utf8')));
      }
      for (const file of ['test', 'package.json', 'local-debug.js', 'icons/local-private.png', 'fonts/local-private.txt']) {
        await assert.rejects(stat(join(output, file)), { code: 'ENOENT' });
      }
    }
    const priorScript = await readFile(join(output, 'background.js'));
    await rm(join(input, 'background.js'));
    await assert.rejects(buildExtension('firefox', output, input), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(output, 'background.js')), priorScript);
    await assert.rejects(buildExtension('chromium', input, input), /separate/);
    await writeFile(join(output, 'notes.txt'), 'keep this file');
    await assert.rejects(buildExtension('firefox', output, input), /empty directory/);
    assert.equal(await readFile(join(output, 'notes.txt'), 'utf8'), 'keep this file');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
