import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const defaultOutput = join(root, 'dist', 'firefox');

export async function buildFirefox(output = defaultOutput) {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));

  // Firefox uses an event-page background and has no Chrome pageCapture API.
  // Keep the source manifest and unpacked Chromium extension unchanged.
  manifest.permissions = manifest.permissions.filter(permission => permission !== 'pageCapture');
  manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'https://kindroid.ai/*'])];
  manifest.background = { scripts: [manifest.background.service_worker], type: 'module' };
  manifest.browser_specific_settings = {
    gecko: {
      id: '{3ec545e5-3809-49e0-bc8d-a3b7f85d6ae7}',
      strict_min_version: '140.0',
      data_collection_permissions: {
        required: ['authenticationInfo', 'personallyIdentifyingInfo', 'personalCommunications', 'websiteContent'],
      },
    },
  };

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const include = entry.isFile() && /\.(?:js|html|css)$/.test(entry.name) ||
      entry.isDirectory() && ['icons', 'fonts'].includes(entry.name);
    if (include) await cp(join(source, entry.name), join(output, entry.name), { recursive: true });
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Firefox add-on built in ${await buildFirefox()}`);
}
