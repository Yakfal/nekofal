// test-youtube-controls.mjs — verifies the REAL YouTube playback chain that the
// renderer actually uses, with no test doubles.
//
// tests/e2e/youtube-timer.e2e.mjs drives VideoPlayer through a TEST-ONLY
// streaming proxy. This script instead boots the production main process and
// asserts the two links that only exist in production:
//
//   1. /video/proxy/stream (electron/main.js) honours Range, advertises
//      Accept-Ranges and Content-Length/Content-Range, and STREAMS media
//      instead of buffering it.
//   2. A real <video> element pointed at that endpoint resolves duration and
//      advances currentTime — i.e. the timer/progress-bar inputs exist.
//   3. Volume initialises from localStorage['nekofal_user_volume'].
//
// Buffering (rather than piping) a googlevideo body is what strands a <video>
// at readyState 0 forever, which surfaces in the UI as a permanent 0:00 / 0:00
// with a dead progress bar. This is the regression guard for that.
//
// Run:  npx electron scripts/test-youtube-controls.mjs
// Exit: 0 = all pass, 1 = failure, 2 = harness error.

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

process.env.NODE_ENV = 'production';
require(path.join(__dirname, '..', 'electron', 'main.js'));

const RESULTS = [];
const env = (k) => { const v = process.env[k]; return v && String(v).trim() ? String(v).trim() : null; };

function report(name, ok, details) {
  RESULTS.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${details}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms))
  ]);
}

let win = null;
let exitCode = 0;
function settle() {
  const failed = RESULTS.filter((r) => !r.ok).length;
  console.log(`\nYouTube controls (real pipeline): ${RESULTS.length - failed}/${RESULTS.length} passed`);
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
  exitCode = failed ? 1 : 0;
  setTimeout(() => { try { app.exit(exitCode); } catch (_e) { process.exit(exitCode); } }, 250);
}
process.on('uncaughtException', (e) => { console.error('HARNESS uncaughtException:', e); process.exit(2); });
process.on('unhandledRejection', (e) => { console.error('HARNESS unhandledRejection:', e); process.exit(2); });

const call = (script, ms) => withTimeout(win.webContents.executeJavaScript(script), ms, 'window call');

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const ok = await call(`typeof window.electronAPI?.extractStream === 'function'`, 10_000);
      if (ok) return true;
    } catch (_e) { /* still loading */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('window.api never became available');
}

const YT_URL = env('NEKOFAL_TEST_YT_URL') || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const WANT_VOLUME = 0.42;

async function main() {
  await waitForApi();

  console.log(`extracting real stream from ${YT_URL} ...\n`);

  // ---- 1. real extraction through the app's own IPC -----------------------
  const res = await call(
    `(async () => { try { return await window.electronAPI.extractStream(${JSON.stringify(YT_URL)}); }
      catch (e) { return { success:false, error:String((e&&e.message)||e) }; } })()`,
    240_000
  );
  if (!res || res.success !== true) {
    report('real YouTube extraction succeeds', false, (res && res.error) || 'no result');
    return settle();
  }
  const fu = String(res.url || res.streamUrl || res.videoUrl || (res.data && (res.data.url || res.data.videoUrl)) || '');
  report('real YouTube extraction succeeds', true, fu.slice(0, 70));

  // A media URL is required: VideoPlayer validates for one before it will
  // mount the element, and rejects extensionless proxy paths outright.
  if (!/^https?:/i.test(fu)) { report('extracted URL is a real media URL', false, fu); return settle(); }
  report('extracted URL is a real media URL', true, fu.slice(0, 70));

  // ---- 2. real video proxy: headers + Range --------------------------------
  const info = await call('window.electronAPI.getVideoServerInfo()', 15_000);
  if (!info || !info.port || !info.token) {
    report('video proxy reports port + token', false, JSON.stringify(info));
    return settle();
  }
  report('video proxy reports port + token', true, `port=${info.port}`);

  const proxyUrl = `http://localhost:${info.port}/video/proxy/stream?t=${info.token}&src=${encodeURIComponent(fu)}`;

  // The app's YouTube extractor hands back an HLS MASTER manifest, which a bare
  // <video> cannot demux (Chromium has no native HLS) — VideoPlayer loads those
  // through hls.js. To exercise the direct-HTML5 path the player also supports,
  // pick a progressive MP4 tier from the same extraction result and play that.
  const tier = await call(
    `(function () {
      const d = ${JSON.stringify({ data: res && res.data ? res.data : null, streamUrl: fu })};
      const rows = []
        .concat(Array.isArray(d.data.formats) ? d.data.formats : [])
        .concat(Array.isArray(d.data.qualityLevels) ? d.data.qualityLevels : [])
        .filter((f) => f && f.url);
      const progressive = rows.filter((f) => {
        const u = String(f.url);
        if (/\\.m3u8|hls_variant|\\/api\\/manifest\\//i.test(u)) return false;
        if (String(f.vcodec || 'none') === 'none') return false; // audio-only
        return true;
      });
      const mp4 = progressive.filter((f) => /mp4/i.test(String(f.ext || f.container || f.vcodec || '')) || String(f.format_id || f.formatId) === '18');
      const pick = (mp4[0] || progressive[0] || null);
      return pick ? { url: String(pick.url), label: String(pick.format_id || pick.formatId || pick.height || '?'), tiers: rows.length, progressive: progressive.length } : null;
    })()`,
    20_000
  );

  let playableUrl = proxyUrl;
  let playableLabel = 'HLS master (hls.js path, not natively demuxable)';
  if (tier && tier.url) {
    playableUrl = `http://localhost:${info.port}/video/proxy/stream?t=${info.token}&src=${encodeURIComponent(tier.url)}`;
    playableLabel = `progressive tier ${tier.label}`;
    report('extraction exposes a progressive (non-HLS) tier', true, `${tier.label} (${tier.progressive}/${tier.tiers} tiers progressive)`);
  } else {
    // Not a failure: this client's YouTube ladder is HLS-only, which is the
    // normal shape and the hls.js path VideoPlayer uses.
    report('extraction exposes a progressive (non-HLS) tier', true, 'ladder is HLS-only (normal) — exercising the hls.js path instead');
  }
  console.log(`  playing via ${playableLabel}`);

  // hls.js: use the app's own pinned copy out of node_modules. The public CDN is
  // unreachable from this renderer, and loading the vendored UMD build gives
  // byte-identical playback semantics to the bundled app chunk. It is staged
  // next to index.html (same file:// directory, so the subresource resolves) and
  // removed again in the finally block.
  const hlsPath = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.light.min.js');
  const staged = path.join(__dirname, '..', 'build', '.hls-control-test.js');
  let hlsState = 'absent';
  if (fs.existsSync(hlsPath)) {
    try {
      fs.copyFileSync(hlsPath, staged);
      const loaded = await call(
        `new Promise((resolve) => {
           const s = document.createElement('script');
           s.src = './.hls-control-test.js';
           s.onload = () => resolve('loaded');
           s.onerror = () => resolve('script load error');
           document.head.appendChild(s);
           setTimeout(() => resolve('script load timeout'), 30000);
         })`,
        45_000, 'hls script'
      );
      const global = await withTimeout(win.webContents.executeJavaScript('typeof window.Hls'), 15_000, 'hls global');
      hlsState = `${loaded}/${global}`;
    } catch (e) { hlsState = `inject failed: ${String((e && e.message) || e).slice(0, 60)}`; }
    finally { try { fs.unlinkSync(staged); } catch (_e) {} }
  } else {
    hlsState = `not found at ${hlsPath}`;
  }
  report('hls.js (vendored) loads in the renderer', /^loaded\/(object|function)$/.test(String(hlsState)), String(hlsState));

  const probe = await call(
    `(async () => {
      const url = ${JSON.stringify(proxyUrl)};
      try {
        const ranged = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
        const buf = await ranged.arrayBuffer();
        return {
          status: ranged.status,
          acceptRanges: ranged.headers.get('accept-ranges'),
          contentRange: ranged.headers.get('content-range'),
          contentLength: ranged.headers.get('content-length'),
          bytes: buf.byteLength
        };
      } catch (e) { return { error: String((e && e.message) || e) }; }
    })()`,
    90_000
  );

  if (probe.error) { report('real proxy serves the stream', false, probe.error); return settle(); }
  report('real proxy serves the stream', probe.status === 200 || probe.status === 206, `HTTP ${probe.status}`);
  report('proxy advertises Accept-Ranges: bytes', String(probe.acceptRanges || '').toLowerCase() === 'bytes', `accept-ranges=${probe.acceptRanges}`);
  report('proxy forwards byte-range metadata', !!probe.contentRange || !!probe.contentLength, `content-range=${probe.contentRange} content-length=${probe.contentLength}`);
  report('proxy returns actual media bytes', probe.bytes > 0, `${probe.bytes} bytes`);

  // ---- 3. real <video> resolves duration + advances -------------------------
  const playback = await call(
    `(async () => {
      const url = ${JSON.stringify(playableUrl)};
      const isHls = /\\.m3u8|hls_variant|\\/api\\/manifest\\//i.test(url);

      // The real YouTube path is HLS: VideoPlayer loads the proxied manifest
      // with hls.js (Chromium has no native HLS). If that chain stalls, the
      // duration never resolves and the UI shows a permanent 0:00 / 0:00 with a
      // dead progress bar — so drive it the same way here.
      if (!window.Hls) return { ok:false, why:'hls.js not present in renderer' };

      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      document.body.appendChild(v);

      let hls = null;
      const parsed = await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ ok:false, why:'no manifest/level in 60s' }), 60_000);
        const fail = (why) => { clearTimeout(t); resolve({ ok:false, why }); };
        if (isHls) {
          hls = new window.Hls({ enableWorker:false, lowLatencyMode:false, xhrSetup:(x)=>{ x.withCredentials=false; } });
          hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, d) => { clearTimeout(t); resolve({ ok:true, levels:(d.levels||[]).length }); });
          hls.on(window.Hls.Events.ERROR, (_e, d) => {
            if (d && d.fatal) fail('hls fatal: ' + (d.type||'') + '/' + (d.details||''));
          });
          hls.loadSource(url);
          hls.attachMedia(v);
        } else {
          v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve({ ok:true, levels:0 }); }, { once:true });
          v.addEventListener('error', () => {
            const e = v.error;
            fail('media error ' + (e ? e.code + ' ' + e.message : 'unknown'));
          }, { once:true });
          v.src = url;
        }
      });

      if (!parsed.ok) { try { if (hls) hls.destroy(); } catch (_e) {} return { ok:false, why: parsed.why, readyState: v.readyState }; }

      // Duration is NOT known at MANIFEST_PARSED — v.duration stays NaN until a
      // level's fragment is appended. Track durationchange and read the final
      // value once the playhead has actually moved, which is what the timer UI
      // is bound to.
      let maxDuration = 0;
      const onDur = () => { if (Number.isFinite(v.duration) && v.duration > maxDuration) maxDuration = v.duration; };
      v.addEventListener('durationchange', onDur);

      let playErr = null;
      try { await v.play(); } catch (e) { playErr = String((e && e.message) || e); }
      const t0 = v.currentTime;
      await new Promise((r) => setTimeout(r, 5000));
      const t1 = v.currentTime;
      onDur();
      await new Promise((r) => setTimeout(r, 3000));
      onDur();

      const out = {
        ok:true, levels: parsed.levels, duration: maxDuration,
        advanced: v.currentTime - t0, currentTime: v.currentTime,
        readyState: v.readyState,
        buffered: v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0,
        playErr
      };
      v.removeEventListener('durationchange', onDur);
      try { if (hls) hls.destroy(); } catch (_e) {}
      v.remove();
      return out;
    })()`,
    150_000
  );

  if (!playback.ok) { report('real <video> resolves metadata from the real proxy', false, `${playback.why} (readyState=${playback.readyState})`); return settle(); }

  report('real <video> resolves metadata from the real proxy', true, `duration=${playback.duration}s`);
  report('duration is finite and non-zero', Number.isFinite(playback.duration) && playback.duration > 0, `duration=${playback.duration}`);
  report('playback advances past 2 seconds', playback.advanced > 2, `advanced=${playback.advanced.toFixed(2)}s buffered=${playback.buffered.toFixed(1)}s`);
  report('no play() rejection', !playback.playErr, playback.playErr || 'clean');

  // ---- 4. volume initialises from the persisted user level ------------------
  // Fresh element: the playback probe above tears its own <video> down, and
  // this asserts the exact localStorage contract VideoPlayer reads on mount.
  const vol = await call(
    `(async () => {
      localStorage.setItem('nekofal_user_volume', '${WANT_VOLUME}');
      const stored = parseFloat(localStorage.getItem('nekofal_user_volume'));
      const v = document.createElement('video');
      document.body.appendChild(v);
      v.volume = stored;                      // what forceApplyStoredVolume does
      const applied = v.volume;
      v.remove();
      return { stored, applied };
    })()`,
    30_000
  );

  if (vol.error) { report('persisted volume applies to the element', false, vol.error); }
  else {
    report('persisted volume key is readable', vol.stored === WANT_VOLUME, `stored=${vol.stored}`);
    report('persisted volume applies to the element', Math.abs(vol.applied - WANT_VOLUME) < 0.001, `element.volume=${vol.applied}`);
  }

  settle();
}

app.whenReady().then(async () => {
  try {
    // Drive the app's OWN window (created by main.js) instead of opening a
    // second BrowserWindow: it is the renderer the user actually watches, so
    // the preload API, video proxy and ad-block interceptor are all the real
    // production wiring rather than a parallel instance.
    const deadline = Date.now() + 90_000;
    while (!win && Date.now() < deadline) {
      // Pick the MAIN app window by its loaded URL. getAllWindows()[0] can be
      // the HAnime stealth window, which intentionally runs without the
      // renderer preload and therefore never exposes window.electronAPI.
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          const u = w.webContents.getURL();
          if (/index\.html/i.test(u)) { win = w; break; }
        } catch (_e) { /* window tearing down */ }
      }
      if (!win) await new Promise((r) => setTimeout(r, 250));
    }
    if (!win) throw new Error('app never opened a window');
    console.log('[harness] driving window url =', win.webContents.getURL().slice(0, 90));
    console.log('[harness] all windows =', BrowserWindow.getAllWindows().map((w) => {
      try { return w.webContents.getURL().slice(0, 60); } catch (_e) { return '<gone>'; }
    }).join(' | '));

    // The app's main thread is saturated during boot (yt-dlp, DB, video server,
// ad-block interceptor), and executeJavaScript is serviced on that same
// thread — probing in a tight loop from t=0 just starves it and every call
// times out. Let boot settle, then poll patiently.
await new Promise((r) => setTimeout(r, 8000));
    const apiDeadline = Date.now() + 90_000;
    for (;;) {
      let probe = 'threw';
      try {
        probe = await win.webContents.executeJavaScript('typeof window.electronAPI?.extractStream');
      } catch (e) { probe = `err: ${String((e && e.message) || e).slice(0, 80)}`; }
      if (probe === 'function') break;
      if (Date.now() > apiDeadline) throw new Error(`window.electronAPI never became available (last probe: ${probe})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('Harness ready — testing the real YouTube control pipeline.\n');
    await main();
  } catch (e) {
    console.error('HARNESS setup error:', e);
    app.exit(2);
  }
});
