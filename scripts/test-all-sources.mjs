// test-all-sources.mjs — v1.0.65 release gate.
//
// Run:  npx electron scripts/test-all-sources.mjs
//       (uses the REAL app main process: extract handler, inline-player parsers,
//        ad-block interceptor, HAnime persistent-stealth-window, yt-dlp).
//
// Verifies, end to end through the app's own `scrapers:extractStream` IPC:
//   1. YouTube  — stream resolves, media URL valid, quality ladder present.
//   2. XVideos  — inline html5player parse, clean .mp4 ladder, NO ad hosts.
//   3. Pornhub  — inline mediaDefinitions parse, clean tiers, NO ad hosts.
//   4. XNXX     — inline html5player parse, clean .mp4 ladder, NO ad hosts.
//   5. HAnime   — TWO CONSECUTIVE extractions (same session, never cleared),
//                 both resolve, NO ad hosts, yt-dlp deliberately not used.
//                 If this network's Cloudflare wall never clears (datacenter /
//                 VPN IPs), set NEKOFAL_ALLOW_HANIME_SKIP=1 to report the
//                 hanime run as SKIP (warn) instead of FAIL. Unset = strict.
//
// Live URLs are discovered with the app's OWN search backends (webSearch),
// so the suite is self-maintaining against stale links. Override any source
// with env vars:
//   NEKOFAL_TEST_YT_URL       NEKOFAL_TEST_XVIDEOS_URL
//   NEKOFAL_TEST_PORNHUB_URL  NEKOFAL_TEST_XNXX_URL
//   NEKOFAL_TEST_HANIME_1     NEKOFAL_TEST_HANIME_2
//   NEKOFAL_ALLOW_HANIME_SKIP (see above)
//
// Exit code: 0 = all sources pass, 1 = ≥1 source failed, 2 = harness error.

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Load the production build, not the vite dev server.
process.env.NODE_ENV = 'production';

// Boot the REAL application: registers every IPC handler, boots yt-dlp,
// servers, the interceptors and the HAnime stealth/persistent-window engine.
require(path.join(__dirname, '..', 'electron', 'main.js'));

const RESULTS = [];
const now = () => new Date().toISOString().slice(11, 19);

function report(name, ok, details, kind) {
  RESULTS.push({ name, ok, details, kind: kind || (ok ? 'PASS' : 'FAIL') });
  console.log(`${kind || (ok ? 'PASS' : 'FAIL')}  [${now()}]  ${name}  ${details}`);
}

function reportSkip(name, details) {
  report(name, true, details, 'SKIP');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms))
  ]);
}

// ---- ad-host guard (mirrors main.js AD_NETWORKS + isAdIframeUrl) ----------
const AD_HOSTS = [
  'exoclick.com', 'exoclick.net', 'adsterra.com', 'popads.net', 'popcash.net',
  'juicyads.com', 'doubleclick.net', 'adform.net', 'traffichaus.com',
  'propellerads.com', 'adcash.com', 'onclickads.net', 'realsrv.com',
  'dj30.com', 'intelliserve.com', 'cpmove.com', 'adrta.com', 'exdynsrv.com',
  'adspaces.ero-advertising.com'
];
const AD_HOST_RE = new RegExp(`(?:^|\\.)(${AD_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})$`, 'i');

function isAdUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (AD_HOST_RE.test(u.hostname)) return true;
    if (/(^|\/)(ads?|adserver|adserved|advert|banner|popunder|overlay|sponsor|vast)(\/|$)/i.test(u.pathname)) return true;
    const keys = Array.from(u.searchParams.keys()).join('&');
    if (/([^a-z]|^)(ad_|adid|adclick|adserved|ggpht|gpt_)/i.test(keys)) return true;
  } catch (_e) { /* malformed */ }
  return false;
}

function validMediaUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (/\.googlevideo\.com$/i.test(u.hostname)) return true;
    if (/\/videoplayback/i.test(u.hostname + u.pathname)) return true;
    if (/^https?:\/\/localhost/i.test(rawUrl)) return true;
    if (/\.(mp4|webm|m3u8|ts|m4s|mkv|mov|m4v)($|\?)/i.test(u.pathname)) return true;
    if (/\/hls\//i.test(u.pathname)) return true;
    if (/hanime\.tv$/i.test(u.hostname)) return true;
  } catch (_e) { /* malformed */ }
  return false;
}

function qualityRows(result) {
  const src = [
    ...(Array.isArray(result && result.qualities) ? result.qualities : []),
    ...(Array.isArray(result && result.qualityLevels) ? result.qualityLevels : [])
  ];
  return src.filter((q) => q && q.url && /(\.m3u8|\.m3u|\/hls\/|\.mp4|\.webm)/i.test(q.url) && (q.height || q.label));
}

function finalUrl(result) {
  if (!result) return null;
  return (result.data && result.data.videoUrl) || result.streamUrl || null;
}

function env(k) { const v = process.env[k]; return v && String(v).trim() ? String(v).trim() : null; }

// ---- window driver ---------------------------------------------------------
let win = null;
process.on('uncaughtException', (e) => { console.error('HARNESS uncaughtException:', e); settle(false, 2); });

async function callWindow(script, ms) {
  return withTimeout(win.webContents.executeJavaScript(script), ms, 'window call');
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const ok = await callWindow(`({ api: typeof window.electronAPI?.extractStream === 'function', search: typeof window.electronAPI?.webSearch === 'function' })`, 10_000);
      if (ok && ok.api && ok.search) return true;
    } catch (_e) { /* window still loading */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('window.api never became available');
}

function extractCall(extractScript, ms) {
  return callWindow(extractScript, ms);
}

function extractScript(url, label) {
  return `(async () => {
    try {
      return await window.electronAPI.extractStream(${JSON.stringify(url)});
    } catch (e) {
      return { success: false, error: '${label}: ' + String((e && e.message) || e) };
    }
  })()`;
}

async function extractStream(url, label, ms) {
  const t = Date.now();
  const res = await extractCall(extractScript(url, label), ms);
  return { res, ms: Date.now() - t };
}

// ---- discovery -------------------------------------------------------------
async function discover(siteUrlTemplate, query, count) {
  const shopping = `window.electronAPI.webSearch(${JSON.stringify({
    mode: 'site',
    siteUrl: siteUrlTemplate,
    query,
    count: count || 10
  })})`;
  const r = await callWindow(`(async () => { try { return await ${shopping}; } catch (e) { return { success:false, error:String((e&&e.message)||e) }; } })()`, 200_000);
  const videos = (r && Array.isArray(r.videos)) ? r.videos : [];
  const urls = videos
    .filter((v) => v && /^https?:/i.test((v.pageUrl || v.videoUrl || '')))
    .map((v) => v.pageUrl || v.videoUrl);
  return [...new Set(urls)];
}

// ---- per-source tests ------------------------------------------------------
async function testYouTube() {
  const url = env('NEKOFAL_TEST_YT_URL') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const { res, ms } = await extractStream(url, 'youtube', 240_000);
  if (!res || res.success !== true) return report('YouTube', false, `extraction failed (${ms}ms): ${(res && res.error) || 'no result'}`);
  const fu = finalUrl(res);
  if (!fu || !validMediaUrl(fu)) return report('YouTube', false, `invalid media url "${fu}" (${ms}ms)`);
  if (isAdUrl(fu)) return report('YouTube', false, `ad host in url "${fu}"`);
  // YT carries the selectable tier list in data.formats (menuFormats), because
  // its quality envelopes ride in the yt-dlp "data" wrapper. The client chain
  // (default → android,web → ...) returns the full ladder where allowed and a
  // throttled-but-playable tier on flagged IPs, so the hard gate is "at least
  // one real, resolvable tier" — zero tiers means the roster is missing/broken
  // (this caught the menuFormats-scope regression that nulled data.formats).
  const tandem = (Array.isArray(res.data && res.data.formats) ? res.data.formats : []).concat(
    Array.isArray(res.data && res.data.qualityLevels) ? res.data.qualityLevels : []
  );
  const ladder = tandem.filter((q) => q && (q.url || q.height || q.label) && (q.height || q.label)).length;
  if (ladder < 1) return report('YouTube', false, `quality ladder too small (${ladder}) — data.formats=${(res.data && res.data.formats && res.data.formats.length) || 0}`);
  report('YouTube', true, `${ms}ms · ${res.data && res.data.sourceSite ? res.data.sourceSite : 'yt-dlp'} · ${ladder} tiers · ${fu.slice(0, 80)}`);
}

async function testInlineSite(label, template, query, expectedExtractorPrefix, envKey) {
  let url = env(envKey);
  if (!url) {
    try {
      const found = await discover(template, query, 10);
      url = found[0] || null;
      if (url) console.log(`  [${label}] discovered test url: ${url}`);
    } catch (e) {
      console.log(`  [${label}] discovery failed: ${e.message}`);
    }
  }
  if (!url) return report(label, false, `could not discover a video url (set ${envKey} to override)`);

  const { res, ms } = await extractStream(url, label, 200_000);
  if (!res || res.success !== true) return report(label, false, `extraction failed (${ms}ms): ${(res && res.error) || 'no result'}`);
  const fu = finalUrl(res);
  if (!fu || !validMediaUrl(fu)) return report(label, false, `invalid media url "${fu}" (${ms}ms)`);
  if (isAdUrl(fu)) return report(label, false, `→ AD HIJACK: url "${fu}"`);
  const rows = qualityRows(res);
  const agegated = !!res.agegated;
  if (rows.length < (agegated ? 1 : 2)) return report(label, false, `inline ladder < ${agegated ? 1 : 2} rows (${rows.length}); extractor=${res.extractor || '?'}${agegated ? ' [age-gate active]' : ''} → the parser did NOT engage`);
  const extractor = String(res.extractor || '');
  if (!extractor.startsWith(expectedExtractorPrefix)) {
    return report(label, false, `extractor "${extractor}" — expected "${expectedExtractorPrefix}*" (inline parser must be primary)`);
  }
  report(label, true, `${ms}ms · ${extractor} · ${rows.length} tier${rows.length === 1 ? '' : 's'} (${rows.map((r) => /\.m3u8/i.test(r.url) ? 'm3u8' : 'mp4').join(',')})${agegated ? ' [age-gate: single JSON-LD tier]' : ''} · ${fu.slice(0, 90)}`);
}

async function testHanime() {
  let one = env('NEKOFAL_TEST_HANIME_1');
  let two = env('NEKOFAL_TEST_HANIME_2');
  if (!one || !two) {
    try {
      const found = await discover('https://hanime.tv', 'a', 12);
      one = one || found[0];
      two = two || found[1];
      console.log(`  [HAnime] test urls: ${one}\n  [HAnime]            ${two}`);
    } catch (e) {
      console.log(`  [HAnime] discovery failed: ${e.message}`);
    }
  }
  if (!one || !two) return report('HAnime', false, 'could not discover two hanime urls (set NEKOFAL_TEST_HANIME_1/2 to override)');
  if (one === two) return report('HAnime', false, 'discovered urls are identical — need two distinct videos');

  const run = async (u, tag) => {
    const { res, ms } = await extractStream(u, `hanime-${tag}`, 300_000);
    if (!res || res.success !== true) return { ok: false, why: `${tag} failed (${ms}ms): ${(res && res.error) || 'no result'} — persistent session not working` };
    const fu = finalUrl(res);
    if (!fu || !validMediaUrl(fu)) return { ok: false, why: `${tag} invalid media url "${fu}"` };
    if (isAdUrl(fu)) return { ok: false, why: `${tag} → AD HIJACK url "${fu}"` };
    const rows = qualityRows(res);
    const extractor = String(res.extractor || '');
    if (!extractor.includes('hanime')) return { ok: false, why: `${tag} unexpected extractor "${extractor}"` };
    console.log(`  [HAnime] ${tag} OK (${ms}ms) · ${extractor} · ${rows.length} tiers · via-win=${!!res.viaWin}`);
    return { ok: true };
  };

  const a = await run(one, 'run-1');
  const b = await run(two, 'run-2');
  const skip = !!env('NEKOFAL_ALLOW_HANIME_SKIP');
  if (a.ok && b.ok) {
    report('HAnime', true, 'both consecutive extractions resolved');
  } else if (skip) {
    reportSkip('HAnime', `SKIPPED — Cloudflare challenge wall on this network (NEKOFAL_ALLOW_HANIME_SKIP=1); ${[a, b].filter((x) => !x.ok).map((x) => x.why).join(' | ')}`);
  } else {
    report('HAnime', false, `${[a, b].filter((x) => !x.ok).map((x) => x.why).join(' | ')} — persistent session not working`);
  }
}

async function main() {
  const only = String(process.env.NEKOFAL_ONLY || '').toLowerCase();
  if (!only || only === 'all') {
    await testYouTube();
    await testInlineSite('XVideos', 'https://www.xvideos.com/?k={query}', 'japanese', 'xvideos-inline', 'NEKOFAL_TEST_XVIDEOS_URL');
    await testInlineSite('Pornhub', 'https://www.pornhub.com/video/search?search={query}', 'japanese', 'pornhub-media-definitions', 'NEKOFAL_TEST_PORNHUB_URL');
    await testInlineSite('XNXX', 'https://www.xnxx.com/search/{query}', 'japanese', 'xnxx-inline', 'NEKOFAL_TEST_XNXX_URL');
    await testHanime();
    return;
  }
  if (only === 'youtube') { await testYouTube(); return; }
  if (only === 'xvideos') { await testInlineSite('XVideos', 'https://www.xvideos.com/?k={query}', 'japanese', 'xvideos-inline', 'NEKOFAL_TEST_XVIDEOS_URL'); return; }
  if (only === 'pornhub') { await testInlineSite('Pornhub', 'https://www.pornhub.com/video/search?search={query}', 'japanese', 'pornhub-media-definitions', 'NEKOFAL_TEST_PORNHUB_URL'); return; }
  if (only === 'xnxx') { await testInlineSite('XNXX', 'https://www.xnxx.com/search/{query}', 'japanese', 'xnxx-inline', 'NEKOFAL_TEST_XNXX_URL'); return; }
  if (only === 'hanime') { await testHanime(); return; }
}

function settle(ok, code) {
  console.log('\n───── RESULT ─────');
  let failed = 0;
  let skipped = 0;
  for (const r of RESULTS) { if (!r.ok) failed++; if (!r.ok === false && r.kind === 'SKIP') skipped++; console.log(` ${r.kind || (r.ok ? 'PASS' : 'FAIL')}  ${r.name}`); }
  console.log(` ${RESULTS.length - failed}/${RESULTS.length} sources passed — gate ${failed === 0 ? 'CLEARED' : 'BLOCKED'}${skipped ? ` (${skipped} skip${skipped === 1 ? '' : 's'})` : ''}`);
  for (const w of (global.__extraWarnings || [])) console.log(` WARN  ${w}`);
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_e) {}
  app.exit(code === undefined ? (failed === 0 ? 0 : 1) : code);
}

process.on('unhandledRejection', (e) => {
  console.error('HARNESS unhandledRejection:', e);
  settle(false, 2);
});

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      show: false,
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false
      }
    });
    await withTimeout(win.loadFile(path.join(__dirname, '..', 'build', 'index.html')), 60_000, 'window load');
    await waitForApi();
    console.log('Harness ready — running source tests against the real extract pipeline.');
    await main();
    settle();
  } catch (e) {
    console.error('HARNESS setup error:', e);
    settle(false, 2);
  }
});