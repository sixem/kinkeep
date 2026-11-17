import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const [project, server, serverLock, extension, manifest] = await Promise.all([
  'package.json', 'server/package.json', 'server/package-lock.json',
  'extension/package.json', 'extension/manifest.json',
].map(readJson));

const versions = {
  project: project.version,
  server: server.version,
  'server lockfile top-level': serverLock.version,
  'server lockfile': serverLock.packages?.['']?.version,
  extension: extension.version,
  'extension manifest': manifest.version,
};
for (const [name, version] of Object.entries(versions)) {
  if (version !== project.version) throw new Error(`${name} version ${version} does not match project version ${project.version}`);
}
if (typeof project.version !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(project.version) || project.version.split('.').some(part => Number(part) > 65535)) {
  throw new Error('Project version must be valid for a Chromium extension');
}
if (manifest.manifest_version !== 3) throw new Error('Extension must use Manifest V3');

const extensionRoot = resolve(root, 'extension');
const extensionFiles = [manifest.background?.service_worker, manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon ?? {}), ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap(script => [...(script.js ?? []), ...(script.css ?? [])]),
];
for (const path of new Set(extensionFiles)) {
  if (typeof path !== 'string' || !path) throw new Error('Extension manifest has an empty required file path');
  const target = resolve(extensionRoot, path);
  if (!target.startsWith(extensionRoot + sep)) throw new Error(`Extension file is outside its directory: ${path}`);
  try { if (!(await stat(target)).isFile()) throw new Error(); } catch { throw new Error(`Extension manifest references a missing file: ${path}`); }
}

const dashboard = await readFile(resolve(root, 'server/public/index.html'), 'utf8');
if (!dashboard.includes(`Version ${project.version}`)) throw new Error('Dashboard welcome version does not match project version');
console.log(`KinExport ${project.version}: versions and extension manifest files verified.`);
