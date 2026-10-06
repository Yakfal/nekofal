// Visual E2E with a REAL YouTube stream.
//
// The local fixtures prove the player's timer logic, but they cannot prove the
// thing the bug report was actually about: a live googlevideo stream delivered
// through the app's real extraction path. So this test:
//
//   1. runs yt-dlp with the same client args the app uses
//      (player_client=android) to extract a genuine progressive MP4 URL,
//   2. verifies it is a real HTTP 206 Range-capable stream,
//   3. relays it to the browser SAME-ORIGIN through /ytproxy/ (googlevideo
//      sends no CORS headers and <video crossorigin="anonymous"> needs them),
//   4. mounts the real VideoPlayer on it and asserts the rendered timer goes
//      past 0:00 / past 2s of elapsed time, with a non-zero duration and a
//      moving progress bar.
//
// Run: node tests/e2e/youtube-timer.e2e.mjs
// Exit: 0 = all assertions passed, 1 = at least one failed.
// Network + a working yt-dlp binary are REQUIRED; this is a live-source test.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { startStaticServer } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = path.join(REPO, 'tests', '.harness-dist');
const ARTIFACTS = path.join(REPO, 'tests', '.artifacts');

// Rick Astley - Never Gonna Give You Up (4K Remaster): the app's own canary
// video, already used by scripts/test-all-sources.mjs.
const VIDEO = process.env.YT_TEST_VIDEO || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const MIN_ELAPSED_SECONDS = 2;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function findYtDlp() {
  const candidates = [
    process.env.YT_DLP_PATH,
    path.join(os.homedir(), 'AppData', 'Roaming', 'yakfal-hub', 'bin', 'yt-dlp.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Nekofal', 'bin', 'yt-dlp.exe'),
    'yt-dlp',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'yt-dlp') { execFileSync('yt-dlp', ['--version'], { stdio: 'ignore' }); return c; }
      if (fs.existsSync(c)) return c;
    } catch { /* try next */ }
  }
  return null;
}

function extractDirectUrl(ytdlp) {
  const out = execFileSync(ytdlp, [
    '--no-warnings',
    '--no-playlist',
    '-f', '18',                       // progressive mp4 (muxed) — plays in <video> directly
    '--extractor-args', 'youtube:player_client=android',
    '-g', VIDEO,
  ], { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 180000 });
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const url = lines.find((l) => /^https?:\/\//i.test(l));
  if (!url) throw new Error(`yt-dlp produced no URL:\n${out.slice(0, 400)}`);
  return url;
}

async function main() {
  if (!fs.existsSync(HARNESS_DIR)) {
    console.error('missing tests/.harness-dist\nRun: npm run build:harness');
    process.exit(1);
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const ytdlp = findYtDlp();
  if (!ytdlp) {
    console.error('could not locate a yt-dlp binary (set YT_DLP_PATH)');
    process.exit(1);
  }
  console.log(`yt-dlp: ${ytdlp}`);

  console.log(`extracting a real stream from ${VIDEO} ...`);
  const upstream = extractDirectUrl(ytdlp);
  console.log(`upstream: ${upstream.slice(0, 110)}...`);

  // --- prove the upstream is a genuine, seekable stream before the UI test --
  const probe = await fetch(upstream, {
    headers: { Range: 'bytes=0-1023', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36' },
  });
  const probeBuf = Buffer.from(await probe.arrayBuffer());
  check('upstream stream responds 206 with Range', probe.status === 206, `HTTP ${probe.status}, content-range=${probe.headers.get('content-range')}`);
  check('upstream returns real MP4 bytes', (probe.headers.get('content-type') || '').includes('mp4') && probeBuf.length > 256, `content-type=${probe.headers.get('content-type')} ${probeBuf.length}b`);

  process.env.YT_PROXY_TARGET = upstream;
  const { origin, close } = await startStaticServer();
  console.log(`Static server: ${origin} (proxying /ytproxy/ -> googlevideo)`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox',
      '--disable-dev-shm-usage', '--allow-running-insecure-content', '--window-size=1280,720'],
  });
  const pageErrors = [];
  const consoleLines = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));

    // direct=1 puts the raw media URL in videoUrl, so the component takes the
    // real direct-stream branch and hls.js is never consulted. The .mp4 suffix
    // matters: VideoPlayer validates that a direct stream URL looks like media
    // and rejects a bare path (the same reason hanime's tokenised
    // /hls/<id>/<token> playlists need special handling).
    const url = `${origin}/index.html?direct=1&src=${encodeURIComponent('/ytproxy/stream.mp4')}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 30000 });

    // Surface WHY the element never became playable instead of just timing out.
    let ready = true;
    try {
      await page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v && v.readyState >= 1 && isFinite(v.duration) && v.duration > 0;
      }, { timeout: 60000, polling: 300 });
    } catch {
      ready = false;
      const diag = await page.evaluate(() => {
        const v = document.querySelector('video');
        return {
          exists: !!v,
          readyState: v ? v.readyState : null,
          networkState: v ? v.networkState : null,
          currentSrc: v ? String(v.currentSrc).slice(0, 120) : null,
          error: v && v.error ? { code: v.error.code, message: v.error.message } : null,
          harnessErrors: window.__harnessErrors || [],
        };
      });
      console.log('\n  media did not become ready. diagnostics:');
      console.log('   ', JSON.stringify(diag, null, 2).split('\n').join('\n    '));
      console.log('  recent console:');
      consoleLines.slice(-12).forEach((l) => console.log('    ' + l));
      check('real YouTube stream reached readyState>=1 with a duration', false, JSON.stringify(diag.error || { readyState: diag.readyState, networkState: diag.networkState }));
    }

    if (ready) {
    await page.evaluate(() => document.querySelector('video').play());

    // Let real playback run past the required threshold.
    await page.waitForFunction((min) => {
      const v = document.querySelector('video');
      return v && v.currentTime > min;
    }, { timeout: 90000, polling: 250 }, MIN_ELAPSED_SECONDS + 1);

    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      const fill = document.querySelector('.progress-fill');
      const txt = (sel) => ((document.querySelector(sel) || {}).textContent || '').trim();
      return {
        duration: v.duration,
        currentTime: v.currentTime,
        paused: v.paused,
        readyState: v.readyState,
        elapsed: txt('.time-display .current-time'),
        total: txt('.time-display .duration-time'),
        fillWidth: fill ? fill.style.width : '',
        // Round-trip the proxy: how many bytes the element actually received.
        buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
      };
    });

    console.log('\n[YT] real YouTube stream in the real VideoPlayer');
    check('real YouTube stream reported a finite, non-zero duration', isFinite(state.duration) && state.duration > 0, `duration=${state.duration.toFixed(2)}s`);
    check('playback advanced past 2 seconds', state.currentTime > MIN_ELAPSED_SECONDS, `currentTime=${state.currentTime.toFixed(2)}s`);
    check('element is actually playing (not paused)', state.paused === false);
    check('media actually downloaded through the proxy', state.buffered > 0 && state.readyState >= 2, `readyState=${state.readyState} buffered=${state.buffered.toFixed(2)}s`);

    check('rendered elapsed timer is NOT stuck at 0:00', state.elapsed !== '0:00' && state.elapsed.length > 0, `elapsed="${state.elapsed}"`);
    check('rendered duration label is non-zero', state.total !== '0:00' && state.total !== '', `total="${state.total}"`);

    const fillPct = parseFloat(state.fillWidth);
    check('progress bar is non-zero and matches elapsed/duration', fillPct > 0.1, `fill=${state.fillWidth}`);
    const expectedPct = (state.currentTime / state.duration) * 100;
    check('progress bar is consistent with real playback position', Math.abs(fillPct - expectedPct) < 12, `fill=${fillPct.toFixed(2)}% expected~${expectedPct.toFixed(2)}%`);

    const elapsedSeconds = Number(state.elapsed.split(':')[0]) * 60 + Number(state.elapsed.split(':')[1] || 0);
    // The label TRUNCATES (0:02 while currentTime is 3.02) and the clock is
    // refreshed on a 250ms interval, so it can legitimately trail the element
    // by almost a second. Assert that window, not an exact floor() match, or the
    // test fails on sub-second timing alone.
    check(
      'rendered elapsed label tracks the element within one second',
      elapsedSeconds <= state.currentTime && state.currentTime - elapsedSeconds < 1.5,
      `label=${state.elapsed} (${elapsedSeconds}s) vs currentTime=${state.currentTime.toFixed(2)}s`
    );
    check('rendered elapsed label is past the 2 second mark', elapsedSeconds >= MIN_ELAPSED_SECONDS, `label=${state.elapsed}`);

    await page.screenshot({ path: path.join(ARTIFACTS, 'youtube-real-timer.png') });
    console.log(`  screenshot -> tests/.artifacts/youtube-real-timer.png`);

    console.log('\n[health] page health');
    check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');
    }
  } finally {
    await browser.close();
    await close();
    delete process.env.YT_PROXY_TARGET;
  }

  console.log('\n============================================================');
  console.log(`YouTube real-stream E2E: ${passed}/${passed + failed} assertions passed`);
  console.log('============================================================');
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: PASS');
}

main().catch((err) => {
  console.error('\nharness error:', err && err.stack ? err.stack : err);
  process.exit(1);
});
