// Visual/behavioural E2E for the four v1.0.88 player regressions.
//
// This complements playback.e2e.mjs (which covers the happy path). Each test
// here reproduces a specific reported bug and asserts it can no longer happen:
//
//   A. TIMER STALLS AT 0:00 — `timeupdate` is swallowed on the live element, so
//      the only thing that can advance the clock is the 250ms polling fallback.
//   B. VOLUME RESETS ON THE NEXT VIDEO — the user drops to 15%, opens a
//      DIFFERENT video, and the level must survive the unmount/remount.
//   C. VIDEO CLICK IS UNRELIABLE — one click must toggle exactly once (no
//      triple-counted bubbling, no "needs several clicks").
//   D. DOUBLE CLICK DOES NOTHING — two clicks inside the debounce window must go
//      fullscreen and must NOT also toggle play/pause.
//
// Run: node tests/e2e/player-v1088.e2e.mjs
// Exit: 0 = all assertions passed, 1 = at least one failed.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startStaticServer } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = path.join(REPO, 'tests', '.harness-dist');
const ARTIFACTS = path.join(REPO, 'tests', '.artifacts');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function assertPrereqs() {
  for (const p of [HARNESS_DIR, path.join(REPO, 'tests', 'fixtures', 'sample.mp4'), path.join(REPO, 'tests', 'fixtures', 'sample2.mp4')]) {
    if (!fs.existsSync(p)) {
      console.error(`missing prerequisite: ${p}\nRun: npm run build:harness`);
      process.exit(1);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assertPrereqs();
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const { origin, close } = await startStaticServer();
  console.log(`Static server: ${origin}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--allow-running-insecure-content',
      '--window-size=1280,720',
    ],
  });

  const consoleErrors = [];
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    // Start from a clean slate so a remembered volume from a previous run
    // cannot make this suite pass by accident.
    await page.goto(`${origin}/index.html?src=/fixtures/sample.mp4`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());

    const url = `${origin}/index.html?src=/fixtures/sample.mp4`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);

    // ---------------------------------------------------------------- A ----
    console.log('\n[A] timer advances with timeupdate completely disabled');
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 1 && v.duration > 0;
    }, { timeout: 30000 });
    await page.evaluate(() => {
      const v = document.querySelector('video');
      return v.play();
    });
    await sleep(600);

    // Swallow every `timeupdate` from here on. If the UI clock still moves,
    // it can only be the 250ms polling fallback doing its job.
    await page.evaluate(() => window.__swallowEvents('timeupdate'));

    const before = await page.evaluate(() => ({
      currentTime: document.querySelector('video').currentTime,
      elapsed: ((document.querySelector('.time-display .current-time') || {}).textContent || '').trim(),
    }));

    await sleep(2500);

    const after = await page.evaluate(() => {
      const v = document.querySelector('video');
      const fill = document.querySelector('.progress-fill');
      return {
        currentTime: v.currentTime,
        elapsed: ((document.querySelector('.time-display .current-time') || {}).textContent || '').trim(),
        fillWidth: fill ? fill.style.width : '',
      };
    });

    check(
      'timeupdate is genuinely suppressed on the element',
      await page.evaluate(() => {
        const v = document.querySelector('video');
        let seen = false;
        const probe = () => { seen = true; };
        v.addEventListener('timeupdate', probe);
        v.dispatchEvent(new Event('timeupdate'));
        v.removeEventListener('timeupdate', probe);
        return seen === false;
      }),
      'dispatchEvent is intercepted by the harness hook'
    );

    check(
      'media currentTime really advanced while timeupdate was dead',
      after.currentTime > before.currentTime + 1.5,
      `${before.currentTime.toFixed(2)}s -> ${after.currentTime.toFixed(2)}s`
    );

    check(
      'elapsed label is NOT stuck at 0:00 without timeupdate',
      after.elapsed !== '0:00' && after.elapsed.trim() !== before.elapsed.trim(),
      `"${before.elapsed}" -> "${after.elapsed}"`
    );

    check(
      'progress fill is non-zero without timeupdate',
      parseFloat(after.fillWidth) > 0,
      `width=${after.fillWidth}`
    );

    await page.screenshot({ path: path.join(ARTIFACTS, 'player-timer-polling.png') });
    console.log(`  screenshot -> tests/.artifacts/player-timer-polling.png`);

    // ---------------------------------------------------------------- C ----
    console.log('\n[C] a single video click toggles exactly once');
    await page.evaluate(() => {
      const v = document.querySelector('video');
      window.__restoreEvents = v.dispatchEvent;
    });

    const box = await page.evaluate(() => {
      const v = document.querySelector('video');
      const r = v.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });

    const playingBefore = await page.evaluate(() => document.querySelector('video').paused);
    await page.mouse.click(box.x, box.y);
    await sleep(700); // must exceed the 250ms debounce
    const playingAfterOneClick = await page.evaluate(() => document.querySelector('video').paused);

    check(
      'one click flipped the paused state (not zero times, not twice)',
      playingBefore !== playingAfterOneClick,
      `paused ${playingBefore} -> ${playingAfterOneClick}`
    );

    // Put it back into a known playing state for the double-click test.
    await page.evaluate(() => document.querySelector('video').play());
    await sleep(400);
    const pausedBeforeDouble = await page.evaluate(() => document.querySelector('video').paused);
    check('precondition: playing before the double click', pausedBeforeDouble === false);

    // ---------------------------------------------------------------- D ----
    console.log('\n[D] a double click goes fullscreen and does NOT toggle playback');
    await page.mouse.click(box.x, box.y, { clickCount: 2, delay: 40 });
    await sleep(700);

    const afterDouble = await page.evaluate(() => ({
      paused: document.querySelector('video').paused,
      fullscreen: !!document.fullscreenElement,
      fullscreenClass: document.querySelector('.video-player-container')
        ? document.querySelector('.video-player-container').className
        : '',
    }));

    check(
      'double click did NOT toggle play/pause',
      afterDouble.paused === false,
      `paused=${afterDouble.paused} (was ${pausedBeforeDouble})`
    );

    check(
      'double click entered fullscreen',
      afterDouble.fullscreen === true,
      `document.fullscreenElement set=${afterDouble.fullscreen}`
    );

    await page.screenshot({ path: path.join(ARTIFACTS, 'player-double-click-fullscreen.png') });
    console.log(`  screenshot -> tests/.artifacts/player-double-click-fullscreen.png`);

    // Leave fullscreen so the next test measures a normal layout.
    await page.evaluate(() => {
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    });
    await sleep(400);

    // ---------------------------------------------------------------- B ----
    console.log('\n[B] volume survives switching to a DIFFERENT video');
    // Drive the real slider so the whole commit path (state + global key +
    // legacy prefs) is exercised, not a synthetic element write.
    await page.evaluate(() => {
      const slider = document.querySelector('input.volume-slider');
      if (!slider) throw new Error('volume slider not found');
      const max = parseFloat(slider.max || '1') || 1;
      const target = max * 0.15;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(slider, String(target));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(400);

    const volSet = await page.evaluate(() => ({
      element: document.querySelector('video').volume,
      stored: window.__localVolume(),
      prefs: localStorage.getItem('pmh-preferences'),
    }));

    check(
      'volume slider applied 15% to the media element',
      Math.abs(volSet.element - 0.15) < 0.02,
      `video.volume=${volSet.element.toFixed(3)}`
    );
    check(
      'nekofal_user_volume persists the choice',
      volSet.stored !== null && Math.abs(parseFloat(volSet.stored) - 0.15) < 0.02,
      `nekofal_user_volume=${volSet.stored}`
    );
    check(
      'legacy pmh-preferences still carries defaultVolume',
      volSet.prefs !== null && volSet.prefs.includes('defaultVolume'),
      `pmh-preferences=${volSet.prefs}`
    );

    // The actual regression: a brand new video, fresh element, default volume 1.
    await page.evaluate(() => window.__loadVideo('/fixtures/sample2.mp4'));
    await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v && v.readyState >= 1 && v.duration > 0;
    }, { timeout: 30000 });
    await sleep(600);

    const volNext = await page.evaluate(() => ({
      element: document.querySelector('video').volume,
      muted: document.querySelector('video').muted,
      duration: document.querySelector('video').duration,
      stored: window.__localVolume(),
    }));

    check('the second video really is a different source', volNext.duration > 0 && Math.abs(volNext.duration - 12) > 0.1, `duration=${volNext.duration}s (first clip is 12s)`);
    check(
      'volume carried over to the NEXT video (was 0.15, must not be 1.0)',
      Math.abs(volNext.element - 0.15) < 0.02,
      `video.volume=${volNext.element.toFixed(3)} stored=${volNext.stored}`
    );
    check('next video is not muted by the carry-over', volNext.muted === false, `muted=${volNext.muted}`);

    await page.screenshot({ path: path.join(ARTIFACTS, 'player-volume-carried-over.png') });
    console.log(`  screenshot -> tests/.artifacts/player-volume-carried-over.png`);

    // ------------------------------------------------------------ hygiene --
    const harnessErrors = await page.evaluate(() => window.__harnessErrors || []);
    const refErrors = [...consoleErrors, ...pageErrors, ...harnessErrors].filter((t) =>
      /ReferenceError|is not defined|undefined is not|not a function/i.test(String(t))
    );

    console.log('\n[health] page health');
    check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');
    check('no unhandled rejections', harnessErrors.filter((e) => typeof e === 'string').length === 0, harnessErrors.join(' | ') || 'clean');
    check('no ReferenceError / undefined-symbol console errors', refErrors.length === 0, refErrors.join(' | ') || 'clean');
  } finally {
    await browser.close();
    await close();
  }

  console.log('\n============================================================');
  console.log(`v1.0.88 player E2E: ${passed}/${passed + failed} assertions passed`);
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
