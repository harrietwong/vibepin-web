// Patches os.hostname() before Vercel CLI loads, to avoid non-ASCII header error
import { createRequire } from 'module';
import os from 'os';
os.hostname = () => 'vibepin-deploy';
const require = createRequire(import.meta.url);
// Run vercel via child_process so the patch applies to subprocess too
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vercelBin = path.join(__dirname, 'node_modules', '.bin', 'vercel');
// Args passed to this script minus the node/script itself
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [
  '--require', fileURLToPath(import.meta.url).replace('.mjs', '-patch.cjs'),
  vercelBin, ...args
], { stdio: 'inherit', env: { ...process.env, COMPUTERNAME: 'vibepin-deploy' } });
process.exit(result.status ?? 0);
