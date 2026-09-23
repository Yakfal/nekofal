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
const version = require(path.join(root, 'package.json')).version;

// Publishing to GitHub is flaky on a freshly created tag: electron-builder's
// release creation can race the tag and fail with "Published releases must have
// a valid tag" (422) while still having uploaded part of the assets. The upload
// then picks up cleanly on retry (existing files are overwritten), so wrap the
// publish step in bounded exponential backoff instead of failing the whole run.
const PUBLISH_RETRIES = 3;
const PUBLISH_RETRY_DELAY_MS = 5000;

// electron-builder can also exit 0 while silently dropping one of the multipart
// uploads (a known flake: the .blockmap or latest.yml never lands but no error
// is raised). Since exit code 0 never triggered the backoff, such a missing
// asset shipped silently. Close that loophole by verifying the release actually
// holds every expected artifact after each publish attempt. Names are matched
// exactly (version-aware), so a setup installer missing from the release is
// caught even though plain '.exe' suffixes would overlap it.
const REQUIRED_ASSETS = (version) => [
  { label: 'portable exe', match: (name) => name === `Nekofal-${version}.exe` },
  { label: 'setup exe', match: (name) => name === `Nekofal-Setup-${version}.exe` },
  { label: 'blockmap', match: (name) => name === `Nekofal-Setup-${version}.exe.blockmap` },
  { label: 'latest.yml', match: (name) => name === 'latest.yml' }
];

async function verifyReleaseAssets(version) {
  const required = REQUIRED_ASSETS(version);
  const headers = {
    Authorization: `Bearer ${process.env.GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'nekofal-dist'
  };
  // Bounded read-retry: right after uploads finish a stale cache can briefly
  // under-report assets, which would otherwise cause a spurious backfill pass.
  let uploadedFiles = [];
  for (let read = 1; read <= 3; read++) {
    const res = await fetch(
      `https://api.github.com/repos/Yakfal/nekofal/releases/tags/v${version}`,
      { headers, signal: AbortSignal.timeout(30000) }
    );
    if (!res.ok) {
      throw new Error(`Failed to fetch release info: ${res.status} ${res.statusText}`);
    }
    const releaseData = await res.json();
    uploadedFiles = (releaseData.assets || []).map((a) => a.name);
    if (uploadedFiles.length >= required.length) break;
    if (read < 3) await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`[dist] Found ${uploadedFiles.length} uploaded assets on GitHub.`);
  const missing = required.filter((a) => !uploadedFiles.some(a.match)).map((a) => a.label);
  if (missing.length > 0) {
    throw new Error(`Incomplete release! Missing asset patterns: ${missing.join(', ')} (have: ${uploadedFiles.join(', ') || 'none'})`);
  }
  console.log('[dist] All required assets verified on GitHub Releases!');
}

// Pre-create and push the release tag (v<version> at HEAD) before building so
// GitHub already has a valid ref when electron-builder tries to publish.
function ensureReleaseTag() {
  const tag = `v${version}`;
  const check = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {
    cwd: root,
    encoding: 'utf8'
  });
  if (check.status === 0) {
    console.log(`[dist] release tag ${tag} already exists`);
    return true;
  }
  console.log(`[dist] creating + pushing release tag ${tag}…`);
  const create = spawnSync('git', ['tag', tag], { cwd: root, stdio: 'inherit' });
  if (create.status !== 0) return false;
  const push = spawnSync('git', ['push', 'origin', `refs/tags/${tag}`], { cwd: root, stdio: 'inherit' });
  return push.status === 0;
}

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

  if (publish && !ensureReleaseTag()) {
    console.error(`[dist] failed to create/push release tag v${version}; aborting`);
    process.exit(1);
  }

  console.log(`[dist] ${publish ? 'packaging + publishing to GitHub' : 'packaging (no publish)'}…`);
  const builderArgs = ['electron-builder', '--win'];
  if (publish) builderArgs.push('--publish', 'always');

  let buildCode = 1;
  let delayMs = PUBLISH_RETRY_DELAY_MS;
  for (let attempt = 1; attempt <= PUBLISH_RETRIES; attempt++) {
    const res = spawnSync('npx', builderArgs, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (res.error) {
      console.error('[dist] electron-builder failed to start:', res.error.message);
      process.exit(1);
    }
    buildCode = res.status == null ? 1 : res.status;
    if (buildCode === 0) {
      // electron-builder can exit 0 while silently dropping an uploaded asset
      // (e.g. the .blockmap). Verify the release actually holds every artifact
      // before accepting the attempt; a missing asset fails this pass so the
      // backoff retry re-runs the upload to backfill it. Only meaningful for
      // publishes — local builds have nothing to verify against.
      if (publish) {
        try {
          await verifyReleaseAssets(version);
        } catch (err) {
          console.warn(`[dist] publish attempt ${attempt}/${PUBLISH_RETRIES} left the release incomplete: ${err.message}`);
          buildCode = 2; // treat as a failed attempt → retry loop
        }
      }
    }
    if (buildCode === 0) break;
    if (attempt === PUBLISH_RETRIES) break;
    console.warn(`[dist] publish attempt ${attempt}/${PUBLISH_RETRIES} failed (exit ${buildCode}); ` +
                 'retrying to finish tag/asset propagation…');
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs *= 2;
  }
  if (publish && buildCode !== 0) {
    console.error(`[dist] all ${PUBLISH_RETRIES} publish attempts failed; ` +
                  'the release may still be partially uploaded — re-run npm run dist:publish to finish.');
    process.exit(buildCode);
  }
  if (!publish && buildCode !== 0) process.exit(buildCode);

  // Regenerate the winget manifest from the freshly built installer.
  const winget = spawnSync('node', [path.join(__dirname, 'generate-winget.js')], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  let status = winget.status == null ? 1 : winget.status;

  if (publish && status === 0) {
    try {
      await annotateReleaseBody(version);
    } catch (e) {
      console.error('[dist] failed to annotate release body:', e.message);
      status = 1;
    }
  }
  process.exit(status);
})();