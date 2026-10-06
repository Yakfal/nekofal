// Browser E2E playback verification for the real src/components/VideoPlayer.jsx.
//
// This is the release gate for the player. It launches a real Chromium (via
// Puppeteer), loads the built harness that mounts the unmodified VideoPlayer,
// feeds it a locally-served H.264/AAC MP4 through the component's own
// extractStream path, and then asserts against the live media element AND the
// rendered control bar:
//
//   1. video.duration > 0                (metadata was captured)
//   2. video.currentTime advances > 2s   (playback is real, not frozen at 0:00)
//   3. clicking the play/pause control pauses   -> video.paused === true
//   4. clicking it again resumes                 -> video.paused === false
//   5. the elapsed/total labels and the progress fill track real playback
//      (the "0:00 / 0:00 frozen at 0%" regression)
//   6. the control glyph agrees with the element's paused state
//   7. no uncaught errors / unhandled rejections in the page
//
// Run: node tests/e2e/playback.e2e.mjs
// Exit: 0 = all assertions passed, 1 = at least one failed.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startStaticServer } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = path.join(REPO, 'tests', '.harness-dist');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'sample.mp4');

const results = [];
let failures = 0;

function check(name, ok, detail) {
  const pass = !!ok;
  if (!pass) failures += 1;
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

function assertPrereqs() {
  if (!fs.existsSync(path.join(HARNESS_DIR, 'index.html'))) {
    throw new Error(
      `Harness bundle missing at ${HARNESS_DIR}. Run: npm run build:harness`
    );
  }
  if (!fs.existsSync(FIXTURE)) {
    throw new Error(
      `Test fixture missing at ${FIXTURE}. Regenerate with the make-fixture script.`
    );
  }
}

async function main() {
  assertPrereqs();

  const srv = await startStaticServer(0);
  console.log(`\nStatic server: ${srv.origin}`);

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

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

    const url = `${srv.origin}/index.html?page=/fixtures/page.html&src=/fixtures/sample.mp4`;
    console.log(`Loading harness: ${url}\n`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 15000 });

    // Wait for the <video> to report a real duration.
    console.log('Waiting for metadata...');
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return !!v && v.readyState >= 1 && v.duration > 0;
      },
      { timeout: 30000 }
    );

    // ---------------------------------------------------------------
    // 1. duration
    // ---------------------------------------------------------------
    console.log('\n[1] duration captured');
    const duration = await page.evaluate(() => document.querySelector('video').duration);
    check('video.duration > 0', duration > 0, `duration=${duration.toFixed(3)}s`);

    // ---------------------------------------------------------------
    // 2. playback actually advances past 2 seconds
    // ---------------------------------------------------------------
    console.log('\n[2] playback advances past 2s');
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return !!v && v.currentTime > 2;
      },
      { timeout: 30000, polling: 100 }
    );
    const advanced = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { currentTime: v.currentTime, paused: v.paused, readyState: v.readyState };
    });
    check(
      'video.currentTime advances past 2s',
      advanced.currentTime > 2,
      `currentTime=${advanced.currentTime.toFixed(3)}s readyState=${advanced.readyState}`
    );
    check(
      'element reports playing (not paused)',
      advanced.paused === false,
      `paused=${advanced.paused}`
    );

    // ---------------------------------------------------------------
    // 3. UI reflects real playback (the 0:00 / 0% regression)
    // ---------------------------------------------------------------
    console.log('\n[3] control bar tracks playback');
    const ui = await page.evaluate(() => {
      const txt = (sel) => {
        const el = document.querySelector(sel);
        return el ? el.textContent.trim() : null;
      };
      const fill = document.querySelector('.progress-fill');
      const handle = document.querySelector('.progress-handle');
      return {
        current: txt('.time-display .current-time'),
        total: txt('.time-display .duration-time'),
        fillWidth: fill ? fill.style.width : null,
        handleLeft: handle ? handle.style.left : null,
        trackNow: (() => {
          const t = document.querySelector('.progress-track');
          return t ? t.getAttribute('aria-valuenow') : null;
        })(),
        glyph: txt('.controls-row-inner button.control-btn'),
      };
    });

    check(
      'elapsed label is not stuck at 0:00',
      ui.current && ui.current !== '0:00',
      `current-time="${ui.current}"`
    );
    check(
      'total label shows the real duration',
      ui.total && ui.total !== '0:00' && ui.total !== '0:00:00',
      `duration-time="${ui.total}"`
    );
    check(
      'progress fill width is non-zero',
      !!ui.fillWidth && parseFloat(ui.fillWidth) > 0,
      `width=${ui.fillWidth}`
    );
    check(
      'progress handle offset is non-zero',
      !!ui.handleLeft && parseFloat(ui.handleLeft) > 0,
      `left=${ui.handleLeft}`
    );
    check(
      'progress track aria-valuenow tracks playback',
      !!ui.trackNow && parseFloat(ui.trackNow) > 0,
      `aria-valuenow=${ui.trackNow}`
    );

    // Glyph must show pause while the element is playing.
    const glyphWhilePlaying = ui.glyph;
    check(
      'control glyph shows Pause while playing',
      glyphWhilePlaying && glyphWhilePlaying.includes('\u23F8'),
      `glyph="${glyphWhilePlaying}"`
    );

    // ---------------------------------------------------------------
    // 4. clicking the play/pause control PAUSES
    // ---------------------------------------------------------------
    console.log('\n[4] click #1 pauses playback');
    // Locate the play/pause button by its aria-label so we click the real
    // control, not the native shadow controls.
    await page.evaluate(() => {
      const btn = document.querySelector('.controls-row-inner button[aria-label="Pause"]')
        || document.querySelector('.controls-row-inner button[aria-label="Play"]');
      if (!btn) throw new Error('play/pause control not found');
      btn.setAttribute('data-e2e-playpause', '1');
    });
    await page.click('button[data-e2e-playpause="1"]');

    const afterPauseClick = await page.evaluate(async () => {
      // Give React a tick to apply the change.
      await new Promise((r) => setTimeout(r, 250));
      const v = document.querySelector('video');
      return {
        paused: v.paused,
        currentTime: v.currentTime,
        glyph: (() => {
          const b = document.querySelector('.controls-row-inner button.control-btn');
          return b ? b.textContent.trim() : null;
        })(),
        aria: (() => {
          const b = document.querySelector('button[data-e2e-playpause="1"]');
          return b ? b.getAttribute('aria-label') : null;
        })(),
      };
    });
    check(
      'click #1 -> video.paused === true',
      afterPauseClick.paused === true,
      `paused=${afterPauseClick.paused} t=${afterPauseClick.currentTime.toFixed(2)}s`
    );
    check(
      'click #1 -> control glyph flips to Play',
      afterPauseClick.glyph && afterPauseClick.glyph.includes('\u25B6'),
      `glyph="${afterPauseClick.glyph}" aria-label="${afterPauseClick.aria}"`
    );

    // Confirm the playhead is genuinely frozen while paused.
    const t1 = await page.evaluate(() => document.querySelector('video').currentTime);
    await new Promise((r) => setTimeout(r, 600));
    const t2 = await page.evaluate(() => document.querySelector('video').currentTime);
    check(
      'playhead frozen while paused',
      Math.abs(t2 - t1) < 0.05,
      `t1=${t1.toFixed(3)} t2=${t2.toFixed(3)}`
    );

    // ---------------------------------------------------------------
    // 5. clicking again RESUMES
    // ---------------------------------------------------------------
    console.log('\n[5] click #2 resumes playback');
    await page.click('button[data-e2e-playpause="1"]');
    const afterResumeClick = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 250));
      const v = document.querySelector('video');
      return { paused: v.paused, currentTime: v.currentTime };
    });
    check(
      'click #2 -> video.paused === false',
      afterResumeClick.paused === false,
      `paused=${afterResumeClick.paused}`
    );

    const t3 = await page.evaluate(() => document.querySelector('video').currentTime);
    await new Promise((r) => setTimeout(r, 1200));
    const t4 = await page.evaluate(() => document.querySelector('video').currentTime);
    check(
      'playhead advances again after resume',
      t4 > t3 + 0.4,
      `t3=${t3.toFixed(3)} t4=${t4.toFixed(3)}`
    );

    // ---------------------------------------------------------------
    // 6. seeking via the progress track
    // ---------------------------------------------------------------
    console.log('\n[6] progress-bar seek');
    const seeked = await page.evaluate(async () => {
      const v = document.querySelector('video');
      const track = document.querySelector('.progress-track');
      const rect = track.getBoundingClientRect();
      const x = rect.left + rect.width * 0.6;
      const y = rect.top + rect.height / 2;
      const target = duration => duration; // no-op, keeps closure obvious
      void target;
      track.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })
      );
      await new Promise((r) => setTimeout(r, 400));
      return { currentTime: v.currentTime, duration: v.duration };
    });
    check(
      'clicking the progress track seeks forward',
      seeked.currentTime > seeked.duration * 0.4,
      `currentTime=${seeked.currentTime.toFixed(2)} duration=${seeked.duration.toFixed(2)}`
    );

    // ---------------------------------------------------------------
    // 7. no runtime errors
    // ---------------------------------------------------------------
    console.log('\n[7] page health');
    const harnessErrors = await page.evaluate(() => window.__harnessErrors || []);
    check(
      'no uncaught errors in the page',
      pageErrors.length === 0,
      pageErrors.length ? pageErrors.join(' | ') : 'clean'
    );
    check(
      'no unhandled promise rejections',
      harnessErrors.length === 0,
      harnessErrors.length ? harnessErrors.join(' | ') : 'clean'
    );

    // ReferenceError from an undefined handler would surface here; treat any
    // error-class console noise about undefined symbols as a failure.
    const fatalConsole = consoleErrors.filter((t) =>
      /is not defined|ReferenceError|Cannot read propert(?:y|ies) of undefined/i.test(t)
    );
    check(
      'no ReferenceError / undefined-symbol console errors',
      fatalConsole.length === 0,
      fatalConsole.length ? fatalConsole.slice(0, 3).join(' | ') : 'clean'
    );

    if (consoleErrors.length) {
      console.log(`\n  (info: ${consoleErrors.length} console error line(s) captured)`);
      consoleErrors.slice(0, 5).forEach((t) => console.log(`    - ${t.slice(0, 160)}`));
    }
  } finally {
    await browser.close();
    await srv.close();
  }

  // ---------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${'='.repeat(64)}`);
  console.log(`Playback E2E: ${passed}/${results.length} assertions passed`);
  console.log('='.repeat(64));
  if (failures > 0) {
    console.log('\nFailed assertions:');
    results.filter((r) => !r.pass).forEach((r) => console.log(`  - ${r.name} (${r.detail})`));
    console.log('\nRESULT: FAIL');
    process.exit(1);
  }
  console.log('\nRESULT: PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error('\nE2E harness error:', err && err.stack ? err.stack : err);
  process.exit(1);
});