// Ad-hoc diagnostic: dump the media element + console output from the harness.
// Used to explain WHY the player fails, not as a pass/fail gate.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startStaticServer } from './static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srv = await startStaticServer(0);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(
  `${srv.origin}/index.html?page=/fixtures/page.html&src=/fixtures/sample.mp4`,
  { waitUntil: 'domcontentloaded', timeout: 30000 }
);
await page.waitForFunction(() => window.__harnessReady === true, { timeout: 15000 });
await new Promise((r) => setTimeout(r, 6000));

const state = await page.evaluate(() => {
  const v = document.querySelector('video');
  return {
    hasVideo: !!v,
    src: v ? v.getAttribute('src') : null,
    currentSrc: v ? v.currentSrc : null,
    readyState: v ? v.readyState : null,
    networkState: v ? v.networkState : null,
    duration: v ? v.duration : null,
    currentTime: v ? v.currentTime : null,
    paused: v ? v.paused : null,
    error: v && v.error ? { code: v.error.code, msg: v.error.message } : null,
    harnessErrors: window.__harnessErrors || [],
    timeLabels: {
      current: document.querySelector('.time-display .current-time')?.textContent?.trim(),
      total: document.querySelector('.time-display .duration-time')?.textContent?.trim(),
    },
    fillWidth: document.querySelector('.progress-fill')?.style?.width,
    glyph: document.querySelector('.controls-row-inner button.control-btn')?.textContent?.trim(),
    apiCalls: (window.api && window.api.__calls || []).map((c) => c.name),
  };
});

console.log(JSON.stringify(state, null, 2));
console.log('\n--- console ---');
logs.slice(0, 40).forEach((l) => console.log(l));

await browser.close();
await srv.close();