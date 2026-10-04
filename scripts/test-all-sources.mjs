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

// Dedup key identical to the player's dropdown deduplicator: display label →
// height → width → format_id. Two rows sharing a key would render as
// duplicate entries ("720p", "720p") in the quality menu.
function dedupKey(q) {
  if (!q) return null;
  const label = (q.label && String(q.label).trim().toLowerCase()) || '';
  if (label) return label;
  if (q.height) return `${Math.round(Number(q.height))}p`;
  if (q.width) return `${Math.round(Number(q.width))}px`;
  return q.formatId ? String(q.formatId) : null;
}

function fieldDupKeys(list) {
  const seen = new Map();
  const dups = new Set();
  for (const q of list) {
    const k = dedupKey(q);
    if (!k) continue;
    if (seen.has(k)) dups.add(k);
    else seen.set(k, q);
  }
  return [...dups];
}

// v1.0.66: the player resolves its dropdown from a SINGLE envelope field, in
// priority order — `qualities` (≥2 structured tiers) else `qualityLevels` else
// `data.formats` (see VideoPlayer.init). Several adult envelopes carry the SAME
// clean set in both `qualities` and `qualityLevels` for different consumers;
// merging fields before dup-checking would therefore double-report every key.
// So assert each field is internally duplicate-free (extractors must ship clean
// arrays even though the player-side deduplicator would survive a dupe).
function duplicateQualityKeys(result) {
  const groups = [
    ['formats', result && result.data && Array.isArray(result.data.formats) ? result.data.formats : []],
    ['qualities', Array.isArray(result && result.qualities) ? result.qualities : []],
    ['qualityLevels', Array.isArray(result && result.qualityLevels) ? result.qualityLevels : []]
  ];
  const out = [];
  for (const [name, list] of groups) {
    const d = fieldDupKeys(list);
    if (d.length) out.push(`${name}: ${d.join(', ')}`);
  }
  return out;
}

// ---- real playback-surface checks ------------------------------------------
// Fetch the URL from INSIDE the app window, so the request crosses the same
// Chromium CORS enforcement, session interceptors (YT isolation, CDN header
// stamping, ad-block) and proxy surface the actual <video> + hls.js use.
// Returns { ok, status, ctype, bytes, head, cors, error }.
async function fetchFromApp(url, label, ms) {
  const script = `(async () => {
    const target = ${JSON.stringify(url)};
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(target, {
        cache: 'no-store',
        credentials: 'omit',
        signal: ctl.signal,
        headers: { Range: 'bytes=0-4095' }
      });
      clearTimeout(t);
      const buf = await r.arrayBuffer();
      const txt = new TextDecoder('utf-8').decode(buf.slice(0, Math.min(buf.byteLength, 131072)));
      return { ok: r.ok && r.status >= 200 && r.status < 300, status: r.status, ctype: (r.headers.get('content-type') || '').slice(0, 64), bytes: buf.byteLength, head: txt.slice(0, 24000), cors: true };
    } catch (e) {
      clearTimeout(t);
      if (e && e.name === 'AbortError') return { ok: false, cors: true, aborted: true, status: 0, error: 'timeout' };
      return { ok: false, cors: false, status: 0, error: String((e && e.message) || e) };
    }
  })()`;
  const res = await callWindow(script, ms);
  res.__label = label;
  return res;
}

// Mirror the player's registerStreamHeaders: the app stamps Referer/Origin/UA
// on the exact stream URL at main-process level (Chromium forbids setting
// Referer from a renderer fetch), so a probe that skips it would spuriously
// 403/410 on header-gated CDNs (Pornhub's HLS manifests are one).
async function registerStreamHeadersForFetch(url, headers) {
  if (!url || !headers || typeof headers !== 'object') return;
  const keys = Object.keys(headers).filter((k) => String(headers[k]));
  if (!keys.length) return;
  await callWindow(
    `window.electronAPI.setStreamHeaders(${JSON.stringify(url)}, ${JSON.stringify(headers)}).then(() => true)`,
    15_000
  ).catch(() => {});
}

// First plain URI line of an HLS playlist (variant / media-playlist / segment
// URL), resolved against the playlist's own URL; null when the body carries none.
function firstPlaylistUri(head, baseUrl) {
  const lines = String(head || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = (raw || '').trim();
    if (!line || line.startsWith('#')) continue;
    if (/^https?:\/\//i.test(line)) return line;
    try { return new URL(line, baseUrl).href; } catch (_e) { /* relative broken */ }
  }
  return null;
}

// Walk an HLS chain from a master playlist: master → first variant → first
// segment, fetching each THROUGH the app renderer like hls.js would. Asserts
// 2xx at every hop so a 403/CORS mid-chain cannot pass silently.
async function probeHlsMaster(masterUrl, ms) {
  const master = await fetchFromApp(masterUrl, 'master', ms);
  const chain = [{ name: 'master', ...master }];
  if (!master.ok) return { ok: false, chain };
  if (!String(master.head).includes('#EXTM3U')) {
    return { ok: false, chain, why: `master did not return #EXTM3U (ctype=${master.ctype})` };
  }
  const variant = firstPlaylistUri(master.head, masterUrl);
  if (!variant) return { ok: false, chain, why: 'master has no variant URI in the probed head' };
  const vp = await fetchFromApp(variant, 'variant', ms);
  chain.push({ name: 'variant', ...vp });
  if (!vp.ok) return { ok: false, chain, why: `first variant returned HTTP ${vp.status}${vp.cors ? '' : ' (CORS blocked)'}` };
  const seg = firstPlaylistUri(vp.head, variant);
  if (seg) {
    const sg = await fetchFromApp(seg, 'segment', ms);
    chain.push({ name: 'segment', ...sg });
    if (!sg.ok) return { ok: false, chain, why: `first segment returned HTTP ${sg.status}${sg.cors ? '' : ' (CORS blocked)'}` };
  }
  return { ok: true, chain };
}

function probeSummary(chain) {
  return chain.map((s) => `${s.name}=${s.status || s.error || '?'}${s.bytes ? `(${s.bytes}b)` : ''}`).join(' → ');
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
  const dups = duplicateQualityKeys(res);
  if (dups.length) return report('YouTube', false, `duplicate quality labels in roster: ${dups.join(', ')}`);
  // Real playback-surface check: walk the HLS chain (master → variant →
  // segment) with in-window fetches so a googlevideo 403/CORS surfaces here,
  // exactly like it would in the player.
  if (/\.m3u8|hls_variant|\/api\/manifest\//i.test(fu)) {
    const probe = await probeHlsMaster(fu, 90_000);
    if (!probe.ok) return report('YouTube', false, `stream not playable through the app pipeline: ${probe.why} (${probeSummary(probe.chain)})`);
    report('YouTube', true, `${ms}ms · ${res.data && res.data.sourceSite ? res.data.sourceSite : 'yt-dlp'} · ${ladder} tiers · ${probeSummary(probe.chain)} · ${fu.slice(0, 70)}`);
  } else {
    await registerStreamHeadersForFetch(fu, res.httpHeaders);
    const pf = await fetchFromApp(fu, 'direct', 90_000);
    if (!pf.ok) return report('YouTube', false, `direct stream unplayable: HTTP ${pf.status}${pf.cors ? '' : ' (CORS blocked)'} · ${fu.slice(0, 90)}`);
    report('YouTube', true, `${ms}ms · ${res.data && res.data.sourceSite ? res.data.sourceSite : 'yt-dlp'} · ${ladder} tiers · direct ${pf.status}(${pf.bytes}b) · ${fu.slice(0, 70)}`);
  }
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
  const dups = duplicateQualityKeys(res);
  if (dups.length) return report(label, false, `duplicate quality labels: ${dups.join(', ')}`);
  const badTier = rows.find((q) => !validMediaUrl(q.url) || isAdUrl(q.url));
  if (badTier) return report(label, false, `quality tier points at non-media/ad URL: "${badTier.url}"`);
  // v1.0.66: prove the top quality tier actually serves media bytes through
  // the app's interceptor + CORS surface (403/404/CORS here = broken switch).
  const top = rows[rows.length - 1];
  await registerStreamHeadersForFetch(top.url, res.httpHeaders);
  let pf;
  let chainSummary = null;
  if (/\.m3u8|\.m3u|\/hls\/|api\/manifest/i.test(top.url)) {
    const chain = await probeHlsMaster(top.url, 90_000);
    if (!chain.ok) return report(label, false, `top quality tier (HLS) unplayable through the app pipeline: ${chain.why} (${probeSummary(chain.chain)}) · ${top.url.slice(0, 80)}`);
    pf = chain.chain[0];
    chainSummary = probeSummary(chain.chain);
  } else {
    pf = await fetchFromApp(top.url, 'top-tier', 90_000);
    if (!pf.ok) return report(label, false, `top quality tier unplayable through the app pipeline: HTTP ${pf.status}${pf.cors ? '' : ' (CORS blocked)'}${pf.error ? ' · ' + pf.error : ''} · ${top.url.slice(0, 90)}`);
  }
  report(label, true, `${ms}ms · ${extractor} · ${rows.length} tier${rows.length === 1 ? '' : 's'} (${rows.map((r) => /\.m3u8|\.m3u|\/hls\//i.test(r.url) ? 'm3u8' : 'mp4').join(',')}) · top ${pf.status}(${pf.bytes}b)${chainSummary ? ` ${chainSummary}` : ''}${agegated ? ' [age-gate: single JSON-LD tier]' : ''} · ${fu.slice(0, 90)}`);
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
    const dups = duplicateQualityKeys(res);
    if (dups.length) return { ok: false, why: `${tag} duplicate quality labels: ${dups.join(', ')}` };
    const badTier = rows.find((q) => !validMediaUrl(q.url) || isAdUrl(q.url));
    if (badTier) return { ok: false, why: `${tag} quality tier at non-media/ad URL "${badTier.url}"` };
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