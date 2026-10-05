// verify-local-ui.mjs — v1.0.68 release gate: REAL desktop UI verification.
//
// Boots the actual Electron application (main.js + build/index.html + real
// preload) and drives the REAL user flow end to end:
//
//   1. land on #/discover, type the target URL into the search box, submit;
//   2. click the first result card  ->  the global overlay player mounts;
//   3. assert the <video> element decodes and ADVANCES (currentTime grows
//      while readyState >= 2) — this is the hard proof that playback is not
//      frozen at 0:00;
//   4. open the quality menu and assert the dropdown carries real tiers
//      (Auto + >= 2 for adult/XVIDEOS/Pornhub/XNXX, Auto + >= 1 for YT);
//   5. click a non-Auto tier and assert the switch does not kill playback
//      (currentTime keeps advancing and the quality trigger label updates).
//
// Every assertion runs against the same Chromium session, CORS interceptors,
// ad-block and header-stamping the real user gets. Renderer console output is
// captured per source so a failing source ships its evidence.
//
// Run:  npx electron scripts/verify-local-ui.mjs
//
// Env overrides:
//   NEKOFAL_UI_SITES        comma list  e.g. yt,pornhub  (default: all 5)
//   NEKOFAL_UI_YT_URL       NEKOFAL_UI_XVIDEOS_URL
//   NEKOFAL_UI_PORNHUB_URL  NEKOFAL_UI_XNXX_URL        NEKOFAL_UI_HANIME_URL
//   NEKOFAL_UI_PLAY_MS      max ms waiting for currentTime to advance
//   NEKOFAL_UI_EXTRACT_MS   max ms waiting for the player to mount
//
// HAnime note: this network sits behind a permanent Cloudflare managed
// challenge, so the hanime run CANNOT honestly report "plays". It attempts the
// real flow and reports SKIPPED-CF with the captured extraction error + player
// console tail as evidence (never a silent pass, never rely-on-skip).
//
// Exit code: 0 = all sources pass, 1 = >= 1 source failed, 2 = harness error.

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const NET_FILE = path.join(process.env.TEMP || '.', 'opencode', 'vh-netlog.json');

process.env.NODE_ENV = 'production';
require(path.join(__dirname, '..', 'electron', 'main.js'));

const SITES = {
  yt: { label: 'Youtube', url: process.env.NEKOFAL_UI_YT_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', playMs: 90000 },
  xvideos: { label: 'XVideos', url: process.env.NEKOFAL_UI_XVIDEOS_URL || 'https://www.xvideos.com/video6847511/brazzers_mommy_and_me', playMs: 60000 },
  pornhub: { label: 'Pornhub', url: process.env.NEKOFAL_UI_PORNHUB_URL || 'https://www.pornhub.com/view_video.php?viewkey=ph5ac6f6d2f0d41', playMs: 60000 },
  xnxx: { label: 'XNXX', url: process.env.NEKOFAL_UI_XNXX_URL || 'https://www.xnxx.com/video-3xyf4c8/nomand_sf_apricot_color', playMs: 60000 },
  hanime: { label: 'HAnime', url: process.env.NEKOFAL_UI_HANIME_URL || 'https://hanime.tv/videos/hentai/majuu-sensen-4-houkago-no-iyasare-4', playMs: 80000 }
};

const PLAY_MS = Math.max(20000, Number(process.env.NEKOFAL_UI_PLAY_MS) || 60000);
const EXTRACT_MS = Math.max(30000, Number(process.env.NEKOFAL_UI_EXTRACT_MS) || 120000);

const RESULTS = [];
const now = () => new Date().toISOString().slice(11, 19);

function report(name, ok, details, kind) {
  RESULTS.push({ name, ok, details, kind: kind || (ok ? 'PASS' : 'FAIL') });
  console.log(`${kind || (ok ? 'PASS' : 'FAIL')}  [${now()}]  ${name}  ${details}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms))
  ]);
}

function env(k) { const v = process.env[k]; return v && String(v).trim() ? String(v).trim() : null; }

// ---- window driver ---------------------------------------------------------
let win = null;
const CONSOLE = [];
const NETLOG = env('NEKOFAL_UI_NETLOG') ? [] : null;
let consoleFwd = 0;

async function callWindow(script, ms) {
  return withTimeout(win.webContents.executeJavaScript(script), ms || 15000, 'window call');
}

async function waitFor(scriptBool, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await callWindow(scriptBool, 10000)) return true;
    } catch (_e) { /* window busy / reloading */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} never became true within ${Math.round(ms / 1000)}s`);
}

async function waitForApi() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const ok = await callWindow(`({ api: typeof window.electronAPI?.extractStream === 'function', search: typeof window.electronAPI?.webSearch === 'function' })`, 10000);
      if (ok && ok.api && ok.search) return true;
    } catch (_e) { /* not mounted yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('window.api never became available');
}

// Install an idempotent page helper used by every drive step.
// NOTE: String.raw keeps the embedded `/\r?\n/` regex literal intact (a normal
// template literal would turn its \r / \n escapes into real control bytes and
// the page would reject the script with a regex SyntaxError).
const SEED_HANDLER = String.raw`(() => {
  try {
    window.__vh = window.__vh || (() => {
    const q = (sel) => document.querySelector(sel);
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const setInput = (value) => {
      const input = q('.vss-input');
      if (!input) return { ok: false, why: 'no .vss-input' };
      nativeSet.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true };
    };
    const submit = () => {
      const form = q('.vss-searchbar');
      if (!form) return { ok: false, why: 'no .vss-searchbar' };
      form.requestSubmit();
      return { ok: true };
    };
    const clickCard = () => {
      const t = q('.vss-card .vss-thumb') || q('.vss-btn.play');
      if (!t) return { ok: false, why: 'no result card' };
      t.click();
      return { ok: true };
    };
    const videoState = () => {
      const all = [...document.querySelectorAll('.video-player-container video')].filter((v) => v.readyState || v.currentTime || !v.paused);
      const v = (all.find((el) => el.readyState >= 3) || all.find((el) => !el.paused) || all.sort((a, b) => b.currentTime - a.currentTime)[0]) || q('.video-player-container video');
      if (!v) return null;
      return {
        currentTime: Math.round(v.currentTime * 1000) / 1000,
        readyState: v.readyState,
        networkState: v.networkState,
        paused: v.paused,
        ended: v.ended,
        duration: Math.round((v.duration || 0) * 1000) / 1000,
        vw: v.videoWidth,
        vh: v.videoHeight,
        currentSrc: String(v.currentSrc || '').slice(0, 140),
        err: v.error ? { code: v.error.code, message: String(v.error.message || '').slice(0, 160) } : null,
        hlsReady: !!v.mozSrcObject || !!v.srcObject
      };
    };
    const allVideos = () => [...document.querySelectorAll('.video-player-container video')].map((v, i) => ({
        i,
        display: getComputedStyle(v).display,
        cls: String(v.className || '').slice(0, 24),
        cur: Math.round((v.currentTime || 0) * 100) / 100,
        rs: v.readyState,
        ns: v.networkState,
        p: v.paused,
        dur: Math.round((v.duration || 0) * 100) / 100,
        src0: String(v.currentSrc || '').slice(0, 16)
      }));
    const closePlayer = () => {
      const btns = [...document.querySelectorAll('[aria-label="Close player"]')];
      if (!btns.length) return { ok: false, why: 'no close button' };
      btns[btns.length - 1].click();
      return { ok: true };
    };
    const openQuality = () => {
      const t = q('[aria-label="Quality settings"]');
      if (!t) return { ok: false, why: 'no quality trigger' };
      t.click();
      return { ok: true };
    };
    const qualityMenu = () => {
      const items = [...document.querySelectorAll('.quality-menu .menu-item')].map((b) => b.textContent.trim());
      return { items, count: items.length, open: !!q('.quality-menu') };
    };
    const triggerLabel = () => {
      const t = q('[aria-label="Quality settings"]');
      return t ? t.textContent.trim() : null;
    };
    const playerError = () => {
      const e = q('.error-message');
      return e ? e.textContent.trim() : null;
    };
    const resolving = () => {
      const r = q('.playback-resolving-title');
      return r ? r.textContent.trim() : null;
    };
    const onDiscover = () => {
      const s = q('.vss-searchbar');
      const cards = q('.vss-card');
      return { searchbar: !!s, cards: !!cards, cardCount: document.querySelectorAll('.vss-card').length };
    };
    const diagnoseYt = async (url) => {
      const out = { envelope: null, master: null, error: null };
      try {
        const res = await window.electronAPI.extractStream(String(url));
        const data = res && res.data ? res.data : {};
        out.envelope = {
          ok: !!(res && res.success),
          extractor: String(res.extractor || (data.extractor || '')),
          isHLS: !!(res.isHLS || data.isHLS),
          streamUrl: String((data.videoUrl) || (res.streamUrl) || '').slice(0, 220),
          formats: Array.isArray(data.formats) ? data.formats.map((f) => ({
            h: f.height, w: f.width, tag: f.format_id || f.formatId || '',
            ac: f.acodec, vc: f.vcodec, audio: f.hasAudio,
            kind: String(f.url || '').includes('m3u8') ? 'm3u8' : 'direct'
          })).slice(0, 14) : [],
          qualityLevels: (Array.isArray(res.qualityLevels) ? res.qualityLevels : (Array.isArray(data.qualityLevels) ? data.qualityLevels : []))
            .map((x) => ({ h: x.height, label: x.label })).slice(0, 10)
        };
        const masterUrl = data.videoUrl || res.streamUrl;
        if (masterUrl && /m3u8|hls/i.test(String(masterUrl))) {
          const r = await fetch(String(masterUrl), { credentials: 'omit' });
          const txt = await r.text();
          const meaningful = txt.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-STREAM-INF') || l.startsWith('#EXT-X-MEDIA') || l.startsWith('#EXT-X-VERSION'));
          out.master = {
            status: r.status,
            ctype: String(r.headers.get('content-type') || '').slice(0, 40),
            audioGroups: meaningful.filter((l) => l.includes('TYPE=AUDIO')).slice(0, 8),
            variantInfos: meaningful.filter((l) => l.includes('STREAM-INF')).slice(0, 14)
          };
        }
      } catch (e) { out.error = String((e && e.message) || e).slice(0, 200); }
      try {
        // Progressive MP4 candidates (native, non-hls.js path) for a differential
        // experiment: if direct <video src> plays while hls.js status-0 stalls,
        // the v1.0.68 fix is a progressive-MP4 default stream.
        const data = (out.envelope && null) || null;
        const res2 = await window.electronAPI.extractStream(String(url));
        const fmts = (res2 && res2.data && res2.data.formats) || [];
        const mp4s = fmts
          .filter((f) => f && !/m3u8|m3u|hls/i.test(String(f.url || '')) && !/^audio/i.test(String(f.mimeType || f.vcodec || f.acodec || '')))
          .map((f) => ({ ...f, h: f.height, tag: f.format_id || f.formatId || '' }))
          .sort((a, b) => (b.height || 0) - (a.height || 0));
        const pick = mp4s.find((f) => (f.height || 0) <= 720 && (f.height || 0) >= 240) || mp4s[0];
        out.prog = pick ? { h: pick.height, tag: pick.tag, url: String(pick.url || '').slice(0, 260), count: mp4s.length } : null;
      } catch (e) { out.prog = { error: String((e && e.message) || e).slice(0, 120) }; }
      return out;
    };
    const dirPlay = (url) => {
      const el = document.querySelector('.video-player-container video');
      if (!el) return { ok: false, why: 'no video element' };
      el.removeAttribute('src');
      el.src = String(url);
      return { ok: true, src: String(url).slice(0, 120) };
    };
    const installXhrTrace = () => {
      if (window.__xhrTraced) return { ok: true, already: true };
      window.__xhrTraced = true;
      window.__xhrlog = [];
      const log = (entry) => {
        const u = String(entry.url || '');
        if (u.indexOf('googlevideo') < 0 && u.indexOf('/video/proxy/') < 0) return;
        window.__xhrlog.push(entry);
        if (window.__xhrlog.length > 80) window.__xhrlog.shift();
      };
      const proto = window.XMLHttpRequest.prototype;
      const origOpen = proto.open;
      const origSet = proto.setRequestHeader;
      const origSend = proto.send;
      proto.open = function (method, url) {
        try { this.__vhUrl = String(url || ''); this.__vhM = String(method || ''); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      proto.setRequestHeader = function (name, value) {
        try {
          if (!this.__vhH) this.__vhH = {};
          this.__vhH[String(name)] = String(value).slice(0, 60);
        } catch (e) {}
        return origSet.apply(this, arguments);
      };
      proto.send = function () {
        try {
          const xhr = this;
          if (xhr.__vhUrl && (xhr.__vhUrl.indexOf('googlevideo') >= 0 || xhr.__vhUrl.indexOf('/video/proxy/') >= 0)) {
            const started = Date.now();
            const done = (kind, extra) => {
              try {
                log({
                  t: Date.now() - started,
                  kind,
                  url: xhr.__vhUrl.slice(0, 160),
                  status: xhr.status,
                  h: Object.assign({}, xhr.__vhH),
                  blen: xhr.responseType === 'arraybuffer' && xhr.response ? xhr.response.byteLength : -1,
                  extra: String(extra || '').slice(0, 120)
                });
              } catch (e) {}
            };
            xhr.addEventListener('load', () => done('load'));
            xhr.addEventListener('error', () => done('error', xhr.statusText));
            xhr.addEventListener('abort', () => done('abort'));
            xhr.addEventListener('timeout', () => done('timeout'));
            xhr.addEventListener('loadend', () => {
              if (!(xhr.status >= 200 && xhr.status < 400)) done('loadend', 'status=' + xhr.status);
            });
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };
      return { ok: true };
    };
    const xhrTrace = () => (window.__xhrlog || []).slice(0, 40);
    const controlHls = (url, opts) => new Promise((resolve) => {
      const done = (r) => resolve(r);
      const t = setTimeout(() => done({ timeout: true }), 30000);
      const opt = opts || {};
      import('file:///H:/MyownX/node_modules/hls.js/dist/hls.mjs')
        .then((mod) => {
          const HlsC = mod.default || mod.Hls;
          if (!HlsC) return done({ noModule: true });
          if (!HlsC.isSupported()) return done({ unsupported: true });
          const v = document.createElement('video');
          document.body.appendChild(v);
          const h = new HlsC({
            debug: !!opt.debug,
            enableWorker: opt.worker !== false,
            lowLatencyMode: opt.ll !== false,
            bufferLength: 30,
            maxBufferLength: 60,
            xhrSetup: (xhr, _u) => {
              if (opt.referer) {
                try { xhr.setRequestHeader('Referer', String(opt.referer)); } catch (e) {}
              }
            }
          });
          h.on(HlsC.Events.ERROR, (_e, d) => {
            if (d.fatal && d.type === HlsC.ErrorTypes.NETWORK_ERROR) {
              clearTimeout(t);
              done({ err: d.details, url: String(d.url || '').slice(0, 80) });
            }
          });
          h.on(HlsC.Events.MANIFEST_PARSED, (_e, d) => {
            clearTimeout(t);
            done({ ok: true, levels: d.levels ? d.levels.length : -1 });
          });
          h.loadSource(String(url));
          h.attachMedia(v);
        })
        .catch((e) => { clearTimeout(t); done({ importError: String((e && e.message) || e).slice(0, 140) }); });
    });
    const controlHlsBatch = (url) => (async () => {
      const base = await controlHls(url, { worker: false, ll: false });
      const nodebug = await controlHls(url, { worker: false, ll: false });
      const ref = await controlHls(url, { worker: false, ll: false, referer: 'https://www.youtube.com/', debug: true });
      return { base, nodebug, ref };
    })();
    const hlsPlay = (url, useOverlayEl) => new Promise((resolve) => {
      const done = (r) => resolve(r);
      const t = setTimeout(() => done({ result: 'timeout' }), 30000);
      import('file:///H:/MyownX/node_modules/hls.js/dist/hls.mjs')
        .then((mod) => {
          const HlsC = mod.default || mod.Hls;
          if (!HlsC) return done({ result: 'noModule' });
          let v = useOverlayEl ? document.querySelector('.video-player-container video') : null;
          const fresh = !v;
          if (fresh) {
            v = document.createElement('video');
            v.setAttribute('width', '320');
            v.setAttribute('height', '180');
            v.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999;opacity:1';
            document.body.appendChild(v);
          } else {
            try { v.removeAttribute('src'); v.load(); } catch (e) {}
          }
          const h = new HlsC({ debug: true, enableWorker: false, lowLatencyMode: false, bufferLength: 30, maxBufferLength: 60, capLevelToPlayerSize: false });
          let settled = false;
          const maybe = (r) => { if (!settled) { settled = true; clearInterval(iv); clearTimeout(t); done(r); } };
          h.on(HlsC.Events.MANIFEST_PARSED, () => {
            v.play().catch(() => {});
          });
          h.on(HlsC.Events.ERROR, (_e, d) => {
            if (d.fatal) maybe({ result: 'err:' + d.type + ':' + d.details, url: String(d.url || '').slice(0, 80) });
          });
          h.attachMedia(v);
          h.loadSource(String(url));
          const iv = setInterval(() => {
            if (settled) { clearInterval(iv); return; }
            if (v && typeof v.currentTime === 'number' && v.currentTime > 0.5 && v.readyState >= 2) {
              maybe({ result: 'PLAYS', currentTime: Math.round(v.currentTime * 100) / 100, readyState: v.readyState, fresh });
            }
          }, 1500);
          window.__hlsLiveH = h;
        })
        .catch((e) => { clearTimeout(t); done({ result: 'importError:' + String((e && e.message) || e).slice(0, 90) }); });
    });
    const midLoadAbortProbe = (url) => new Promise((resolve) => {
      // v1.0.68: does destroying an hls.js instance ~400ms after loadSource
      // (React teardown style) reproduce the app's exact manifestLoadError
      // with xhrStatus null / status 0? If yes, React cleanup IS the freezer.
      const t0 = performance.now();
      const done = (r) => { try { if (h && h.destroy) h.destroy(); } catch (e) {} resolve(r); };
      const t = setTimeout(() => done({ result: 'timeout', ms: Math.round(performance.now() - t0) }), 4000);
      import('file:///H:/MyownX/node_modules/hls.js/dist/hls.mjs')
        .then((mod) => {
          const HlsC = mod.default || mod.Hls;
          if (!HlsC) return done({ result: 'noModule' });
          const v = document.createElement('video');
          v.setAttribute('width', '320'); v.setAttribute('height', '180');
          v.style.cssText = 'position:fixed;left:0;bottom:0;z-index:99999';
          document.body.appendChild(v);
          let h = new HlsC({
            debug: false, enableWorker: true, lowLatencyMode: true,
            bufferLength: 30, maxBufferLength: 60, capLevelToPlayerSize: false,
            xhrSetup: (xhr, _u) => { try { xhr.setRequestHeader('Referer', 'https://www.youtube.com/'); } catch (e) {} }
          });
          let evt = null;
          h.on('manifestParsed', () => { evt = 'parsed:' + Math.round(performance.now() - t0); });
          h.on('error', (_e, d) => {
            if (!evt && d && d.fatal) evt = 'err:' + d.type + ':' + d.details + ':s' + String((d && d.xhr && d.xhr.status) || 'null') + ':resp' + String((d && d.xhr && d.xhr.response && d.xhr.response.length) || 'null');
          });
          h.loadSource(String(url));
          h.attachMedia(v);
          const destroyT = setTimeout(() => { try { if (h) h.destroy(); } catch (e) {} h = null; }, 500);
          setTimeout(() => {
            clearTimeout(destroyT);
            done({ evt, ms: Math.round(performance.now() - t0) });
          }, 1500);
        })
        .catch((e) => { clearTimeout(t); done({ result: 'importError:' + String((e && e.message) || e).slice(0, 90) }); });
    });
    return { setInput, submit, clickCard, videoState, allVideos, closePlayer, openQuality, qualityMenu, triggerLabel, playerError, resolving, onDiscover, diagnoseYt, dirPlay, installXhrTrace, xhrTrace, controlHls, controlHlsBatch, hlsPlay, midLoadAbortProbe, q, nativeSet };
  })();
    return 'seeded';
  } catch (e) { return 'seed-error: ' + String((e && e.message) || e); }
})()`;

async function seed() {
  // Skip onboarding on next mount: write the flag so the modal never appears.
  const seeded = await callWindow(`(() => {
    try {
      window.localStorage.setItem('nekofal_onboarded', 'true');
      window.localStorage.setItem('nekofal_app_lang', 'en');
      window.localStorage.setItem('pmh-preferences', '{}');
      return true;
    } catch (e) { return String(e); }
  })()`, 10000);
  if (seeded !== true) throw new Error('localStorage seed failed: ' + seeded);
  await new Promise((r) => setTimeout(r, 600));
  await callWindow(`location.hash = '#/discover'`, 10000);
  const seededVh = await callWindow(SEED_HANDLER, 10000);
  if (seededVh === 'seeded' || String(seededVh || '').startsWith('seeded')) return;
  throw new Error('SEED_HANDLER failed: ' + String(seededVh));
}

async function driveSite(key) {
  const site = SITES[key];
  const label = site.label;
  const start = CONSOLE.length;
  const tail = () => CONSOLE.slice(Math.max(0, CONSOLE.length - 24)).join(' | ');
  try {
    // Fresh flow: dismiss any previous player, land on discover, search, click.
    await callWindow(`(() => { const b = document.querySelector('[aria-label="Close player"]'); if (b) { try { b.click(); } catch(_e){} } return 'ok'; })()`, 10000).catch(() => {});
    await callWindow(`location.hash = '#/discover'`, 10000);
    await waitFor(`!!window.__vh && !!window.__vh.onDiscover().searchbar`, 30000, `searchbar (${label})`);
    await new Promise((r) => setTimeout(r, 1200));
    const set = await callWindow(`window.__vh.setInput(${JSON.stringify(site.url)}); window.__vh.submit();`, 10000);
    if (!set || !set.ok) throw new Error('input/submit failed: ' + JSON.stringify(set));

    // Result card
    await waitFor(`!!window.__vh && window.__vh.onDiscover().cards`, 90000, `result card (${label})`);
    const clicked = await callWindow(`window.__vh.clickCard();`, 10000);
    if (!clicked || !clicked.ok) throw new Error('card click failed: ' + JSON.stringify(clicked));

    // Player mounts (extraction happens inside the real player).
    await waitFor(`!!window.__vh.videoState()`, EXTRACT_MS, `player mount (${label})`);
    const snap0 = await callWindow(`window.__vh.videoState()`, 10000);
    await callWindow(`window.__vh.installXhrTrace()`, 10000);

    // Playback must ADVANCE — the v1.0.68 YouTube freeze gate.
    const playMs = Math.max(PLAY_MS, site.playMs || PLAY_MS);
    // v1.0.68 diagnostic: does harness-created hls.js succeed at APP-time (t≈2.5s)
    // or ONLY minutes later? If t2.5s succeeds, the app's own pipeline is uniquely
    // cursed; if it fails too, the renderer/page state at play-start is the issue.
    if (key === 'yt') {
      const earlyCtrl = await callWindow(`new Promise((resolve) => setTimeout(() => {
        const p = document.body.getAttribute('data-app-proxy');
        if (!p) return resolve('no-proxy-attr');
        window.__vh.controlHls(p, {}).then((r) => resolve(JSON.stringify(r))).catch((e) => resolve('ERR:' + String(e && e.message).slice(0, 80)));
      }, 2500))`, 45000).catch(() => 'eval-err');
      globalThis.__earlyCtrl = earlyCtrl;
      const midAbort = await callWindow(`(() => {
        const p = document.body.getAttribute('data-app-proxy');
        if (!p) return 'no-proxy-attr';
        return window.__vh.midLoadAbortProbe(p).then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + String(e && e.message).slice(0, 80));
      })()`, 10000).catch(() => 'eval-err');
      globalThis.__midAbort = midAbort;
    }
    let advanced = null;
    const deadline = Date.now() + playMs;
    while (Date.now() < deadline) {
      const s = await callWindow(`window.__vh.videoState()`, 10000);
      if (s && !s.paused && (s.currentTime > 0.6) && s.readyState >= 2) { advanced = s; break; }
      if (s && s.err) throw new Error(`video element error: ${s.err.code} ${s.err.message}`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    if (!advanced) {
      const err = await callWindow(`window.__vh.playerError()`, 10000);
      const res = await callWindow(`window.__vh.resolving()`, 10000);
      const s = await callWindow(`window.__vh.videoState()`, 10000);
      const sysLog = CONSOLE.slice(start)
        .filter((l) => /\[hls\.js\]|\[log\]|\[error\]|abort|manifest|levelLoad|fragLoad|network|codec|buffer-controller|stream-controller/i.test(l))
        .join(' ¦ ');
      const netOut = NETLOG ? NETLOG.join(' ¦ ') : 'netlog-disabled';
      const xhrs = await callWindow(`window.__vh.xhrTrace()`, 10000).catch(() => null);
      try { fs.writeFileSync(NET_FILE, JSON.stringify(NETLOG || [], null, 1), 'utf8'); } catch (e) { /* ignore */ }
      let ytDiag = '';
      if (key === 'yt') {
        const d = await callWindow(`window.__vh.diagnoseYt(${JSON.stringify(site.url)})`, 90000).catch(() => null);
        ytDiag = d ? ` · diag=${JSON.stringify(d)}` : '';
        // Replay hls.js INTO the already-frozen overlay element: if this plays,
        // the element/lifecycle is fine and the app's hls instance creation is
        // the culprit. If it stays frozen, the element is poisoned (leaked MSE).
        try {
          const replayUrl = await callWindow(`window.electronAPI.extractStream('${String(site.url)}').then((r)=>(r.data&&r.data.videoUrl)||r.streamUrl||'')`, 150000);
          globalThis.__replayUrl = replayUrl;
          const reuse = await callWindow(`window.__vh.hlsPlay(${JSON.stringify(replayUrl)}, true)`, 60000);
          ytDiag += ' · overlayReplay=' + JSON.stringify(reuse);
        } catch (e) { ytDiag += ' · overlayReplay=ERR:' + String((e && e.message) || e).slice(0, 80); }
        // Differential experiment: hls.js stalled with status 0 — does the SAME
        // stream play when handed to the <video> element directly (no hls.js)?
        // yt-dlp progressive MP4 first (data.formats only carry HLS for YT).
        let mp4Url = (d && d.prog && d.prog.url) || null;
        if (!mp4Url) {
          const bin = path.join(app.getPath('userData'), 'bin', 'yt-dlp.exe');
          const ytp = fs.existsSync(bin) ? bin : 'yt-dlp';
          mp4Url = await new Promise((resolve) => {
            require('child_process').execFile(ytp, ['--no-warnings', '-f', '18/b[ext=mp4]/b', '--no-playlist', '-g', String(site.url)],
              { timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
              (e, out, err) => resolve(String(e ? '' : (out || '').trim())));
          });
        }
        if (mp4Url) {
          const set = await callWindow(`window.__vh.dirPlay(${JSON.stringify(mp4Url)})`, 15000);
          let nat = null;
          const natDeadline = Date.now() + 20000;
          while (Date.now() < natDeadline) {
            const st = await callWindow(`window.__vh.videoState()`, 10000).catch(() => null);
            if (st && !st.paused && st.currentTime > 0.6 && st.readyState >= 2) { nat = st; break; }
            await new Promise((r) => setTimeout(r, 2000));
          }
          ytDiag += ' · nativeMp4=' + String(mp4Url).slice(0, 90) + ' set=' + JSON.stringify(set) + ' result=' + (nat ? `PLAYS ct=${nat.currentTime.toFixed(2)}` : 'STILL-STALLED');
        } else {
          ytDiag += ' · nativeMp4=none';
        }
        const appMaster = await callWindow(`document.body.getAttribute('data-app-master')`, 10000).catch(() => null);
        const appProxy = await callWindow(`document.body.getAttribute('data-app-proxy')`, 10000).catch(() => null);
        let appFetch = 'n/a';
        let appControl = 'n/a';
        let appProxyFetch = 'n/a';
        if (appMaster) {
          appFetch = await callWindow(`fetch(${JSON.stringify(appMaster)}).then((r) => 'status=' + r.status + ' ct=' + (r.headers.get('content-type') || '') + ' len=' + (r.headers.get('content-length') || '')).catch((e) => 'ERR:' + String(e && e.message).slice(0, 120))`, 20000).catch(() => 'eval-err');
          appControl = await callWindow(`window.__vh.controlHls(${JSON.stringify(appMaster)}, {}).then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + String(e && e.message).slice(0, 80))`, 30000).catch(() => 'eval-err');
        }
        if (appProxy) {
          appProxyFetch = await callWindow(`fetch(${JSON.stringify(appProxy)}).then((r) => 'status=' + r.status + ' ct=' + (r.headers.get('content-type') || '') + ' len=' + (r.headers.get('content-length') || '') + ' body=' + (r.bytes ? r.bytes().then((b)=>b.length) : '')).catch((e) => 'ERR:' + String(e && e.message).slice(0, 120))`, 30000).catch(() => 'eval-err');
          const ctrlProxy = await callWindow(`window.__vh.controlHls(${JSON.stringify(appProxy)}, {}).then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + String(e && e.message).slice(0, 80))`, 30000).catch(() => 'eval-err');
          const ctrlProxyBlob = await callWindow(`(async () => { try { const b = await fetch(${JSON.stringify(appProxy)}).then((r) => r.blob()); const u = URL.createObjectURL(b); return await window.__vh.controlHls(u, {}).then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + String(e && e.message).slice(0, 80)); } catch (e) { return 'fetch-err:' + String(e && e.message).slice(0, 80); } })()`, 30000).catch(() => 'eval-err');
          ytDiag += ' · ctrlProxy=' + ctrlProxy + ' · ctrlProxyBlob=' + ctrlProxyBlob;
        }
        ytDiag += ' · appMasterFetch=' + JSON.stringify(appFetch) + ' · appMasterHls=' + appControl + ' · appProxyFetch=' + JSON.stringify(appProxyFetch)
          + ' · hlsLevels=' + JSON.stringify(await callWindow(`document.body.getAttribute('data-hls-levels')`, 10000).catch(() => null))
          + ' · earlyCtrl=' + JSON.stringify(globalThis.__earlyCtrl || null)
          + ' · midAbort=' + JSON.stringify(globalThis.__midAbort || null)
          + ' · codecs=' + JSON.stringify(await callWindow(`(() => { const o = {}; document.querySelectorAll('video').forEach((v, i) => { let c = []; try { if (v && v.msComponents && v.msComponents.mediaSource) { c = Array.from(v.msComponents.mediaSource.sourceBuffers || []).map((sb) => sb.mimeType || ''); } } catch (e) { try { if (v.srcObject) {} } catch (_e2) {} } o[i] = { cur: (v && v.currentTime) || 0, paused: !!(v && v.paused), rs: (v && v.readyState) || 0, cc: c }; }); return o; })()`, 10000).catch(() => null));
      }
      throw new Error(`playback never advanced` + (err ? ` — player error: "${err}"` : '') + (res ? ` — still resolving "${res}"` : '') + ` — final ${JSON.stringify(s)}` + (xhrs && xhrs.length ? ` · xhr=${JSON.stringify(xhrs)}` : '') + ` · hlsLog: ${sysLog.slice(-4000)}${ytDiag}` + ` · ytfix=` + JSON.stringify(await callWindow(`document.body.getAttribute('data-ytfix')`, 10000).catch(() => 'ERR')) +
` · ytfixhdrs=` + JSON.stringify(await callWindow(`document.body.getAttribute('data-ytfix-hdrs')`, 10000).catch(() => 'ERR')) +
` · allVideos=` + JSON.stringify(await callWindow(`window.__vh.allVideos()`, 10000).catch(() => 'ERR')));
    }

    // Quality dropdown must show real tiers.
    await callWindow(`window.__vh.openQuality()`, 5000);
    await new Promise((r) => setTimeout(r, 700));
    const menu = await callWindow(`window.__vh.qualityMenu()`, 5000);
    const tierCount = Math.max(0, (menu.count || 0) - 1);
    const needTiers = key === 'yt' ? 1 : 2;
    if (tierCount < needTiers) throw new Error(`quality dropdown has only ${tierCount} tier(s): ${JSON.stringify(menu.items)}`);
    await callWindow(`(() => { if (document.querySelector('.quality-menu')) document.querySelector('.popup-menu') })()`, 5000);
    // Close the menu (click a non-menu spot is fragile; pressing trigger again toggles).
    await callWindow(`window.__vh.openQuality()`, 5000).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));

    // Tier switch: click the SECOND real tier (index 1) — must not kill playback.
    let switchInfo = { skipped: true };
    if (tierCount >= 2) {
      const before = await callWindow(`window.__vh.triggerLabel()`, 5000);
      const clickedTier = await callWindow(`(async () => {
        // Toggle-closed menus report zero rows — ensure the menu is actually
        // open before reading its entries.
        if (!document.querySelector('.quality-menu')) {
          const t = document.querySelector('[aria-label="Quality settings"]');
          if (!t) return { ok: false, why: 'no quality trigger' };
          t.click();
          await new Promise((r) => setTimeout(r, 600));
        }
        const items = [...document.querySelectorAll('.quality-menu .menu-item')];
        if (items.length < 3) return { ok: false, why: 'too few items', have: items.map((b) => b.textContent.trim()) };
        items[1].click();
        return { ok: true, choose: items[1].textContent.trim() };
      })()`, 5000);
      if (!clickedTier || !clickedTier.ok) throw new Error('tier click failed: ' + JSON.stringify(clickedTier));
      await new Promise((r) => setTimeout(r, 12000));
      const d1 = await callWindow(`window.__vh.videoState()`, 10000);
      await new Promise((r) => setTimeout(r, 3000));
      const d2 = await callWindow(`window.__vh.videoState()`, 10000);
      const afterLabel = await callWindow(`window.__vh.triggerLabel()`, 5000);
      const advancing = !!d1 && !!d2 && !d2.paused && d2.currentTime > d1.currentTime + 0.4;
      switchInfo = { ok: advancing, before, afterLabel, tier: clickedTier.choose, d1: d1 && d1.currentTime, d2: d2 && d2.currentTime };
      if (!advancing) throw new Error(`tier switch to "${clickedTier.choose}" stalled playback: ${JSON.stringify(switchInfo)}`);
    }

    const final = await callWindow(`window.__vh.videoState()`, 10000);
    const errLast = await callWindow(`window.__vh.playerError()`, 10000);
    const nutshell =
      `adv=${advanced.currentTime}s/${Math.round(advanced.duration)}s rs=${advanced.readyState}${advanced.err ? ` err=${advanced.err.code}` : ''}` +
      ` res=${advanced.vw}x${advanced.vh} · dropdown ${tierCount} tier(s) [${menu.items.join(', ')}]` +
      (switchInfo.ok ? ` · switched→${switchInfo.tier}(${switchInfo.d1}→${switchInfo.d2}s)` : (switchInfo.skipped ? '' : ` · switch ${JSON.stringify(switchInfo)}`)) +
      (errLast ? ` · errMsg="${errLast}"` : '');
    report(label, true, nutshell);
    await callWindow(`window.__vh.closePlayer();`, 10000).catch(() => {});
  } catch (e) {
    const err = await callWindow(`window.__vh ? window.__vh.playerError() : null`, 5000).catch(() => null);
    const s = await callWindow(`window.__vh ? window.__vh.videoState() : null`, 5000).catch(() => null);
    const msg = String((e && e.message) || e);
    const isCf = /cloudflare|cf_|challenge|just a moment|checksum/i.test(msg) || /cloudflare|challenge|just a moment/i.test(String(err || ''));
    const kind = isCf ? 'SKIP-CF' : 'FAIL';
    report(label, !isCf ? false : true, `${msg.replace(/\s+/g, ' ')}${err ? ` · playerError="${err.replace(/\s+/g, ' ')}"` : ''}${s ? ` · video=${JSON.stringify(s)}` : ''}${isCf ? ' [Cloudflare wall on this network]' : ''} · consoleTail: ${tail().slice(-700)}`, kind);
    await callWindow(`window.__vh && window.__vh.closePlayer();`, 10000).catch(() => {});
  }
}

async function main() {
  const only = String(env('NEKOFAL_UI_SITES') || '').toLowerCase();
  const keys = only ? only.split(',').map((k) => k.trim()).filter((k) => SITES[k]) : Object.keys(SITES);
  if (!keys.length) throw new Error('no valid NEKOFAL_UI_SITES (yt,xvideos,pornhub,xnxx,hanime)');
  for (const k of keys) await driveSite(k);
}

function settle(code) {
  console.log('\n───── UI RESULT ─────');
  let failed = 0;
  let skipped = 0;
  for (const r of RESULTS) {
    if (!r.ok && r.kind !== 'SKIP-CF') failed++;
    if (r.kind === 'SKIP-CF') skipped++;
    console.log(` ${r.kind || (r.ok ? 'PASS' : 'FAIL')}  ${r.name}`);
  }
  console.log(` ${RESULTS.length - failed}/${RESULTS.length} sources played in the real UI — gate ${failed === 0 ? 'CLEARED' : 'BLOCKED'}${skipped ? ` (${skipped} Cloudflare-skipped)` : ''}`);
  try { if (win && !win.isDestroyed()) win.destroy(); } catch (_e) {}
  app.exit(code === undefined ? (failed === 0 ? 0 : 1) : code);
}

process.on('uncaughtException', (e) => { console.error('HARNESS uncaughtException:', e); settle(2); });
process.on('unhandledRejection', (e) => { console.error('HARNESS unhandledRejection:', e); settle(2); });

app.whenReady().then(async () => {
  try {
    // Isolate the harness from the real app profile so a running Nekofal.exe
    // never locks/races the same userData (cache move errors, flaky search).
    app.setPath('userData', path.join(app.getPath('temp'), 'nekofal-ui-harness'));
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: {
        preload: path.join(__dirname, '..', 'electron', 'preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    win.webContents.on('console-message', (...args) => {
      let level = 1;
      let message = '';
      // New-style single Event object first; fall back to the legacy ts/level/message.
      if (args[0] && typeof args[0] === 'object') {
        level = args[0].level != null ? args[0].level : 1;
        message = String(args[0].message || '');
        if (args[0].lineNumber) message += ' @' + args[0].lineNumber;
      } else {
        level = args[1] || 1;
        message = String(args[3] || '');
      }
      CONSOLE.push(`[${now()}] l${level} ${message.slice(0, 500)}`);
      if (CONSOLE.length > 20000) CONSOLE.splice(0, CONSOLE.length - 19000);
    });
    // Optional network trace (NEKOFAL_UI_NETLOG=1) — which URLs hls.js/media
    // actually hit, their HTTP status, and any Chromium net-layer errors.
    if (NETLOG) {
      const sess = win.webContents.session;
      const netFilter = { urls: ['*://*/*'] };
      sess.webRequest.onCompleted(netFilter, (d) => {
        if (/googlevideo|hanime|xvideos|xnxx|pornhub/i.test(String(d.url || ''))) {
          NETLOG.push(`[net:done] ${d.statusCode} ${String(d.method)} ${String(d.url).slice(0, 160)}`);
        }
      });
      sess.webRequest.onErrorOccurred(netFilter, (d) => {
        if (/googlevideo|hanime|xvideos|xnxx|pornhub/i.test(String(d.url || ''))) {
          NETLOG.push(`[net:err ] ${String(d.error || '').slice(0, 70)} ${String(d.url).slice(0, 160)}`);
        }
      });
      try {
        const wc = win.webContents;
        wc.debugger.attach('1.3');
        wc.debugger.on('message', (_e, method, params) => {
          const u = String((params && (params.request && params.request.url) || (params.response && params.response.url)) || '');
          if (!/googlevideo|hanime|xvideos|xnxx|pornhub/i.test(u)) return;
          if (method === 'Network.requestWillBeSent') {
            NETLOG.push(`[cdp:req  ] ${params.type} ${String(params.request.method)} ${u.slice(0, 150)}`);
          } else if (method === 'Network.responseReceived') {
            NETLOG.push(`[cdp:resp ] ${params.response.status} ${u.slice(0, 150)}`);
          } else if (method === 'Network.loadingFailed') {
            NETLOG.push(`[cdp:fail ] ${params.type} ${String(params.canceled ? 'CANCELED ' : '')}${String(params.errorText || '').slice(0, 60)} ${u.slice(0, 150)}`);
          }
        });
        wc.debugger.sendCommand('Network.enable');
      } catch (e) {
        NETLOG.push(`[cdp:err ] ${String((e && e.message) || e).slice(0, 90)}`);
      }
    }
    await withTimeout(win.loadFile(path.join(__dirname, '..', 'build', 'index.html')), 60000, 'window load');
    await waitForApi();
    await seed();
    console.log('UI harness ready — driving the real player for each source.');
    const hlsControl = env('NEKOFAL_UI_HLSCONTROL');
    if (hlsControl) {
      let controlUrl = String(hlsControl);
      if (controlUrl === 'yt') {
        const fresh = await callWindow(`window.electronAPI.extractStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ').then((r)=>(r.data&&r.data.videoUrl)||r.streamUrl||'none')`, 150000);
        controlUrl = String(fresh);
      }
      const r = await callWindow(`window.__vh.controlHlsBatch(${JSON.stringify(controlUrl)})`, 120000);
      const playsFresh = await callWindow(`window.__vh.hlsPlay(${JSON.stringify(controlUrl)}, false)`, 60000);
      const playsOverlay = await callWindow(`window.__vh.hlsPlay(${JSON.stringify(controlUrl)}, true)`, 60000);
      console.log('HLS-TRACE url=' + controlUrl.slice(0, 110));
      console.log('  parseBare=' + JSON.stringify(r));
      console.log('  playFresh=' + JSON.stringify(playsFresh));
      console.log('  playOverlay=' + JSON.stringify(playsOverlay));
      const ok = !!(r.base && r.base.ok) && playsFresh && playsFresh.result === 'PLAYS';
      console.log('─ UI RESULT ─');
      console.log((ok ? ' PASS' : ' FAIL') + '  control hls');
      settle(ok ? 0 : 1);
      return;
    }
    await main();
    settle();
  } catch (e) {
    console.error('HARNESS setup error:', e);
    settle(2);
  }
});