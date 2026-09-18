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

// Friendly first-run note appended to GitHub release bodies (SmartScreen guidance).
const INSTALL_NOTE =
  '> ℹ️ **First-Time Windows Setup**: Click **"More Info"** → **"Run Anyway"** if SmartScreen appears on fresh builds while community download reputation builds.';

async function annotateReleaseBody(version) {
  const tag = `v${version}`;
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nekofal-dist'
  };
  const list = await fetch(
    `https://api.github.com/repos/Yakfal/nekofal/releases?per_page=100`,
    { headers, signal: AbortSignal.timeout(30000) }
  ).then((r) => r.json());
  const release = (Array.isArray(list) ? list : []).find(
    (r) => r.tag_name === tag && r.draft === true
  );
  if (!release) {
    console.warn(`[dist] no draft release found for ${tag}; skipping body note`);
    return;
  }
  const body = release.body || '';
  if (body.includes('First-Time Windows Setup')) {
    console.log(`[dist] release note already present on ${tag} body`);
    return;
  }
  const patched = await fetch(release.url, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `${INSTALL_NOTE}\n\n${body}` }),
    signal: AbortSignal.timeout(30000)
  }).then((r) => r.json());
  console.log(`[dist] release note appended to ${tag} body (id=${patched.id || release.id})`);
}

(async () => {
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
  const buildCode = res.status == null ? 1 : res.status;
  if (buildCode !== 0) process.exit(buildCode);

  // Regenerate the winget manifest from the freshly built installer.
  const winget = spawnSync('node', [path.join(__dirname, 'generate-winget.js')], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  let status = winget.status == null ? 1 : winget.status;

  if (publish && status === 0) {
    try {
      await annotateReleaseBody(require(path.join(root, 'package.json')).version);
    } catch (e) {
      console.error('[dist] failed to annotate release body:', e.message);
      status = 1;
    }
  }
  process.exit(status);
})();