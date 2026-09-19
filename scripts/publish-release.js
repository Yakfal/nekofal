/* publish-release.js

   Promotes every draft GitHub release on Yakfal/nekofal to a published
   (public) release, immediately.

   Why it exists:
     electron-builder's github provider defaults publish.github.releaseType to
     "draft", so `npm run dist:publish` creates *draft* releases that auto-
     update never sees. This script is appended to the dist:publish lifecycle
     and flips any leftover drafts (e.g. v1.0.23 / v1.0.24) to public in one
     passathe safe belt-and-suspenders following electron-builder itself.

   Auth: GH_TOKEN or GITHUB_TOKEN (loaded from the gitignored .env file, same
   loader as dist.js, or from process.env).

   Usage: node scripts/publish-release.js
*/
const fs = require('fs');
const path = require('path');

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

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('[publish-release] Missing GH_TOKEN / GITHUB_TOKEN. Add it to .env or export it.');
  process.exit(1);
}

const OWNER = 'Yakfal';
const REPO = 'nekofal';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/releases';
const headers = {
  Authorization: 'Bearer ' + token,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nekofal-publish-release',
};

(async () => {
  const list = await fetch(API + '?per_page=100', {
    headers,
    signal: AbortSignal.timeout(30000),
  }).then((r) => r.json());

  const releases = Array.isArray(list) ? list : [];
  const drafts = releases.filter((r) => r.draft === true && r.tag_name);

  if (drafts.length === 0) {
    console.log('[publish-release] No draft releases found - repo is fully published.');
    process.exit(0);
  }

  console.log('[publish-release] Found ' + drafts.length + ' draft(s):');
  for (const d of drafts) console.log('  - ' + d.tag_name + ' (id=' + d.id + ')');

  let failed = 0;
  for (const d of drafts) {
    try {
      const patched = await fetch(API + '/' + d.id, {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ draft: false }),
        signal: AbortSignal.timeout(30000),
      }).then((r) => r.json());
      const ok = patched && patched.id ? patched.draft === false : false;
      if (ok) console.log('  [ok] ' + d.tag_name + ' -> published (draft=' + patched.draft + ')');
      else { failed++; console.error('  [ERR] ' + d.tag_name + ': ' + JSON.stringify(patched)); }
    } catch (e) {
      failed++;
      console.error('  [ERR] ' + d.tag_name + ': ' + e.message);
    }
  }

  if (failed) { console.error('[publish-release] ' + failed + ' release(s) failed to publish.'); process.exit(1); }
  console.log('[publish-release] All draft releases are now public.');
  process.exit(0);
})();
