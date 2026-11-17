import { spawn } from 'node:child_process';

// Decode locally and keep thumbnail work bounded. Original files are untouched.
export function createThumbnail(bytes) {
  // Select a permitted decoder explicitly instead of letting ImageMagick
  // autodetect arbitrary input formats.
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const format = input.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'png' :
    input[0] === 255 && input[1] === 216 && input[2] === 255 ? 'jpeg' :
    input.subarray(0, 4).toString() === 'RIFF' && input.subarray(8, 12).toString() === 'WEBP' ? 'webp' : null;
  if (!format) return Promise.reject(new Error('Unsupported image'));
  return new Promise((resolve, reject) => {
    const child = spawn('magick', ['-limit','memory','128MiB','-limit','map','256MiB','-limit','disk','0','-limit','thread','2','-limit','time','10',`${format}:-`,'-auto-orient','-thumbnail','384x384^','-gravity','center','-extent','384x384','-strip','-quality','78','webp:-'], { stdio: ['pipe','pipe','ignore'] });
    const parts = []; let size = 0, done = false;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Thumbnail generation timed out')); }, 15000);
    child.on('error', () => finish(new Error('Thumbnail generation unavailable')));
    child.stdout.on('data', part => { size += part.length; if (size > 2 * 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Thumbnail too large')); } else parts.push(part); });
    child.stdout.on('error', () => { child.kill('SIGKILL'); finish(new Error('Thumbnail generation failed')); });
    child.stdin.on('error', () => {});
    child.on('close', code => { if (code !== 0 || !size) return finish(new Error('Thumbnail generation failed')); finish(null, Buffer.concat(parts)); });
    child.stdin.end(input);
  });
}
