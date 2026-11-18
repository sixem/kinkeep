import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');

function firefoxManifest(manifest) {
  return {
    ...manifest,
    permissions: manifest.permissions.filter(permission => permission !== 'pageCapture'),
    host_permissions: [...new Set([...(manifest.host_permissions ?? []), 'https://kindroid.ai/*'])],
    background: { scripts: [manifest.background.service_worker], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: '{3ec545e5-3809-49e0-bc8d-a3b7f85d6ae7}',
        strict_min_version: '140.0',
        data_collection_permissions: {
          required: ['authenticationInfo', 'personallyIdentifyingInfo', 'personalCommunications', 'websiteContent'],
        },
      },
    },
  };
}

function runtimeFiles(manifest) {
  return new Set([
    ...(manifest.background.scripts ?? [manifest.background.service_worker]),
    ...manifest.content_scripts.flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
    manifest.action.default_popup,
    ...Object.values(manifest.action.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {}),
    'popup.js', 'popup.css', 'common.js', 'mhtml.js',
    'fonts/InterVariable.woff2', 'fonts/INTER-LICENSE.txt',
  ]);
}

async function replaceableOutput(output) {
  const info = await lstat(output).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) return false;
  const invalidOutput = new Error(`Expected an empty directory or a KinKeep build at ${output}`);
  if (!info.isDirectory()) throw invalidOutput;
  const entries = await readdir(output, { recursive: true, withFileTypes: true });
  if (!entries.length) return true;
  const manifestPath = join(output, 'manifest.json');
  if (!entries.some(entry => entry.isFile() && join(entry.parentPath, entry.name) === manifestPath)) throw invalidOutput;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!['KinKeep', 'KinExport'].includes(manifest.name)) throw invalidOutput;
  const files = runtimeFiles(manifest);
  files.add('manifest.json');
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const path = relative(output, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (!entry.isFile() || !files.has(path)) throw invalidOutput;
  }
  return true;
}

export async function buildExtension(browser, output, sourceDirectory = source) {
  if (!['chromium', 'firefox'].includes(browser)) throw new Error('Choose chromium or firefox.');
  const sourceRoot = await realpath(sourceDirectory);
  output = resolve(output ?? join(root, 'dist', browser));
  await mkdir(dirname(output), { recursive: true });
  const parent = await realpath(dirname(output));
  const target = join(parent, basename(output));
  if (sourceRoot === target || sourceRoot.startsWith(target + sep) || target.startsWith(sourceRoot + sep)) {
    throw new Error('Build output must be separate from the extension source.');
  }
  const existing = await replaceableOutput(target);
  const manifest = JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8'));
  const stage = await mkdtemp(join(parent, '.kinkeep-build-'));
  const next = join(stage, 'next');
  const previous = join(stage, 'previous');
  let movedPrevious = false;
  try {
    await mkdir(next);
    for (const file of runtimeFiles(manifest)) {
      if (typeof file !== 'string' || !file) throw new Error('Invalid extension asset path');
      const input = resolve(sourceRoot, file), destination = resolve(next, file);
      if (!input.startsWith(sourceRoot + sep) || !destination.startsWith(next + sep) ||
          !(await lstat(input)).isFile() || !(await realpath(input)).startsWith(sourceRoot + sep)) {
        throw new Error(`Invalid extension asset: ${file}`);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(input, destination);
    }
    const result = browser === 'firefox' ? firefoxManifest(manifest) : manifest;
    await writeFile(join(next, 'manifest.json'), JSON.stringify(result, null, 2) + '\n');
    if (existing) {
      await rename(target, previous);
      movedPrevious = true;
    }
    await rename(next, target);
    movedPrevious = false;
  } finally {
    if (movedPrevious) await rename(previous, target);
    await rm(stage, { recursive: true, force: true });
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Built extension in ${await buildExtension(process.argv[2])}`);
}
