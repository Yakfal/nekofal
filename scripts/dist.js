/* Nekofal dist/publish helper.
   Loads secrets (GH_TOKEN, …) from the local, gitignored .env file so
   credentials are never hard-coded into scripts or shell history, then builds
   the renderer and packages with electron-builder.
   Pass --publish to upload the release to GitHub (the auto-update feed). */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

// Minimal .env loader (no dependency): KEY=value lines, # comments, optional quotes.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

if (!process.env.GH_TOKEN) {
  console.error('GH_TOKEN missing. Create a .env file (see .env.example) with GH_TOKEN set, or export it.');
  process.exit(1);
}

const publish = process.argv.includes('--publish');

console.log('[dist] building renderer…');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

console.log(`[dist] ${publish ? 'packaging + publishing to GitHub' : 'packaging (no publish)'}…`);
const builderArgs = ['electron-builder', '--win'];
if (publish) builderArgs.push('--publish', 'always');
const res = spawnSync('npx', builderArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});
if (res.error) {
  console.error('[dist] electron-builder failed to start:', res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);