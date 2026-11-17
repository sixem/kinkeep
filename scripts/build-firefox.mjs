import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const defaultOutput = join(root, 'dist', 'firefox');

export async function buildFirefox(output = defaultOutput, sourceDirectory = source) {
  const sourceRoot = await realpath(sourceDirectory);
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8'));

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

  // Only bundle known runtime resources, not arbitrary local files that happen
  // to be in the development directory. Add new imported assets here.
  const files = new Set([
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
    'popup.js', 'popup.css', 'common.js', 'mhtml.js',
    'fonts/InterVariable.woff2', 'fonts/INTER-LICENSE.txt',
  ]);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const file of files) {
    if (typeof file !== 'string' || !file) throw new Error('Invalid extension asset path');
    const input = resolve(sourceRoot, file), destination = resolve(output, file);
    if (!input.startsWith(sourceRoot + sep) || !destination.startsWith(resolve(output) + sep) ||
        !(await lstat(input)).isFile() || !(await realpath(input)).startsWith(sourceRoot + sep)) {
      throw new Error(`Invalid extension asset: ${file}`);
    }
    await mkdir(dirname(destination), { recursive: true });
    await cp(input, destination);
  }
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Firefox add-on built in ${await buildFirefox()}`);
}
