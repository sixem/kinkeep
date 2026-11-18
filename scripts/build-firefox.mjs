import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build-extension.mjs';

export const buildFirefox = (output, source) => buildExtension('firefox', output, source);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Firefox add-on built in ${await buildFirefox()}`);
}
