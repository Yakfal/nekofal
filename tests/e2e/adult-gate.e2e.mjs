// Visual E2E for the Family-Mode passcode gate — the app's "Adult PIN".
// Runs the REAL src/components/AdultGate.jsx + src/contexts/AppSettingsContext.jsx
// (SHA-256 hashing, localStorage persistence, gate markup, unlock transitions).
//
//   A. CREATION  — set a passcode through the real context API, re-lock, and
//                  confirm the gate blocks and persists the hash.
//   B. REJECT    — a wrong passcode must be refused and stay locked.
//   C. UNLOCK    — the correct passcode must unlock and render <Adult />.
//   D. NO PLAINTEXT — the stored blob must hold only a SHA-256 hash, never the
//                  passcode itself (matches AppSettingsContext's own comment).
//   E. NO PIN    — with no passcode set, the gate must not strand the user.
//
// Run: node tests/e2e/adult-gate.e2e.mjs
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

const PASSCODE = '9042';
let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(path.join(HARNESS_DIR, 'adult.html'))) {
    console.error('missing tests/.harness-dist/adult.html\nRun: npm run build:harness');
    process.exit(1);
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const { origin, close } = await startStaticServer();
  console.log(`Static server: ${origin}`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720'],
  });
  const pageErrors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const url = `${origin}/adult.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 20000 });

    // ---------------------------------------------------------------- E ----
    console.log('\n[E] no passcode set — the gate must not strand the user');
    let ctx = await page.evaluate(() => window.__context());
    check('default state is Family Mode ON and locked', ctx.familyMode === true && ctx.unlocked === false, JSON.stringify({ familyMode: ctx.familyMode, unlocked: ctx.unlocked }));
    check('no passcode configured by default', ctx.hasPasscode === false);
    const noPinUi = await page.evaluate(() => ({
      gate: !!document.querySelector('.adult-gate'),
      input: !!document.querySelector('.adult-gate-input'),
      hint: ((document.querySelector('.adult-gate-hint') || {}).textContent || '').trim(),
    }));
    check('gate is displayed when Family Mode is on', noPinUi.gate === true);
    check('no passcode input shown when no passcode exists', noPinUi.input === false, `hint="${noPinUi.hint.slice(0, 60)}"`);
    await page.screenshot({ path: path.join(ARTIFACTS, 'adult-gate-no-passcode.png') });

    // ---------------------------------------------------------------- A ----
    console.log('\n[A] create a passcode through the real context API');
    const created = await page.evaluate(async (code) => window.__setPasscode(code), PASSCODE);
    check('setFamilyPasscode returned a SHA-256 hex hash', /^[0-9a-f]{64}$/.test(created || ''), `hash=${String(created).slice(0, 16)}...`);

    // The context writes prefs from a useEffect, so React must re-render before
    // the new state and the localStorage blob are observable. Asserting inside
    // the same evaluate() as the setter would read a stale render.
    await sleep(400);
    const afterCreate = await page.evaluate(() => { window.__lock(); return window.__context(); });
    await sleep(250);
    check('gate now reports a passcode exists', afterCreate.hasPasscode === true, JSON.stringify({ hasPasscode: afterCreate.hasPasscode }));
    check('session re-locked after creation', afterCreate.unlocked === false);

    // ---------------------------------------------------------------- D ----
    console.log('\n[D] persistence holds a hash, never the plaintext');
    const prefs = await page.evaluate(() => localStorage.getItem('yakfal-hub-preferences'));
    check('preferences blob was persisted', prefs !== null && prefs.length > 0);
    check('stored blob does NOT contain the plaintext passcode', !String(prefs).includes(PASSCODE), `blob length=${String(prefs).length}`);
    check('stored blob contains the hash', !!created && String(prefs).includes(created));

    // Reload: the gate must STILL be locked, from persisted state alone.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true, { timeout: 20000 });
    ctx = await page.evaluate(() => window.__context());
    check('after reload: passcode survived', ctx.hasPasscode === true);
    check('after reload: still LOCKED (unlock is session-only)', ctx.unlocked === false);

    const gateUi = await page.evaluate(() => ({
      input: !!document.querySelector('.adult-gate-input'),
      btn: ((document.querySelector('.adult-gate-btn') || {}).textContent || '').trim(),
    }));
    check('passcode input is now shown', gateUi.input === true);
    check('unlock button is present', gateUi.btn.length > 0, `label="${gateUi.btn}"`);

    // ---------------------------------------------------------------- B ----
    console.log('\n[B] a wrong passcode is refused');
    await page.type('.adult-gate-input', '0000');
    await page.click('.adult-gate-btn');
    await sleep(500);

    const afterWrong = await page.evaluate(() => ({
      unlocked: window.__context().unlocked,
      error: ((document.querySelector('.adult-gate-error') || {}).textContent || '').trim(),
      stillGate: !!document.querySelector('.adult-gate'),
      verify: null,
    }));
    check('wrong passcode did NOT unlock', afterWrong.unlocked === false);
    check('an error message is shown to the user', afterWrong.error.length > 0, `error="${afterWrong.error.slice(0, 50)}"`);
    check('gate is still displayed after a wrong attempt', afterWrong.stillGate === true);

    const verifyWrong = await page.evaluate((c) => window.__verify(c), '0000');
    check('verifyFamilyPasscode rejects the wrong code', verifyWrong === false);

    await page.screenshot({ path: path.join(ARTIFACTS, 'adult-gate-wrong-passcode.png') });
    console.log(`  screenshot -> tests/.artifacts/adult-gate-wrong-passcode.png`);

    // ---------------------------------------------------------------- C ----
    console.log('\n[C] the correct passcode unlocks the section');
    // Clear the previous attempt's value, then type the real code.
    await page.evaluate(() => { const i = document.querySelector('.adult-gate-input'); if (i) { i.value = ''; } });
    await page.click('.adult-gate-input', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type('.adult-gate-input', PASSCODE);
    await page.click('.adult-gate-btn');
    await sleep(700);

    const afterRight = await page.evaluate(() => ({
      unlocked: window.__context().unlocked,
      gate: !!document.querySelector('.adult-gate'),
      error: !!document.querySelector('.adult-gate-error'),
      body: document.body.innerText.slice(0, 160).replace(/\s+/g, ' ').trim(),
    }));

    check('correct passcode UNLOCKED the section', afterRight.unlocked === true);
    check('the gate was replaced by the Adult page', afterRight.gate === false, `rendered="${afterRight.body.slice(0, 70)}"`);
    check('no error banner after a correct passcode', afterRight.error === false);

    await page.screenshot({ path: path.join(ARTIFACTS, 'adult-gate-unlocked.png') });
    console.log(`  screenshot -> tests/.artifacts/adult-gate-unlocked.png`);

    // ------------------------------------------------------------- health --
    const harnessErrors = await page.evaluate(() => window.__errors || []);
    console.log('\n[health] page health');
    check('no uncaught errors in the page', pageErrors.length === 0, pageErrors.join(' | ') || 'clean');
    check('no harness errors', harnessErrors.length === 0, harnessErrors.join(' | ') || 'clean');
  } finally {
    await browser.close();
    await close();
  }

  console.log('\n============================================================');
  console.log(`Adult gate E2E: ${passed}/${passed + failed} assertions passed`);
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
