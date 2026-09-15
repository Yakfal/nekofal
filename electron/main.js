// Node Web IDL polyfill - prevents "File is not defined" crashes in undici/Axios
if (typeof global.File === 'undefined') {
  const { Blob } = require('buffer');
  global.File = class File extends Blob {
    constructor(buffers, name, options = {}) {
      super(buffers, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const { app, BrowserWindow, ipcMain, session, dialog, shell, globalShortcut, net } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const ytDlpWrap = require('yt-dlp-wrap').default;

// Electron auto-updater (periodic GitHub-based updates). Loaded lazily so a
// dev install without the dependency never crashes the app.
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (e) {
  console.warn('[updater] electron-updater unavailable:', e && e.message);
}

// OS-encrypted credential vault (safeStorage: DPAPI / Keychain).
const credentialVault = require('./credentialVault');

// Nekofal rebrand: keep the OS app identity/name but pin userData to the legacy
// yakfal-hub folder so the local library (media.db), family settings and the
// auto-downloaded yt-dlp binary keep working after the name change.
app.setName('Nekofal');
app.setPath('userData', path.join(app.getPath('appData'), 'yakfal-hub'));

// Nekofal falling-cat icon: at runtime prefer the built copy (build/icon.png,
// which vite copies from public/ on every build), falling back to source.
function appIconPath() {
  const buildIcon = path.join(__dirname, '../build/icon.png');
  if (fs.existsSync(buildIcon)) return buildIcon;
  return path.join(__dirname, '../public/icon.png');
}

// Initialize database with userData path - runs ONLY in main process
let dbModule = null;
let dbInitialized = false;
let dbInitError = null;

async function initializeAppDatabase() {
  try {
    const db = require('../db/database.js');
    db.setUserDataPath(app.getPath('userData'));
    const result = await db.initializeDatabase();
    if (result.success) {
      dbModule = db;
      dbInitialized = true;
      console.log('Database module initialized successfully');
    } else {
      dbInitError = result.error;
      console.error('Database initialization failed:', dbInitError);
    }
  } catch (err) {
    dbInitError = err.message;
    console.error('Failed to load database module:', err);
  }
}

function getDb() {
  if (!dbInitialized) {
    throw new Error('Database not initialized: ' + (dbInitError || 'Unknown error'));
  }
  return dbModule;
}

function getDbSafe() {
  if (!dbInitialized) {
    return { error: 'Database not initialized: ' + (dbInitError || 'Unknown error'), db: null };
  }
  return { db: dbModule };
}

let mainWindow;
let videoServer;
let isReady = false;
let videoServerStarted = false;
let videoServerPort = 5001;
let videoServerBaseUrl = 'http://localhost:5001';

// Floating mini-player (Picture-in-Picture) — a frameless always-on-top window
// that takes over playback so it keeps running while you browse the app or the
// desktop. Playback payload is stored in main and delivered on load.
let miniPlayerWindow = null;
let miniPayload = null;

// Resolve the bundled yt-dlp/ffmpeg binaries.
// Priority for yt-dlp:
//   1. <userData>/bin/yt-dlp.exe   (auto-downloaded latest binary)
//   2. <userData>/yt-dlp.exe       (legacy download location)
//   3. resources/yt-dlp.exe        (bundled with the packaged app via electron-builder)
//   4. 'yt-dlp' on system PATH     (dev only)
// When none of the files exist, getYtDlpPath() returns a download target under
// <userData>/bin so ensureYtDlpBinary() can fetch the latest platform binary.
function getBinDir() {
  return path.join(app.getPath('userData'), 'bin');
}

function userDataBinPath(bin) {
  return path.join(getBinDir(), bin);
}

function getYtDlpPath() {
  const candidates = [
    userDataBinPath('yt-dlp.exe'),
    path.join(app.getPath('userData'), 'yt-dlp.exe')
  ];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'yt-dlp.exe'));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return app.isPackaged ? userDataBinPath('yt-dlp.exe') : 'yt-dlp';
}

function getFFmpegPath() {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'ffmpeg.exe');
    return fs.existsSync(bundled) ? bundled : '';
  }
  const devBinary = path.join(app.getPath('userData'), 'ffmpeg.exe');
  return fs.existsSync(devBinary) ? devBinary : '';
}

// Append --ffmpeg-location so yt-dlp can merge separate video/audio streams
// using the bundled ffmpeg (required when ffmpeg is not on PATH).
function withFFmpegArgs(args) {
  const ffmpegPath = getFFmpegPath();
  if (ffmpegPath) {
    return [...args, '--ffmpeg-location', path.dirname(ffmpegPath)];
  }
  return args;
}

let ytDlp = null;

async function ensureYtDlpBinary() {
  const existing = getYtDlpPath();
  const downloadTarget = userDataBinPath('yt-dlp.exe');

  // Missing file (may be a userData download target, even when packaged):
  // fetch the latest release binary into <userData>/bin on this machine.
  if (existing !== 'yt-dlp' && !fs.existsSync(existing)) {
    console.log('yt-dlp binary not found, downloading the latest release into userData/bin ...');
    try {
      fs.mkdirSync(getBinDir(), { recursive: true });
      await ytDlpWrap.downloadFromGithub(downloadTarget);
      console.log('yt-dlp downloaded to:', downloadTarget);
    } catch (dlErr) {
      console.error('Failed to download yt-dlp:', dlErr.message);
    }
  }

  if (!ytDlp) {
    ytDlp = new ytDlpWrap(getYtDlpPath());
  }

  try {
    const version = await ytDlp.getVersion();
    console.log('yt-dlp is available (' + (version || 'unknown version') + ')');
    return true;
  } catch (err) {
    // Present (or on PATH) but not runnable: replace it with the latest release.
    console.warn('yt-dlp binary is not runnable, downloading the latest release into userData/bin ...');
    try {
      fs.mkdirSync(getBinDir(), { recursive: true });
      await ytDlpWrap.downloadFromGithub(downloadTarget);
      ytDlp = new ytDlpWrap(downloadTarget);
      const version = await ytDlp.getVersion();
      console.log('yt-dlp now available (' + (version || 'unknown version') + ')');
      return true;
    } catch (retryErr) {
      console.error('yt-dlp download failed:', retryErr.message);
      return false;
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'Nekofal',
    backgroundColor: '#0B0F17',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    },
    icon: appIconPath(),
    show: false,
    frame: true,
    titleBarStyle: 'default'
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ URL }) => {
    mainWindow.loadURL(URL);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    require('electron').shell.openExternal(url);
  });

  // Load the app with retry logic for dev server
  if (process.env.NODE_ENV === 'development') {
    loadDevServerWithRetry();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Floating mini-player (PiP). Opens a frameless, always-on-top window that loads
 * the same built app with the #/miniplayer route (no sidebar/navbar). The
 * renderer receives the playback payload via the 'mini:payload' event.
 */
function openMiniPlayer(payload) {
  const safePayload = {
    mode: payload?.mode === 'audio' ? 'audio' : 'video',
    title: String(payload?.title || 'Nekofal Mini Player'),
    streamUrl: String(payload?.streamUrl || ''),
    streamHls: !!payload?.streamHls,
    poster: String(payload?.poster || ''),
    currentTime: Number(payload?.currentTime) || 0,
    volume: Number(payload?.volume) != null ? Number(payload?.volume) : 1,
    muted: !!payload?.muted,
    videoId: payload?.videoId != null ? payload.videoId : null,
    isLocal: !!payload?.isLocal
  };
  if (!safePayload.streamUrl) return { success: false, error: 'No stream URL' };
  miniPayload = safePayload;

  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.show();
    miniPlayerWindow.focus();
    sendMiniPayload(miniPlayerWindow, safePayload);
    return { success: true, reused: true };
  }

  miniPlayerWindow = new BrowserWindow({
    width: 480,
    height: 300,
    minWidth: 320,
    minHeight: 180,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    title: safePayload.title,
    backgroundColor: '#0f141e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    },
    icon: appIconPath(),
    show: false
  });

  miniPlayerWindow.setAlwaysOnTop(true, 'floating');

  miniPlayerWindow.webContents.on('did-finish-load', () => {
    sendMiniPayload(miniPlayerWindow, miniPayload);
  });

  miniPlayerWindow.once('ready-to-show', () => {
    miniPlayerWindow.show();
  });

  miniPlayerWindow.on('closed', () => {
    miniPlayerWindow = null;
    miniPayload = null;
  });

  if (process.env.NODE_ENV === 'development') {
    miniPlayerWindow.loadURL('http://localhost:3000/#/miniplayer').catch(() => {});
  } else {
    miniPlayerWindow.loadFile(path.join(__dirname, '../build/index.html'), { hash: '/miniplayer' });
  }

  return { success: true, reused: false };
}

function sendMiniPayload(win, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('mini:payload', payload);
}

function closeMiniPlayer() {
  if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) {
    miniPlayerWindow.close();
  }
  miniPlayerWindow = null;
  miniPayload = null;
}

function registerMediaShortcuts() {
  const dispatch = (key) => {
    // Prefer the focused window (mini player takes control when focused);
    // fall back to the main window.
    const target = BrowserWindow.getFocusedWindow() && !BrowserWindow.getFocusedWindow().isDestroyed()
      ? BrowserWindow.getFocusedWindow()
      : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
    if (target && !target.webContents.isDestroyed()) {
      target.webContents.send('global-media-key', key);
    }
  };
  const mappings = [
    ['MediaPlayPause', 'playpause'],
    ['MediaNextTrack', 'next'],
    ['MediaPreviousTrack', 'previous'],
    ['MediaStop', 'stop']
  ];
  let ok = 0;
  let fail = 0;
  for (const [accelerator, key] of mappings) {
    try {
      if (globalShortcut.register(accelerator, () => dispatch(key))) ok++;
      else { fail++; console.warn(`[Shortcuts] registration denied: ${accelerator}`); }
    } catch (err) {
      fail++;
      console.warn(`[Shortcuts] registration error (${accelerator}):`, err.message);
    }
  }
  console.log(`[Shortcuts] media keys registered (${ok} ok, ${fail} failed)`);
}

function loadDevServerWithRetry(maxRetries = 60, retryInterval = 500) {
  let retries = 0;
  
  const attemptLoad = () => {
    mainWindow.loadURL('http://localhost:3000').catch(err => {
      retries++;
      if (retries < maxRetries) {
        console.log(`Dev server not ready, retry ${retries}/${maxRetries}...`);
        setTimeout(attemptLoad, retryInterval);
      } else {
        console.error('Dev server failed to start after max retries');
        mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
      }
    });
  };
  
  // Wait for the 'did-fail-load' event to trigger retry
  const handleLoadError = (event, errorCode, errorDescription) => {
    if (errorCode !== 0 && retries < maxRetries) {
      retries++;
      console.log(`Dev server load failed (${errorCode}: ${errorDescription}), retry ${retries}/${maxRetries}...`);
      setTimeout(attemptLoad, retryInterval);
    } else if (retries >= maxRetries) {
      console.error('Max retries reached, falling back to production build');
      mainWindow.loadFile(path.join(__dirname, '../build/index.html'));
    }
  };
  
  mainWindow.webContents.once('did-fail-load', handleLoadError);
  
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.removeListener('did-fail-load', handleLoadError);
  });

  attemptLoad();

  // Connect to local dev server for backends
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.startsWith('http://localhost')) {
      details.requestHeaders['Origin'] = null;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}
// VLC-style User-Agent for media streams. Many CDNs/hosts relax hotlink/geo
// checks when a request looks like a desktop media player, while Chromium's
// normal UA is frequently rejected on direct segment/file requests.
const STREAM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VLC/3.0.18';

// Media URL detection: files served with a media extension, requests the
// browser flags as <video>/<audio> loads, or hosts on known stream CDNs.
const MEDIA_URL_RE = /\.(m3u8|m3u|mpd|ism\/manifest|ts|m4s|mp4|m4v|webm|mkv|mov|mp3|aac|aacp|m4a|flac|ogg|oga|opus|wav|ac3|eac3)([?#]|$)/i;
const KNOWN_STREAM_HOSTS = /(\.akamaized\.net|\.cloudfront\.net|\.llnwd\.net|\.cdn77\.com|\.cdn\.lt|icecast|shoutcast)/i;

// Per-origin custom headers the renderer registers for a stream (referer/UA
// from yt-dlp http_headers or IPTV #EXTVLCOPT lines). key = scheme://host:port
const streamHeaderHints = new Map();
const STREAM_HINTS_MAX = 64;

function isStreamRequest(details) {
  if (details.resourceType === 'media') return true;
  const url = String(details.url || '');
  if (MEDIA_URL_RE.test(url)) return true;
  try {
    if (KNOWN_STREAM_HOSTS.test(new URL(url).hostname.toLowerCase())) return true;
  } catch { /* invalid URL - ignore */ }
  return false;
}

// Renderer -> main: register the custom headers to attach to a stream origin.
function registerStreamHeaders({ url, headers }) {
  try {
    if (!url || !headers || typeof headers !== 'object') {
      return { success: false, error: 'missing url or headers' };
    }
    const origin = new URL(String(url)).origin;
    const hint = {
      referer: headers.Referer || headers.referer || null,
      userAgent: headers['User-Agent'] || headers['user-agent'] || null,
      cookie: headers.Cookie || headers.cookie || null
    };
    if (!hint.referer && !hint.userAgent && !hint.cookie) {
      return { success: true, removed: streamHeaderHints.delete(origin) };
    }
    streamHeaderHints.set(origin, hint);
    if (streamHeaderHints.size > STREAM_HINTS_MAX) {
      streamHeaderHints.delete(streamHeaderHints.keys().next().value);
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

ipcMain.handle('streams:setHeaders', (event, payload = {}) => registerStreamHeaders(payload));

// A hidden BrowserWindow is used as a stealth browsing layer (see the stealth
// engine below). Its requests must pass through untouched — real browser UA,
// session cookies (cf_clearance, tokens) and order — or the anti-bot pages it
// visits would never authenticate.
function isStealthRequest(details) {
  if (!stealthWindow || stealthWindow.isDestroyed()) return false;
  return details.webContentsId === stealthWindow.webContents.id;
}

function setupWebRequestHeaders() {
  // Intercept all outgoing requests to inject headers for 403 / hotlink bypass

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Stealth browsing layer: forward the request exactly as the embedded real
    // browser issued it (its cookies are already in defaultSession).
    if (isStealthRequest(details)) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const url = new URL(details.url);
    const hostname = url.hostname;
    
    // Skip localhost and local network
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const headers = { ...details.requestHeaders };
    const isStream = isStreamRequest(details);
    const hint = isStream ? (streamHeaderHints.get(url.origin) || null) : null;

    if (isStream) {
      // Media/stream requests: VLC-style UA + a Referer matching the stream
      // origin (or the custom referer registered for this host).
      headers['User-Agent'] = (hint && hint.userAgent) || STREAM_UA;
      const referer = (hint && hint.referer) || `${url.protocol}//${url.host}`;
      headers['Referer'] = referer;
      try { headers['Origin'] = new URL(referer).origin; } catch { /* keep default */ }
      headers['Accept'] = '*/*';
    } else {
      // Regular page/API requests keep a standard desktop Chrome UA.
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      
      // Accept headers for video content
      headers['Accept'] = '*/*';
      headers['Accept-Language'] = 'en-US,en;q=0.9';
      headers['Accept-Encoding'] = 'gzip, deflate, br';
      headers['Accept-Charset'] = 'utf-8';
    }
    
    // Remove headers that might trigger blocking, unless the renderer explicitly
    // registered stream cookies for this origin (e.g. yt-dlp http_headers).
    if (!(hint && hint.cookie)) {
      delete headers['Cookie'];
      delete headers['Cookie2'];
    } else {
      headers['Cookie'] = hint.cookie;
    }
    
    callback({ requestHeaders: headers });
  });
  
  // Handle redirects to preserve headers
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    
    // Remove restrictive CORS headers from response
    if (responseHeaders['Access-Control-Allow-Origin']) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
    }
    if (responseHeaders['Access-Control-Allow-Credentials']) {
      responseHeaders['Access-Control-Allow-Credentials'] = ['true'];
    }
    if (responseHeaders['Access-Control-Allow-Methods']) {
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, HEAD'];
    }
    if (responseHeaders['Access-Control-Allow-Headers']) {
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
    }
    
    // Allow all content to be embedded
    delete responseHeaders['X-Frame-Options'];
    delete responseHeaders['Content-Security-Policy'];
    
    callback({ responseHeaders });
  });

  // Network stream sniffer (see stealth engine below): observe every request
  // and capture .m3u8 / .mp4 / media requests globally.
  installStreamSniffer();
}

/* ---------------------------------------------------------------------------
   Stealth browsing layer
   ---------------------------------------------------------------------------
   Cloudflare/anti-bot front-ends (Turnstile challenges, fingerprint checks)
   reject Node/undici HTTP clients and plain scrapers by their TLS/HTTP2
   fingerprint and header ordering. This layer loads the target page inside a
   hidden Chromium window so it presents a genuine browser signature, waits for
   the JS/Turnstile challenge to auto-clear, and lets the landed cookies
   (cf_clearance, session tokens) fall into session.defaultSession — where the
   main-process net.fetch() and the app share them globally. A webRequest
   observer doubles as a network stream sniffer for .m3u8/.mp4.            */

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, Number(ms) || 0)));

const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

let stealthWindow = null;

function ensureStealthWindow() {
  if (stealthWindow && !stealthWindow.isDestroyed()) return stealthWindow;
  stealthWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    show: false,
    frame: false,
    skipTaskbar: true,
    backgroundColor: '#0B0F17',
    webPreferences: {
      offscreen: true,
      paintWhenInitiallyHidden: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  // Same session as the app (no partition): acquired cookies are stored in
  // session.defaultSession and propagate to net.fetch + renderer requests.
  // Remove any chrome-extension preload leakage in the "chrome://gpu" case.
  stealthWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  stealthWindow.on('closed', () => { stealthWindow = null; });
  return stealthWindow;
}

function destroyStealthWindow() {
  if (stealthWindow && !stealthWindow.isDestroyed()) {
    try {
      stealthWindow.webContents.stop();
      stealthWindow.destroy();
    } catch (_err) { /* already tearing down */ }
  }
  stealthWindow = null;
}

async function getSessionCookies(url) {
  try {
    const list = await session.defaultSession.cookies.get({ url });
    return list.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate || 0
    }));
  } catch (_err) {
    return [];
  }
}

// Cookie header string for outbound scrapes. The offscreen stealth browser
// stores Cloudflare clearance (cf_clearance / __cf_bm) in defaultSession after
// it solves the Turnstile challenge; re-attaching that Cookie header lets the
// direct API fetches present the same cleared session instead of re-challenging.
async function getSessionCookieHeader(url) {
  const cookies = await getSessionCookies(url);
  const relevant = cookies.filter(c =>
    /^(cf_clearance|__cf_bm|_cfuvid|NID|SID|HSID|SSID|APISID|SAPISID|LOGIN_INFO)$/i.test(c.name)
  );
  if (!relevant.length) return '';
  return relevant.map(c => `${c.name}=${c.value}`).join('; ');
}

async function evalInStealth(js, timeoutMs = 8000) {
  const win = ensureStealthWindow();
  const result = await Promise.race([
    win.webContents.executeJavaScript(`(function(){ try { ${js} } catch (e) { return { __stealthError: String(e && e.message || e) }; } })()`),
    sleep(timeoutMs).then(() => ({ __stealthError: 'eval timeout' }))
  ]);
  return result;
}

// Attempt to nudge Cloudflare into solving its challenge automatically:
// non-interactive Turnstile challenges run on their own; this clicks the
// checkbox / verification button for the interactive variants.
async function trySolveCloudflare(win) {
  try {
    await win.webContents.executeJavaScript(`(function(){
      let clicked = 0;
      const targets = document.querySelectorAll('.cf-turnstile input[type="checkbox"], iframe[src*="challenges.cloudflare.com"], [id="challenge-form"] button, #challenge-form button, .turnstile-wrapper input{type=checkbox}');
      [].forEach.call(targets, function (el) { try { el.click(); clicked++; } catch (e) {} });
      return clicked;
    })()`);
  } catch (err) {
    console.warn('[stealth] cloudflare nudge failed:', err.message);
  }
}

// Poll until Cloudflare/Turnstile clears (an arriving cf_clearance cookie or
// no challenge frame left) or the expected content selector appears.
async function waitForCloudflare(win, challengeTimeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < challengeTimeoutMs) {
    let state = null;
    try {
      state = await win.webContents.executeJavaScript(`(function(){
        const sel = '[id="challenge-running"], .cf-turnstile, [data-turnstile], iframe[src*="challenges.cloudflare.com"], [id="challenge-form"]';
        const has = !![].slice.call(document.querySelectorAll(sel)).length || !!(window.turnstile && document.querySelector('iframe'));
        return {
          hasChallenge: has,
          ready: !!document.body && document.title.length > 0,
          href: location.href,
          title: document.title
        };
      })()`);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!state.hasChallenge && state.ready) return { ok: true, state };
    if (state.hasChallenge) await trySolveCloudflare(win);
    await sleep(1500);
  }
  return { ok: false, error: 'Cloudflare challenge did not clear in time' };
}

async function loadInStealth(url, opts = {}) {
  const win = ensureStealthWindow();
  const timeoutMs = opts.timeoutMs || 30000;
  const result = {
    success: false,
    url,
    title: '',
    href: '',
    error: null,
    cookies: []
  };

  return new Promise((resolve) => {
    let settled = false;
    const done = (extra) => {
      if (!settled) {
        settled = true;
        clearTimeout(hardTimer);
        resolve({ ...result, ...extra });
      }
    };

    win.webContents.once('did-fail-load', (_event, errCode, errDesc) => {
      done({ error: errDesc || String(errCode) });
    });
    win.webContents.once('did-finish-load', async () => {
      // A second load fires 'did-finish-load' after the challenge redirects;
      // wait for the challenge to clear before declaring success.
      await sleep(opts.pauseAfterLoadMs || 1000);
      await waitForCloudflare(win, opts.challengeTimeoutMs || 20000);
      const cookies = await getSessionCookies(url);
      let title = '';
      let href = url;
      try {
        const meta = await evalInStealth('return { t: document.title || "", h: location.href };', 3000);
        if (meta && typeof meta === 'object' && !meta.__stealthError) {
          title = String(meta.t || '');
          href = String(meta.h || url);
        }
      } catch (_err) { /* keep defaults */ }
      done({ success: true, title, href, cookies });
    });

    const hardTimer = setTimeout(() => done({ error: 'load timeout' }), timeoutMs);

    win.loadURL(url, { userAgent: STEALTH_UA }).catch(err => done({ error: err.message }));
  });
}

/* ---------------------------------------------------------------------------
   Network stream sniffer
   --------------------------------------------------------------------------- */
const STREAM_SNIFF_RE = /\.(m3u8|m3u|mpd|m4s|ts|mp4|m4v|webm|mkv|mov)([?#]|$)/i;
let sniffedRecent = [];
let activeSniff = null;

function installStreamSniffer() {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({});
    const url = String(details.url || '');
    const isMedia = details.resourceType === 'media' || STREAM_SNIFF_RE.test(url);
    if (!isMedia || url.startsWith('http://localhost')) return;

    const entry = { url, resourceType: details.resourceType || 'unknown', at: Date.now(), webContentsId: details.webContentsId };
    sniffedRecent.push(entry);
    if (sniffedRecent.length > 300) sniffedRecent = sniffedRecent.slice(-300);

    // During an active sniff session, collect + announce to the renderer.
    if (activeSniff) {
      activeSniff.captured.push(entry);
      // Early-return hook: let the resolver resolve the instant a matching
      // stream URL is captured instead of waiting out its full timeout.
      if (typeof activeSniff.onCapture === 'function') {
        try { activeSniff.onCapture(entry); } catch (_e) { /* hook errors ignored */ }
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream:sniffed', {
          sessionId: activeSniff.sessionId,
          pageUrl: activeSniff.pageUrl,
          streams: activeSniff.captured.map(e => e.url),
          at: entry.at
        });
      }
    }
  }, { urls: ['<all_urls>'] });
}

function pickUsableStreams(captured) {
  const seen = new Set();
  const usable = (captured || [])
    .map(e => e && e.url)
    .filter(u => u && /\.(m3u8|m3u|mpd|mp4|m4v|webm|mov)([?#]|$)/i.test(u))
    .filter(u => {
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
  // Prefer master/quality playlists over single-segment captures.
  return usable.sort((a, b) => {
    const aMaster = a.includes('master') ? 1 : 0;
    const bMaster = b.includes('master') ? 1 : 0;
    return (bMaster - aMaster) || a.length - b.length;
  });
}

// Sniff a page in the offscreen browser with an EARLY RETURN: instead of
// sleeping a fixed window, resolve the moment `match(entry)` fires on a
// captured media request (or `probe()` returns a URL read from the page
// itself). The offscreen window is destroyed immediately on resolution, and
// cf_clearance/__cf_bm cookies persist in session.defaultSession for the
// next (challenge-free) load.
async function sniffWithEarlyReturn(pageUrl, { timeoutMs = 20000, pauseAfterLoadMs = 1500, match, probe } = {}) {
  const pageUrl$ = String(pageUrl || '').trim();
  if (!/^https?:\/\//i.test(pageUrl$)) return { success: false, error: 'Invalid URL' };
  const win = ensureStealthWindow();
  const sessionId = 'sniff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const captured = [];
  let earlyUrl = null;
  let settled = false;
  let settle = null;
  let probeTimer = null;

  const finish = (extra) => {
    if (settled) return;
    settled = true;
    activeSniff = null;
    if (probeTimer) clearTimeout(probeTimer);
    const streams = [...new Set(captured.map(e => e.url))];
    if (earlyUrl) streams.unshift(earlyUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream:sniffed', { sessionId, pageUrl: pageUrl$, streams });
    }
    // The manifest/CDN URL is known — tear the offscreen browser down now so
    // it never blocks quit or lingers holding resources. Session cookies
    // (cf_clearance / __cf_bm) live in defaultSession, not the window.
    destroyStealthWindow();
    if (settle) settle({ success: true, sessionId, pageUrl: pageUrl$, streams, matchedUrl: earlyUrl, ...extra });
  };

  activeSniff = {
    sessionId,
    pageUrl: pageUrl$,
    captured,
    onCapture: (entry) => {
        // Only treat requests from THIS offscreen window as candidates — the
        // webRequest hook is global, so the main window's own HLS/stream
        // requests must never trigger a premature early return.
        if (win && !win.isDestroyed() && entry.webContentsId && entry.webContentsId !== win.webContents.id) return;
        try {
          if (match && typeof match === 'function' && match(entry)) {
            earlyUrl = entry.url;
            finish({ early: true });
          }
        } catch (_e) { /* match errors ignored */ }
      }
  };

  const scheduleProbe = () => {
    if (settled || typeof probe !== 'function') return;
    probeTimer = setTimeout(async () => {
      if (settled) return;
      try {
        const u = await probe(win);
        if (u && typeof u === 'string' && /^https?:\/\//i.test(u)) {
          earlyUrl = u;
          finish({ early: true });
        }
      } catch (_e) { /* probe failed */ }
    }, pauseAfterLoadMs);
  };

  loadInStealth(pageUrl$, { pauseAfterLoadMs, challengeTimeoutMs: 20000, timeoutMs: Math.max(timeoutMs, 25000) })
    .then(scheduleProbe)
    .catch(() => { /* load failure handled by loadInStealth's own timeout */ });

  // Watchdog: never block the caller past timeoutMs.
  setTimeout(() => { if (!settled) finish({ error: 'sniff timeout' }); }, timeoutMs);

  return new Promise((resolve) => { settle = resolve; });
}

/* ---------------------------------------------------------------------------
   Stealth page automation (custom site form search + sniff)
   --------------------------------------------------------------------------- */

// Injected: locate the site's search input, fill it like a user, submit it.
const AUTO_SEARCH_FILL_SCRIPT = `
var q = __QUERY_JSON__;
function __stealthAbs(u) { try { return new URL(u, location.href).href; } catch (e) { return u; } }
var inputs = [].slice.call(document.querySelectorAll('input'));
var visible = inputs.filter(function (i) {
  var t = (i.type || 'text').toLowerCase();
  if (t !== 'search' && t !== 'text' && t !== 'query') return false;
  var r = i.getBoundingClientRect();
  var cs = getComputedStyle(i);
  return r.width > 40 && r.height > 10 && cs.visibility !== 'hidden' && cs.display !== 'none';
});
var target = visible[0] || inputs[0] || null;
if (!target) return { injected: true, foundForm: false, reason: 'no-input', href: location.href };
var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
try { setter.call(target, q); } catch (e) {}
try { target.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
try { target.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
var form = target.form || target.closest('form');
var submitted = false;
if (form) {
  try { if (typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted = true; } }
  catch (e) {}
  if (!submitted) { try { form.submit(); submitted = true; } catch (e) {} }
}
if (!submitted) {
  var btn = document.querySelector('button[type="submit"], input[type="submit"], [role="search"] button');
  if (btn) { try { btn.click(); submitted = true; } catch (e) {} }
}
if (!submitted && target) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
}
return { injected: true, foundForm: !!form, submitted: submitted, href: location.href };
`;

// Injected: after the search page responds, extract video-like result cards.
const AUTO_SEARCH_EXTRACT_SCRIPT = `
var seen = {};
var out = [];
var anchors = [].slice.call(document.querySelectorAll('a[href]'));
for (var i = 0; i < anchors.length; i++) {
  var a = anchors[i];
  var raw = String(a.getAttribute('href') || '');
  if (!raw || raw.charCodeAt(0) === 35) continue;                 // skip #
  if (/^\\\\s*javascript/i.test(raw)) continue;
  var abs;
  try { abs = new URL(raw, location.href).href; } catch (e) { continue; }
  if (/\\\\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff|ttf)([?#]|$)/i.test(abs)) continue;
  if (seen[abs]) continue;
  var img = a.querySelector('img');
  var thumb = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
  var head = a.querySelector('h1, h2, h3, h4, .title, .name, .card-title');
  var title = (a.getAttribute('title') || (head ? head.textContent.trim() : '') || a.textContent.trim() || '').slice(0, 200);
  var isVideo = /(watch|episode|video|\\/v\\/|stream|play|hentai)/i.test(abs) || !!a.querySelector('video, source');
  var score = (img ? 2 : 0) + (isVideo ? 3 : 0) + (title.length > 3 ? 1 : 0);
  if (score < 3) continue;
  seen[abs] = true;
  out.push({ title: title, thumb: thumb, url: abs, score: score });
  if (out.length >= __LIMIT__) break;
}
out.sort(function (aa, bb) { return bb.score - aa.score; });
return { out: out, href: location.href, title: document.title };
`;

function buildAutoSearchScript(script, values) {
  let code = script;
  if (values.query) code = code.replace('__QUERY_JSON__', JSON.stringify(values.query));
  if (values.limit) code = code.replace('__LIMIT__', String(values.limit));
  return code;
}

async function stealthAutoSearch(baseUrl, query, count = 25) {
  const base = String(baseUrl || '').trim().replace(/^\/+|(\/)+$/g, (m, s) => (s ? '/' : '')) || '';
  if (!/^https?:\/\//i.test(base)) return [];
  const win = ensureStealthWindow();

  const load = await loadInStealth(base, { pauseAfterLoadMs: 1200, challengeTimeoutMs: 20000 });
  if (!load.success) {
    console.warn(`[stealth] auto-search load failed for ${base}: ${load.error}`);
    return [];
  }

  const fill = await evalInStealth(buildAutoSearchScript(AUTO_SEARCH_FILL_SCRIPT, { query }), 5000);
  console.log('[stealth] auto-search form state:', JSON.stringify(fill || {}).slice(0, 300));

  // If no form input was found, try a single lightweight query-param fallback
  // (best effort — the primary path is the real form, not URL guessing).
  if (!fill || fill.__stealthError || (fill.reason === 'no-input' && !fill.foundForm)) {
    if (/[?&](?:q|s|search|query|k)=/i.test(base)) {
      // Already a search/results URL (e.g. a {query}-substituted site template):
      // nothing to fill — go straight to extracting the rendered results.
      console.log('[stealth] query URL already loaded, extracting directly:', base);
    } else {
      const fallbackUrl = base + (base.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(query);
      console.log('[stealth] no search input found, trying query-param fallback:', fallbackUrl);
      const fallback = await loadInStealth(fallbackUrl, { pauseAfterLoadMs: 2000, challengeTimeoutMs: 15000 });
      if (!fallback.success) return [];
    }
  }

  // Give the (possibly client-side rendered) results time to appear.
  await sleep(7000);
  const extracted = await evalInStealth(buildAutoSearchScript(AUTO_SEARCH_EXTRACT_SCRIPT, { limit: count }), 8000);
  const list = (extracted && Array.isArray(extracted.out)) ? extracted.out : [];
  if (extracted && extracted.__stealthError) {
    console.warn('[stealth] auto-search extract failed:', extracted.__stealthError);
    return [];
  }

  const host = (() => {
    try { return new URL(base).hostname.replace('www.', ''); } catch { return ''; }
  })();
  return list.map((r, idx) => ({
    id: `custom-${host}-${idx}-${Buffer.from(r.url).toString('hex').substring(0, 8)}`,
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    duration: 0,
    category: host || 'Custom Site',
    sourceSite: host || 'Custom Site',
    extractor: 'custom-form'
  }));
}

// Sniff a page loaded in the stealth window: returns detected m3u8/mp4 streams.
async function sniffPageInStealth(url, watchMs = 9000) {
  const pageUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(pageUrl)) return { success: false, error: 'Invalid URL' };
  const win = ensureStealthWindow();
  const sessionId = 'sniff-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  activeSniff = { sessionId, pageUrl, captured: [] };
  try {
    await loadInStealth(pageUrl, { pauseAfterLoadMs: 1500, challengeTimeoutMs: 20000, timeoutMs: 45000 });
    // Keep the page alive and let media requests accumulate.
    await sleep(watchMs);
    const streams = pickUsableStreams(activeSniff.captured);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stream:sniffed', { sessionId, pageUrl, streams });
    }
    return { success: true, sessionId, pageUrl, streams };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    activeSniff = null;
  }
}

ipcMain.handle('stealth:load', async (_event, { url, opts } = {}) => {
  try {
    const res = await loadInStealth(String(url || ''), opts || {});
    return { success: res.success, url: res.url, title: res.title, href: res.href, error: res.error, cookies: res.cookies };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stealth:eval', async (_event, { js } = {}) => {
  try {
    const res = await evalInStealth(String(js || ''), 8000);
    return { success: true, result: res };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stealth:cookies', async (_event, { url } = {}) => {
  const cookies = await getSessionCookies(String(url || ''));
  return { success: true, cookies };
});

ipcMain.handle('scraper:sniff', async (_event, { url, watchMs } = {}) => {
  return sniffPageInStealth(String(url || ''), Math.min(Math.max(Number(watchMs) || 9000, 3000), 45000));
});

ipcMain.handle('scraper:autoSearch', async (_event, { baseUrl, query, count } = {}) => {
  try {
    const q = String(query || '').trim();
    if (!q) return { success: false, error: 'Nothing to search for' };
    const videos = await stealthAutoSearch(String(baseUrl || ''), q, Number(count) || 25);
    return { success: videos.length > 0, source: 'custom-form', videos };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
async function startVideoServer() {
  if (videoServerStarted) return;
  videoServerStarted = true;
  const appPort = parseInt(process.env.API_PORT) || 5001;
  
  const expressApp = express();
  expressApp.use('/video', cors());
  
  expressApp.get('/video/proxy/stream', async (req, res) => {
    const headers = req.headers;
    
    res.setHeader('Access-Control-Allow-Origin', '*', true);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS', true);
    res.setHeader('Access-Control-Allow-Headers', '*', true);
    res.setHeader('Accept-Ranges', 'bytes', true);
    res.setHeader('Cache-Control', 'public, max-age=604800', true);
    
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const videoUrl = req.query.src || req.headers['x-video-url'];
    
    // Parse custom headers from query (JSON-encoded from yt-dlp metadata / m3u8)
    let customHeaders = {};
    try {
      if (req.query.http_headers) {
        customHeaders = JSON.parse(decodeURIComponent(req.query.http_headers));
      }
    } catch (e) {
      console.warn('[VideoProxy] Failed to parse http_headers:', e.message);
    }
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'No video URL provided' });
    }

    // Follow redirects up to a few hops (video CDNs usually redirect to signed URLs)
    const MAX_REDIRECTS = 5;

    const requestOnce = (targetUrl) => {
      const target = new URL(targetUrl);
      const lib = target.protocol === 'https:' ? https : http;
      const requestOptions = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          'User-Agent': customHeaders['User-Agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity',
          'Referer': customHeaders['Referer'] || `${target.protocol}//${target.host}`,
          'Origin': `${target.protocol}//${target.host}`,
          'Connection': 'keep-alive'
        }
      };

      // Merge any additional custom headers from yt-dlp
      Object.keys(customHeaders).forEach(key => {
        if (key.toLowerCase() !== 'user-agent' && key.toLowerCase() !== 'referer') {
          requestOptions.headers[key] = customHeaders[key];
        }
      });

      // Only add Range header if present
      if (headers.range) {
        requestOptions.headers['Range'] = headers.range;
      }

      return new Promise((resolve, reject) => {
        const proxyReq = lib.get(requestOptions, (httpRes) => {
          if ([301, 302, 303, 307, 308].includes(httpRes.statusCode) && httpRes.headers.location) {
            httpRes.resume();
            let nextUrl;
            try {
              nextUrl = new URL(httpRes.headers.location, target.href).href;
            } catch (e) {
              return reject(new Error('Invalid redirect from video stream'));
            }
            return resolve({ redirect: nextUrl });
          }
          resolve({ httpRes, finalUrl: target.href });
        });
        proxyReq.on('error', (err) => reject(err));
      });
    };

    let target = null;
    let current = videoUrl;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const step = await requestOnce(current);
      if (step.redirect) { current = step.redirect; continue; }
      target = step;
      break;
    }

    if (!target) {
      return res.status(502).json({ error: 'Too many redirects while fetching video stream' });
    }

    const httpRes = target.httpRes;
    const finalUrl = target.finalUrl;

    if (httpRes.statusCode >= 400) {
      httpRes.resume();
      return res.status(502).json({ error: `Upstream returned HTTP ${httpRes.statusCode} for video stream`, url: finalUrl });
    }

    // HLS playlists MUST be rewritten: hls.js resolves relative child playlists
    // and segment URIs against the playlist URL, which would be this proxy
    // endpoint. Rewriting every URI to go back through the proxy fixes that and
    // guarantees CORS + required headers on every request (works for live TV in
    // most cases).
    const ctype = String(httpRes.headers['content-type'] || '').toLowerCase();
    let isPlaylist = /m3u8|mpegurl/i.test(ctype);
    if (!isPlaylist) {
      try {
        isPlaylist = /\.m3u8([?#]|$)/i.test(new URL(finalUrl).pathname);
      } catch (e) { /* keep false */ }
    }

    // Forward response headers, then decide: pipe (media) or buffer+rewrite (playlist)
    Object.keys(httpRes.headers).forEach(key => {
      try { res.setHeader(key, httpRes.headers[key]); } catch (e) { /* ignore invalid header */ }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Accept-Ranges', 'bytes');

    if (!isPlaylist || req.headers.range) {
      if (httpRes.statusCode !== 200 && httpRes.statusCode !== 206) {
        httpRes.resume();
        return res.status(httpRes.statusCode).end();
      }
      httpRes.pipe(res);
      return;
    }

    // Buffer the playlist and rewrite every URI line to go through this proxy
    let body = '';
    httpRes.setEncoding('utf8');
    await new Promise((resolve) => {
      httpRes.on('data', c => body += c);
      httpRes.on('end', resolve);
      httpRes.on('error', resolve);
    });

    const extraQuery = Object.keys(customHeaders).length > 0
      ? '&http_headers=' + encodeURIComponent(JSON.stringify(customHeaders))
      : '';
    const proxyBase = `http://localhost:${actualPort}/video/proxy/stream?src=`;

    const rewriteUri = (uri) => {
      let abs;
      try { abs = new URL(uri, finalUrl).href; } catch { return null; }
      return proxyBase + encodeURIComponent(abs) + extraQuery;
    };

    const rewritten = body.split(/\r?\n/).map(line => {
      const t = (line || '').trim();
      if (!t) return line;
      if (!t.startsWith('#')) {
        // Plain URI line (media playlist variant / segment)
        const rw = rewriteUri(t);
        return rw || line;
      }
      // Attribute lines that embed a URI (e.g. EXT-X-KEY, EXT-X-MEDIA)
      if (t.indexOf('URI="') !== -1) {
        let out = t;
        out = out.replace(/URI="([^"]+)"/g, (m, u) => {
          const rw = rewriteUri(u);
          return `URI="${rw || u}"`;
        });
        return out;
      }
      return line;
    }).join('\n');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegURL; charset=utf-8');
    res.send(rewritten);
  });

  expressApp.get('*', (req, res) => {
    if (isReady) {
      res.json({ status: 'ready', message: 'PersonalMediaHub is running' });
    } else {
      res.status(503).json({ error: 'Backend not ready yet' });
    }
  });

  const tryListen = (port) => {
    return new Promise((resolve, reject) => {
      const server = expressApp.listen(port, () => {
        const boundPort = server.address().port;
        console.log(`Video server running on port ${boundPort}`);
        videoServer = server; // Store the HTTP server instance
        videoServerPort = boundPort;
        resolve(boundPort);
      });
      server.on('error', (err) => {
        reject(err);
      });
    });
  };

  // Try ports starting from appPort, up to appPort + 10
  let actualPort = null;
  for (let i = 0; i < 10; i++) {
    try {
      actualPort = await tryListen(appPort + i);
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        continue;
      }
      throw err;
    }
  }
  // All preferred ports are busy: bind on port 0 and let the OS pick a free port.
  if (actualPort === null) {
    actualPort = await tryListen(0);
  }
  console.log(`Video server running on port ${actualPort}`);

  // Share the actual base URL with the renderer (the proxy must know the real
  // port, especially when we fell back to port 0).
  videoServerBaseUrl = `http://localhost:${actualPort}`;
}

// ============================================
// IPC HANDLERS - Secure Communication
// ============================================

ipcMain.handle('app:initialize', async () => {
  if (isReady) return { success: true };
  
  isReady = true;
  if (!mainWindow) createWindow();
  await startVideoServer();
  setupWebRequestHeaders();
  ensureDirectories();
  
  return { success: true, message: 'App initialized' };
});

// Lets the renderer learn the real proxy base URL (port may be random if 5001..5010 were busy)
ipcMain.handle('video:getServerInfo', () => ({
  port: videoServerPort,
  baseUrl: videoServerBaseUrl
}));

// Open DevTools IPC handler
ipcMain.on('app:openDevTools', () => {
  if (mainWindow) {
    mainWindow.webContents.openDevTools();
  }
});

// ---------------------------------------------------------------------------
// Auto-updater — non-intrusive GitHub Releases updates. Only active in the
// packaged build; dev runs report "unavailable" so nothing breaks locally.
// ---------------------------------------------------------------------------
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => {
    sendToRenderer('app:update', {
      type: 'available',
      version: info && info.version ? info.version : null,
      info
    });
  });
  autoUpdater.on('update-not-available', () => {
    sendToRenderer('app:update', { type: 'not-available' });
  });
  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('app:update', {
      type: 'progress',
      percent: p && typeof p.percent === 'number' ? p.percent : 0
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    sendToRenderer('app:update', {
      type: 'downloaded',
      version: info && info.version ? info.version : null,
      info
    });
  });
  autoUpdater.on('error', (err) => {
    sendToRenderer('app:update', {
      type: 'error',
      message: (err && err.message) || String(err)
    });
  });

  // Delayed start so the window (and its listeners) is ready before the check.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[updater] check failed:', err && err.message);
    });
  }, 4000);
}

// Renderer-requested check (Settings/app menu can call this for a manual scan).
ipcMain.handle('app:checkForUpdates', async () => {
  if (!autoUpdater || !app.isPackaged) {
    return { success: false, error: 'Updates are only available in the packaged build' };
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    return { success: true, ...(res || {}) };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// Renderer-requested restart-and-install after the update finished downloading.
ipcMain.handle('app:quitAndInstall', async () => {
  if (!autoUpdater) return { success: false, error: 'Updater unavailable' };
  try {
    autoUpdater.quitAndInstall(false, true);
    return { success: true };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Secure credential vault (OS-encrypted API keys / tokens)
// ---------------------------------------------------------------------------
ipcMain.handle('vault:set', async (_event, payload) => {
  try {
    credentialVault.setSecret(String(payload?.key || ''), String(payload?.value || ''));
    return { success: true };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('vault:get', async (_event, key) => {
  return { success: true, value: credentialVault.getSecret(String(key || '')) };
});

ipcMain.handle('vault:list', async () => {
  return { success: true, keys: credentialVault.listKeys() };
});

ipcMain.handle('vault:delete', async (_event, key) => {
  try {
    return { success: credentialVault.deleteSecret(String(key || '')) };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

function ensureDirectories() {
  const fs = require('fs');
  
  try {
    if (!fs.existsSync('./backends')) {
      fs.mkdirSync('./backends', { recursive: true });
    }
    
    if (!fs.existsSync('./config')) {
      fs.mkdirSync('./config', { recursive: true });
    }
  } catch (err) {
    console.error('Failed to create directories:', err);
  }
}

// Helper: Validate if a URL is a direct media stream
function isValidMediaStreamUrl(url) {
  if (!url || typeof url !== 'string') return false;
  
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    const hostname = urlObj.hostname.toLowerCase();
    
    // Check for known media extensions
    const mediaExtensions = ['.mp4', '.m3u8', '.ts', '.webm', '.m4s', '.mkv', '.m4v', '.mov', '.avi'];
    if (mediaExtensions.some(ext => pathname.endsWith(ext))) return true;
    
    // Check for known CDN stream patterns
    if (hostname.includes('googlevideo.com') || 
        hostname.includes('videoplayback') ||
        pathname.includes('videoplayback') ||
        pathname.includes('googlevideo') ||
        hostname.includes('cdn') && (pathname.includes('.mp4') || pathname.includes('.m3u8') || pathname.includes('.ts'))) {
      return true;
    }
    
    // Check for common stream query parameters
    const searchParams = urlObj.search.toLowerCase();
    if (searchParams.includes('mime=video') || 
        searchParams.includes('content-type=video') ||
        searchParams.includes('.m3u8') ||
        searchParams.includes('.mp4') ||
        searchParams.includes('.ts')) {
      return true;
    }
    
    return false;
  } catch {
    return false;
  }
}

// Helper: Route restricted/local streams through proxy
function getProxiedStreamUrl(url) {
  if (!url || typeof url !== 'string') return url;
  
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.toLowerCase();
    
    // Route local file paths through proxy
    if (url.startsWith('file://') || /^[a-zA-Z]:[\\\/]/.test(url)) {
      return `http://localhost:5001/video/proxy/stream?src=${encodeURIComponent(url)}`;
    }
    
    // Route potentially restricted HTTP streams through proxy
    // (if not already a known CDN or if it's a direct file that might have CORS issues)
    if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
      const pathnameLower = urlObj.pathname.toLowerCase();
      // Don't proxy known CDN streams
      const isKnownCDN = urlObj.hostname.includes('googlevideo.com') || 
                        urlObj.hostname.includes('videoplayback');
      
      // Proxy if not a known CDN and has video extension or parameters
      if (!isKnownCDN && (
        pathnameLower.endsWith('.mp4') || 
        pathnameLower.endsWith('.m3u8') || 
        pathnameLower.endsWith('.ts') || 
        pathnameLower.endsWith('.webm') ||
        urlObj.search.includes('video')
      )) {
return `http://localhost:5001/video/proxy/stream?src=${encodeURIComponent(url)}`;
      }
    }
  } catch {
    return url;
  }
  return url;
}
    
// yt-dlp stream extraction IPC handler
ipcMain.handle('scrapers:extractStream', async (event, { url, formatId }) => {
  try {
    // Fast-path: bypass yt-dlp for direct media URLs - validate first
    if (isValidMediaStreamUrl(url)) {
      return { 
        success: true, 
        streamUrl: url, 
        isHls: url.includes('.m3u8') 
      };
    }

    // Hanime fast-path: hanime.tv is a Cloudflare-guarded JS SPA, so yt-dlp
    // has no working extractor for it. Route every hanime.tv link through the
    // stealth resolver (native v8 API first, then offscreen-browser .m3u8
    // sniffing on the cf_clearance-cleared session) and NEVER hand the URL to
    // the yt-dlp binary — if the resolver fails, that is a hard error.
    if (/hanime\.tv/i.test(url)) {
      try {
        const info = await resolveHanimeStream(url);
        console.log(`[hanime] resolved ${url} -> ${info.m3u8}`);
        return {
          success: true,
          streamUrl: info.m3u8,
          isHls: true,
          extractor: info.viaSniff ? 'hanime-stealth-sniff' : 'hanime-v8',
          title: info.title,
          duration: info.duration,
          httpHeaders: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer': 'https://hanime.tv/',
            'Origin': 'https://hanime.tv'
          }
        };
      } catch (hanErr) {
        console.warn(`[hanime] stealth resolver failed — yt-dlp deliberately NOT used: ${hanErr.message}`);
        return {
          success: false,
          error: `Hanime stream resolution failed: ${hanErr.message}`,
          details: 'hanime.tv is only resolvable through the stealth v8/sniffer (yt-dlp bypassed); retry or verify connectivity'
        };
      }
    }

    // Pornhub: yt-dlp natively supports it but the CDN challenges default
    // requests — resolve with explicit browser headers first, then a stealth
    // sniff fallback, handing the master manifest straight to hls.js.
    if (/pornhub\.com/i.test(url)) {
      try {
        const ph = await resolvePornhubStream(url);
        console.log(`[pornhub] resolved ${url} -> ${ph.m3u8}`);
        return {
          success: true,
          streamUrl: ph.m3u8,
          isHls: /\.m3u8/i.test(ph.m3u8),
          extractor: ph.fromYT ? 'yt-dlp-pornhub' : 'pornhub-stealth-sniff',
          title: ph.title,
          duration: ph.duration,
          httpHeaders: {
            'User-Agent': PH_UA,
            'Referer': 'https://www.pornhub.com/',
            'Origin': 'https://www.pornhub.com'
          }
        };
      } catch (phErr) {
        console.warn(`[pornhub] stream resolution failed: ${phErr.message}`);
        return {
          success: false,
          error: `Pornhub stream resolution failed: ${phErr.message}`,
          details: 'pornhub is resolved via yt-dlp (browser headers) then the stealth sniffer fallback'
        };
      }
    }
    
    // yt-dlp binary gate: everything below this point needs the binary; all
    // fast-paths above (direct media, hanime stealth, pornhub resolve) run
    // without it.
    const binaryAvailable = await ensureYtDlpBinary();
    if (!binaryAvailable) {
      return { success: false, error: 'yt-dlp binary is not available', details: 'run the app once more to download it automatically' };
    }

    console.log(`[yt-dlp] Extracting stream info for: ${url}`);
    
    // Detect YouTube URLs for special handling
    const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');
    
    // Declare variables in outer scope to avoid ReferenceError
    let bestVideo = null;
    let bestAudio = null;
    let qualityLevels = [];
    
    let ytDlpArgs;
    if (isYouTube) {
      // YouTube: request ADAPTIVE HLS/DASH manifests up to 2160p instead of a
      // single 720p progressive MP4. --dump-json returns every format so the
      // player menu can list 1080p/1440p/2160p tiers, and — when the player
      // client serves HLS — a master .m3u8 that hls.js renders with all levels.
      ytDlpArgs = [
        url,
        '--dump-json',
        '-f', 'bestvideo[height<=2160]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=web_embedded,android,web'
      ];
    } else {
      // Other sites: use JSON output with impersonate for Cloudflare bypass.
      // -f 'b' picks the best combined stream (merges video+audio via ffmpeg
      // when the platform serves them separately).
      ytDlpArgs = [
        url,
        '--dump-json',
        '-f', 'b',
        '--extractor-args', 'generic:impersonate'
      ];
    }
    
    const rawOutput = await ytDlp.execPromise(withFFmpegArgs(ytDlpArgs));

    let info;
    let streamUrl = null;
    let isHLS = false;
    let httpHeaders = null;

    if (isYouTube) {
      // Single --dump-json round trip: formats + metadata in one response.
      try {
        info = JSON.parse(rawOutput);
      } catch (jsonErr) {
        return { success: false, error: 'Could not parse YouTube metadata', details: jsonErr.message };
      }
      const formats = Array.isArray(info.formats) ? info.formats : [];
      httpHeaders = info.http_headers || null;

      // Quality presets for the player menu: distinct heights, best first.
      qualityLevels = [];
      const seenRes = new Set();
      const byResDesc = (a, b) => {
        const aRes = (a.height || 0) * (a.width || 0);
        const bRes = (b.height || 0) * (b.width || 0);
        if (bRes !== aRes) return bRes - aRes;
        return (b.tbr || 0) - (a.tbr || 0);
      };
      const sortedFormats = [...formats].sort(byResDesc);
      for (const f of sortedFormats) {
        const label = f.format_note || (f.height ? `${f.height}p` : null) || f.format_id || null;
        const key = f.height || f.format_id;
        if (!label || seenRes.has(key)) continue;
        seenRes.add(key);
        qualityLevels.push({ formatId: f.format_id, label, height: f.height || 0, width: f.width || 0 });
      }

      // A specific format was requested (manual quality switch in the player).
      if (formatId) {
        const fmt = formats.find(f => f.format_id === formatId);
        if (fmt && (fmt.url || fmt.manifest_url)) {
          streamUrl = fmt.manifest_url || fmt.url;
          isHLS = fmt.protocol === 'm3u8' || fmt.protocol === 'm3u8_native' || /\.m3u8/i.test(streamUrl);
          httpHeaders = fmt.http_headers || httpHeaders;
        }
      } else {
        // 1) Adaptive HLS master playlist — every resolution tier (1080p/1440p/
        //    2160p) in one manifest; hls.js exposes them to the quality menu.
        const hlsMaster = sortedFormats.find(f =>
          (f.manifest_url && /\.m3u8/i.test(f.manifest_url)) || /\.m3u8/i.test(f.url || '')
        );
        if (hlsMaster) {
          streamUrl = hlsMaster.manifest_url || hlsMaster.url;
          isHLS = true;
        } else {
          // 2) Highest progressive stream that also carries the audio track so
          //    native playback is never silent.
          const progressive = sortedFormats.find(f =>
            f.url && f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
          );
          if (progressive) {
            streamUrl = progressive.url;
            isHLS = /\.m3u8/i.test(streamUrl);
          } else {
            // 3) Last resort: DASH video-only split (the <video> element has no
            //    muxer, so this only triggers when YouTube stops serving
            //    progressive/merged formats at all).
            const vOnly = sortedFormats.find(f => f.url && f.vcodec && f.vcodec !== 'none');
            if (vOnly) {
              streamUrl = vOnly.url;
              isHLS = /\.m3u8/i.test(streamUrl);
            }
          }
        }
      }
      if (!streamUrl) {
        return { success: false, error: 'No playable stream found for YouTube URL' };
      }
    } else {
      // Parse JSON output for other sites
      try {
        info = JSON.parse(rawOutput);
      } catch {
        info = JSON.parse('[' + rawOutput.replace(/\n/g, ',').slice(0, -1) + ']');
      }
      
      // Check for DRM protection (Widevine, PlayReady, FairPlay)
      const formats = info.formats || [];
      const hasDRM = formats.some(f => 
        (f.drm && f.drm !== 'none') || 
        (f.protocol && (f.protocol.includes('dash') || f.protocol.includes('ism')) && f.vcodec === 'none') ||
        (f.format_note && f.format_note.toLowerCase().includes('drm')) ||
        (f.url && f.url.includes('widevine'))
      );
      
      const isDRMProtected = info.is_drm || hasDRM || 
        (info.formats && info.formats.some(f => f.vcodec === 'none' && f.acodec === 'none' && f.url));
      
      if (isDRMProtected) {
        console.log(`[yt-dlp] DRM protected content detected for: ${url}`);
        return { 
          success: false, 
          error: 'DRM_PROTECTED', 
          details: 'Content is DRM protected (Widevine/PlayReady/FairPlay)',
          webUrl: url,
          title: info.title || 'Unknown Title',
          thumbnailUrl: info.thumbnail || info.thumbnails?.[0]?.url || '',
          duration: info.duration || 0,
          category: info.categories?.[0] || 'Video',
          sourceSite: info.extractor || getDomain(info.webpage_url || info.url)
        };
      }
      
      // Find the best quality stream
      const videoFormats = formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.url)
        .sort((a, b) => {
          const aRes = (a.height || 0) * (a.width || 0);
          const bRes = (b.height || 0) * (b.width || 0);
          if (bRes !== aRes) return bRes - aRes;
          return (b.tbr || 0) - (a.tbr || 0);
        });
      
      bestVideo = videoFormats[0];
      const audioFormats = formats
        .filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none' && f.url)
        .sort((a, b) => (b.abr || 0) - (a.abr || 0));
      
      bestAudio = audioFormats[0];

      // Max-quality with audio: native playback uses a single URL, so if the
      // top-resolution format is video-only (DASH split like many sites use),
      // prefer the highest-resolution progressive format that also carries the
      // audio track. Quality stays maximal where possible and audio never
      // drops out (which both improves the audible bitrate and prevents
      // silent video).
      const withAudio = formats
        .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && f.url)
        .sort((a, b) => {
          const aRes = (a.height || 0) * (a.width || 0);
          const bRes = (b.height || 0) * (b.width || 0);
          if (bRes !== aRes) return bRes - aRes;
          return (b.tbr || 0) - (a.tbr || 0);
        });
      if (!bestVideo || bestVideo.acodec === 'none' || !bestVideo.acodec) {
        if (withAudio.length > 0) bestVideo = withAudio[0];
      }
      // Surface the higher audio bitrate onto the picked format so the player
      // metadata/UI reflects the best available audio.
      if (bestVideo && !bestVideo.abr && bestAudio && bestAudio.abr) {
        bestVideo.abr = bestAudio.abr;
      }

      // Build a selectable quality list (distinct heights) for the player UI
      qualityLevels = [];
      const seenRes = new Set();
      for (const f of videoFormats) {
        const label = f.format_note || (f.height ? `${f.height}p` : null) || f.format || null;
        if (!label) continue;
        const key = f.height || f.format_id;
        if (seenRes.has(key)) continue;
        seenRes.add(key);
        qualityLevels.push({
          formatId: f.format_id,
          label,
          height: f.height || 0,
          width: f.width || 0
        });
      }

      // If a specific format was requested, re-resolve the stream with that format
      if (formatId) {
        try {
          const fmtOutput = await ytDlp.execPromise(withFFmpegArgs([
            url,
            '--dump-json',
            '-f', formatId,
            '--no-playlist',
            '--extractor-args', 'generic:impersonate'
          ]));
          const fmtInfo = JSON.parse(fmtOutput);
          if (fmtInfo && fmtInfo.url) {
            bestVideo = { url: fmtInfo.url, protocol: fmtInfo.protocol, http_headers: fmtInfo.http_headers, format: fmtInfo.format, resolution: fmtInfo.resolution, width: fmtInfo.width, height: fmtInfo.height, tbr: fmtInfo.tbr, format_note: fmtInfo.format_note };
            streamUrl = fmtInfo.url;
            isHLS = fmtInfo.url.includes('.m3u8') || fmtInfo.protocol === 'm3u8_native';
            httpHeaders = fmtInfo.http_headers || info.http_headers || null;
          }
        } catch (fmtErr) {
          console.warn('[yt-dlp] Format re-extraction failed, keeping best:', fmtErr.message);
        }
      }
      
      if (bestVideo) {
        streamUrl = bestVideo.url;
        isHLS = bestVideo.url.includes('.m3u8') || bestVideo.protocol === 'm3u8_native';
        httpHeaders = bestVideo.http_headers || info.http_headers || null;
      } else if (info.url) {
        streamUrl = info.url;
        isHLS = info.url.includes('.m3u8');
        httpHeaders = info.http_headers || null;
      }
    }
    
    if (!streamUrl) {
      return { success: false, error: 'No playable stream found' };
    }
    
    // Validate the extracted stream URL is a valid media stream
    if (!isValidMediaStreamUrl(streamUrl)) {
      console.warn('[yt-dlp] Extracted URL is not a valid media stream:', streamUrl);
      return { 
        success: false, 
        error: 'No playable media stream found on this page',
        details: 'Extracted URL is not a valid media stream'
      };
    }
    
    const result = {
      success: true,
      data: {
        id: info.id || `video-${Date.now()}`,
        title: info.title || 'Unknown Title',
        videoUrl: streamUrl,
        thumbnailUrl: info.thumbnail || info.thumbnails?.[0]?.url || '',
        duration: info.duration || 0,
        category: info.categories?.[0] || (isYouTube ? 'YouTube' : 'Video'),
        sourceSite: info.extractor || getDomain(info.webpage_url || info.url),
        isHLS: isHLS,
        selectedQuality: qualityLevels.length > 0 ? qualityLevels[0].label : null,
        qualityLevels: isYouTube ? [] : qualityLevels,
        // Include http_headers from yt-dlp for CDN compatibility
        httpHeaders: httpHeaders,
        formats: isYouTube ? null : {
          video: bestVideo ? {
            url: bestVideo.url,
            format: bestVideo.format,
            resolution: bestVideo.resolution,
            width: bestVideo.width,
            height: bestVideo.height,
            vcodec: bestVideo.vcodec,
            tbr: bestVideo.tbr
          } : null,
          audio: bestAudio ? {
            url: bestAudio.url,
            format: bestAudio.format,
            acodec: bestAudio.acodec,
            abr: bestAudio.abr
          } : null
        }
      }
    };
    
    console.log(`[yt-dlp] Successfully extracted stream for: ${info.title}`);
    
    // Persist the extracted video to the database so it appears in the library
    try {
      const { db: dbMod, error: dbErr } = getDbSafe();
      if (!dbErr && dbMod) {
        await dbMod.bulkInsertVideos([{
          id: result.data.id,
          title: result.data.title,
          videoUrl: result.data.videoUrl,
          thumbnailUrl: result.data.thumbnailUrl,
          duration: result.data.duration,
          category: result.data.category,
          sourceSite: result.data.sourceSite,
          scrapedAt: new Date().toISOString(),
          isScraped: true
        }]);
        console.log(`[yt-dlp] Saved "${info.title}" to media library`);
      }
    } catch (dbErr) {
      console.warn('[yt-dlp] Could not save to DB:', dbErr.message);
    }
    
    return result;
    
  } catch (err) {
    console.error('[yt-dlp] Extraction error:', err);
    // Check if error indicates DRM
    const errMsg = err.message.toLowerCase();
    if (errMsg.includes('drm') || errMsg.includes('widevine') || errMsg.includes('protected') || 
        errMsg.includes('encrypted') || errMsg.includes('license')) {
      return { 
        success: false, 
        error: 'DRM_PROTECTED', 
        details: err.message,
        webUrl: url
      };
    }
    return { 
      success: false, 
      error: 'Stream extraction failed', 
      details: err.message 
    };
  }
});

// ---------------------------------------------------------------------------
// Download manager state + progress helpers
// ---------------------------------------------------------------------------
let activeDownloads = [];
let downloadCounter = 0;

// Registry of live yt-dlp child processes spawned by this app (downloads) so
// they can be terminated at quit instead of lingering and holding file locks
// inside the install directory (%LOCALAPPDATA%\Programs\nekofal).
const activeChildProcs = new Set();

// Terminate every background child before exiting: directly-spawned download
// processes first, then sweep any remaining yt-dlp.exe trees (yt-dlp-wrap
// instances used for extraction don't expose process handles) including the
// ffmpeg merges they spawn, so no child keeps resources locked after quit.
function killBackgroundProcesses() {
  for (const proc of activeChildProcs) {
    try {
      proc.kill('SIGTERM');
    } catch (_e) { /* already gone */ }
  }
  activeChildProcs.clear();
  try {
    require('child_process').execSync('taskkill /im yt-dlp.exe /t /f', { windowsHide: true, stdio: 'ignore' });
  } catch (_e) { /* no matching process running */ }
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getActiveDownloads() {
  return activeDownloads.map(d => ({
    id: d.id,
    title: d.title,
    url: d.url,
    filePath: d.filePath,
    percent: Math.max(0, Math.min(100, d.percent || 0)),
    downloadedBytes: d.downloadedBytes || 0,
    totalBytes: d.totalBytes || 0,
    speed: d.speed || 0,
    eta: d.eta || 0
  }));
}

async function broadcastDownloads() {
  const { db: dbMod } = getDbSafe();
  let completed = [];
  if (dbMod && dbMod.getDownloads) {
    try {
      completed = await dbMod.getDownloads();
    } catch (err) {
      console.warn('[Downloads] Failed to load completed list:', err.message);
      completed = [];
    }
  }
  sendToRenderer('downloads:state', { active: getActiveDownloads(), completed });
}

function parseBinarySize(valueStr, unit) {
  const value = parseFloat(valueStr) || 0;
  if (!unit) return value;
  if (unit.includes('Gi')) return value * 1024 * 1024 * 1024;
  if (unit.includes('Mi')) return value * 1024 * 1024;
  if (unit.includes('Ki')) return value * 1024;
  return value * 1024 * 1024; // default to MiB-style parsing
}

function parseEta(etaStr) {
  if (!etaStr) return 0;
  const [m, s] = etaStr.split(':').map(Number);
  if (isNaN(m) || isNaN(s)) return 0;
  return m * 60 + s;
}

// Video download handler - native "Save As" with yt-dlp + live progress events
ipcMain.handle('video:download', async (event, video) => {
  const url = video?.url || video?.videoUrl;
  if (!url) return { success: false, error: 'No video URL provided' };
  const title = video?.title || video?.videoTitle || url;
  const suggestedFilename = video?.suggestedFilename || video?.title || video?.videoTitle || 'video.mp4';

  try {
    const binaryAvailable = await ensureYtDlpBinary();
    if (!binaryAvailable) {
      return { success: false, error: 'yt-dlp binary is not available' };
    }

    // Hanime: hand yt-dlp the direct .m3u8 manifest, never the raw page URL.
    // hanime.tv is a Cloudflare-guarded SPA so the generic extractor can't
    // resolve page links — resolveHanimeStream (v8 API/stealth sniff) gives
    // us the manifest URL to download directly.
    let targetUrl = url;
    if (/hanime\.tv/i.test(String(url))) {
      try {
        const hinfo = await resolveHanimeStream(url);
        if (!hinfo || !hinfo.m3u8) throw new Error('resolved to no playable manifest');
        console.log(`[Download] hanime ${url} -> ${hinfo.m3u8}`);
        targetUrl = hinfo.m3u8;
      } catch (hanErr) {
        console.warn(`[Download] hanime resolution failed: ${hanErr.message}`);
        return { success: false, error: `Hanime stream resolution failed: ${hanErr.message}` };
      }
    }

    // Pornhub: resolve to a direct manifest the same way (yt-dlp with browser
    // headers first, stealth sniff fallback) so the downloader never feeds a
    // bot-check page to yt-dlp.
    if (/pornhub\.com/i.test(String(url))) {
      try {
        const phinfo = await resolvePornhubStream(url);
        if (!phinfo || !phinfo.m3u8) throw new Error('resolved to no playable manifest');
        console.log(`[Download] pornhub ${url} -> ${phinfo.m3u8}`);
        targetUrl = phinfo.m3u8;
      } catch (phErr) {
        console.warn(`[Download] pornhub resolution failed: ${phErr.message}`);
        return { success: false, error: `Pornhub stream resolution failed: ${phErr.message}` };
      }
    }

    // Show save dialog
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Video As',
      defaultPath: suggestedFilename || 'video.mp4',
      filters: [
        { name: 'Video Files', extensions: ['mp4', 'mkv', 'webm', 'mov'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (canceled || !filePath) {
      return { success: false, error: 'Download canceled' };
    }

    const downloadId = `dl-${Date.now()}-${downloadCounter++}`;
    const download = {
      id: downloadId,
      title,
      url,
      filePath,
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      eta: 0
    };
    activeDownloads.push(download);

    console.log(`[Download] Starting download to: ${filePath}`);
    broadcastDownloads();

    const fs = require('fs');
    const ytDlpPath = getYtDlpPath();
    const args = withFFmpegArgs([
      targetUrl,
      ...(targetUrl !== url ? ['--referer', /hanime\.tv/i.test(url) ? 'https://hanime.tv/' : 'https://www.pornhub.com/'] : []),
      '-o', filePath,
      '-f', 'bestvideo[height<=2160]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--newline'
    ]);

    const proc = spawn(ytDlpPath, args, { windowsHide: true });
    activeChildProcs.add(proc);
    proc.on('error', () => activeChildProcs.delete(proc));
    let stderrTail = '';

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('[download]')) {
          const progressMatch = line.match(
            /\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)(KiB|MiB|GiB)(?:\s+at\s+([\d.]+)(KiB|MiB|GiB)\/s)?(?:\s+ETA\s+(\d{1,2}:\d{2}))?/i
          );
          if (progressMatch && download) {
            download.percent = parseFloat(progressMatch[1]);
            const totalBytes = parseBinarySize(progressMatch[2], progressMatch[3]);
            if (totalBytes) download.totalBytes = totalBytes;
            if (progressMatch[4]) download.speed = parseBinarySize(progressMatch[4], progressMatch[5]);
            if (progressMatch[6]) download.eta = parseEta(progressMatch[6]);
            download.downloadedBytes = Math.min(totalBytes, (download.percent / 100) * totalBytes);
            sendToRenderer('download:progress', { ...getActiveDownloads().find(d => d.id === downloadId) });
          }
        }
        const destinationMatch = line.match(/Destination:\s+(.+)\s*$/i);
        if (destinationMatch && download) {
          download.filePath = destinationMatch[1];
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString() + '\n').slice(-1500);
    });

    proc.on('close', async (code) => {
      activeChildProcs.delete(proc);
      activeDownloads = activeDownloads.filter(d => d.id !== downloadId);
      if (code === 0) {
        let sizeBytes = 0;
        try { sizeBytes = fs.statSync(download.filePath).size; } catch (e) { /* file may not exist */ }
        const completed = {
          id: downloadId,
          title: download.title || title,
          url: download.url,
          path: download.filePath,
          sizeBytes,
          completedAt: new Date().toISOString()
        };
        try {
          const { db: dbMod } = getDbSafe();
          if (dbMod && dbMod.addDownload) await dbMod.addDownload(completed);
        } catch (dbErr) {
          console.warn('[Download] Failed to record completion:', dbErr.message);
        }
        console.log(`[Download] Completed: ${download.filePath}`);
        sendToRenderer('download:completed', completed);
      } else {
        const errMsg = stderrTail.trim().split('\n').pop() || `yt-dlp exited with code ${code}`;
        console.log(`[Download] Failed (code ${code}): ${errMsg}`);
        sendToRenderer('download:error', { id: downloadId, title: download.title || title, error: errMsg });
      }
      broadcastDownloads();
    });

    // Wait a tick so the renderer receives the initial active state
    return { success: true, downloadId };
  } catch (err) {
    console.error('[Download] Error:', err);
    return { success: false, error: err.message };
  }
});

// Current download state (active + completed)
ipcMain.handle('downloads:getState', async () => {
  const { db: dbMod } = getDbSafe();
  let completed = [];
  if (dbMod && dbMod.getDownloads) {
    try { completed = await dbMod.getDownloads(); } catch (err) { completed = []; }
  }
  return { active: getActiveDownloads(), completed };
});

// Remove a completed download record
ipcMain.handle('downloads:remove', async (event, downloadId) => {
  try {
    const { db: dbMod, error } = getDbSafe();
    if (error) return { success: false, error };
    const result = await dbMod.removeDownload(downloadId);
    broadcastDownloads();
    return result;
  } catch (err) {
    console.error('[Downloads] Remove error:', err.message);
    return { success: false, error: err.message };
  }
});

// Reveal a downloaded file in the OS file explorer
ipcMain.handle('downloads:reveal', (event, filePath) => {
  try {
    if (filePath && require('fs').existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Save playback position for resume support
ipcMain.handle('db:saveVideoPosition', async (event, videoId, lastPosition) => {
  try {
    const { db: dbMod, error } = getDbSafe();
    if (error) return { success: false, error };
    return await dbMod.setVideoPosition(videoId, lastPosition);
  } catch (err) {
    console.error('[DB] Save position error:', err.message);
    return { success: false, error: err.message };
  }
});

// Helper to extract domain
function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'Unknown';
  }
}

// Save to local database (favorites/watch history)
// Normalizes both the canonical cloud payload { id, title, url, type, thumbnail, isAdult }
// and the legacy library shape { id, title, videoUrl, thumbnailUrl, sourceSite, ... }
// into the columns SQLite prefers.
function normalizeFavoriteVideo(videoData) {
  const source = videoData && typeof videoData === 'object' ? videoData : {};
  const str = (v) => (v == null ? '' : String(v).trim());
  const id = str(source.id ?? source.media_id ?? source.videoId);
  const title = str(source.title || source.videoTitle) || 'Untitled Video';
  const isAdult = typeof source.isAdult === 'boolean'
    ? source.isAdult
    : /^(true|1|yes|on)$/i.test(str(source.isAdult));
  return {
    id,
    title,
    media_id: str(source.media_id || id),
    videoUrl: str(source.videoUrl || source.url),
    thumbnailUrl: str(source.thumbnailUrl || source.thumbnail),
    sourceSite: str(source.sourceSite || source.type),
    tags: Array.isArray(source.tags) ? source.tags : typeof source.tags === 'string' ? [source.tags] : [],
    externalId: str(source.externalId),
    description: str(source.description),
    duration: Number(source.duration) > 0 ? Number(source.duration) : 0,
    isAdult: !!isAdult,
    category: str(source.category)
  };
}

// Validation for favorite save/toggle: the site+own id must exist (that is
// what favorites are keyed on), the url should be present, and everything is
// trimmed/coerced above. Returns { ok, error, video }.
function validateFavoritePayload(videoData) {
  const video = normalizeFavoriteVideo(videoData);
  if (!video.id) {
    return { ok: false, video, error: 'Favorite requires a valid video id (missing id/media_id)' };
  }
  if (!video.videoUrl) {
    return { ok: false, video, error: 'Favorite requires a playable url for video "' + video.title + '"' };
  }
  if (!video.title) {
    return { ok: false, video, error: 'Favorite requires a title' };
  }
  return { ok: true, video, error: null };
}

ipcMain.handle('db:setFavorite', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const { ok, video, error: validationError } = validateFavoritePayload(videoData);
    if (!ok) {
      return { success: false, error: validationError };
    }

    await db.setFavorite(video);
    
    return { success: true, message: 'Added to favorites' };
  } catch (err) {
    console.error('Add favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to add to favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getFavorites', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const favorites = await db.getFavorites();
    
    return { success: true, data: favorites };
  } catch (err) {
    console.error('Get favorites error:', err);
    return { 
      success: false, 
      error: 'Failed to get favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getVideos', async (event, limit = 100, offset = 0) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const videos = await db.getVideos(limit, offset);
    
    return { success: true, data: videos };
  } catch (err) {
    console.error('Get videos error:', err);
    return { 
      success: false, 
      error: 'Failed to get videos',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getVideosCount', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const count = await db.getVideosCount();
    
    return { success: true, count };
  } catch (err) {
    console.error('Get videos count error:', err);
    return { 
      success: false, 
      error: 'Failed to get videos count',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getVideoCategories', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const result = await db.getVideoCategories();
    
    return { success: true, ...result };
  } catch (err) {
    console.error('Get video categories error:', err);
    return { 
      success: false, 
      error: 'Failed to get video categories',
      details: err.message 
    };
  }
});

ipcMain.handle('db:removeFavorite', async (event, videoId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.removeFavorite(videoId);
    
    return { success: true, message: 'Removed from favorites' };
  } catch (err) {
    console.error('Remove favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to remove from favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:setHistory', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.setWatchHistory(videoData);
    
    return { success: true, message: 'Added to watch history' };
  } catch (err) {
    console.error('Add history error:', err);
    return { 
      success: false, 
      error: 'Failed to add to history',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getHistory', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const history = await db.getWatchHistory();
    
    return { success: true, data: history };
  } catch (err) {
    console.error('Get history error:', err);
    return { 
      success: false, 
      error: 'Failed to get watch history',
      details: err.message 
    };
  }
});

ipcMain.handle('db:clearAll', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.clearAll();
    
    return { success: true, message: 'Database cleared' };
  } catch (err) {
    console.error('Clear database error:', err);
    return { 
      success: false, 
      error: 'Failed to clear database',
      details: err.message 
    };
  }
});

ipcMain.handle('db:toggleFavorite', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const { ok, video, error: validationError } = validateFavoritePayload(videoData);
    if (!ok) {
      return { success: false, error: validationError };
    }

    const result = await db.toggleFavorite(video);

    // Local SQLite write is authoritative and immediate. Remote PocketBase
    // synchronization lives in the renderer (dbAdapter) and is strictly
    // best-effort/non-blocking — cloud network state can never block here.
    
    return { success: true, data: result };
  } catch (err) {
    console.error('Toggle favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to toggle favorite',
      details: err.message 
    };
  }
});

ipcMain.handle('db:checkIsFavorite', async (event, videoId, mediaId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const isFav = await db.checkIsFavorite(videoId, mediaId);
    
    return { success: true, favorited: isFav };
  } catch (err) {
    console.error('Check favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to check favorite',
      details: err.message 
    };
  }
});

// Permanently delete a media item (also cleans favorites/playlist references)
ipcMain.handle('db:deleteMedia', async (event, videoId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    return await db.deleteVideo(videoId);
  } catch (err) {
    console.error('[DB] Delete media error:', err.message);
    return { success: false, error: err.message };
  }
});

// Playlists
ipcMain.handle('playlists:list', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    const playlists = await db.getPlaylists();
    return { success: true, data: playlists };
  } catch (err) {
    console.error('[Playlists] list error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('playlists:create', async (event, { name, description }) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    if (!name || !String(name).trim()) return { success: false, error: 'Playlist name is required' };
    return await db.createPlaylist(name, description);
  } catch (err) {
    console.error('[Playlists] create error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('playlists:delete', async (event, playlistId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    return await db.deletePlaylist(playlistId);
  } catch (err) {
    console.error('[Playlists] delete error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('playlists:addItem', async (event, { playlistId, video }) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    return await db.addToPlaylist(playlistId, video);
  } catch (err) {
    console.error('[Playlists] addItem error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('playlists:removeItem', async (event, itemId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    return await db.removeFromPlaylist(itemId);
  } catch (err) {
    console.error('[Playlists] removeItem error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('playlists:items', async (event, playlistId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    const items = await db.getPlaylistItems(playlistId);
    return { success: true, data: items };
  } catch (err) {
    console.error('[Playlists] items error:', err.message);
    return { success: false, error: err.message };
  }
});

// ---------- Floating mini player (PiP) ----------
ipcMain.handle('mini:open', (event, payload) => {
  try {
    return openMiniPlayer(payload);
  } catch (err) {
    console.error('[Mini] open error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mini:close', () => {
  closeMiniPlayer();
  return { success: true };
});

// ---------- Backup & Restore ----------
ipcMain.handle('backup:export', async (event) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    const data = await db.exportData();
    const defaultName = `nekofal-backup-${new Date().toISOString().slice(0, 10)}.json`;

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Nekofal Backup',
      defaultPath: defaultName,
      filters: [
        { name: 'Nekofal Backup', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }

    fs.writeFileSync(result.filePath, JSON.stringify(data, null, 2), 'utf-8');
    return {
      success: true,
      path: result.filePath,
      counts: {
        playlists: data.playlists.length,
        playlistItems: data.playlistItems.length,
        favorites: data.favorites.length,
        iptvSources: data.iptvSources.length
      }
    };
  } catch (err) {
    console.error('[Backup] export error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('backup:import', async (event) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Nekofal Backup',
      properties: ['openFile'],
      filters: [
        { name: 'Nekofal Backup', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { success: false, canceled: true };
    }

    const filePath = result.filePaths[0];
    const raw = fs.readFileSync(filePath, 'utf-8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      return { success: false, error: 'Backup file is not valid JSON' };
    }

    if (!['nekofal', 'yakfal-hub'].includes(data.app) || !Array.isArray(data.playlists)) {
      return { success: false, error: 'Not a Nekofal backup file' };
    }

    const imported = await db.importData(data);
    return { success: true, source: filePath, counts: imported.counts };
  } catch (err) {
    console.error('[Backup] import error:', err.message);
    return { success: false, error: err.message };
  }
});

  // Scraper: Run configured scrapers and store results in database
ipcMain.handle('scrapers:run', async (event, urls) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const { executeScrapeFunction } = require('../backends/main.js');
    
    let targetUrls = [];
    let sourceSiteMap = {};

    // Prefer URLs passed from the renderer (Settings -> Sync Scrapers Now)
    if (Array.isArray(urls) && urls.length > 0) {
      targetUrls = urls.filter(u => typeof u === 'string' && u.trim() !== '');
    } else {
      // Fallback: read scrapers from the config file
      const fs = require('fs');
      const configPath = './config/settings.config.js';
      let settings = { scrapers: [], timeout: 30000, maxPages: 5 };
      
      if (fs.existsSync(configPath)) {
        try {
          settings = require(configPath);
        } catch {}
      }
      
      const scrapers = settings.scrapers || [];
      if (scrapers.length === 0) {
        return { success: false, error: 'No scrapers configured. Add URLs in Settings.' };
      }
      
      for (const scraper of scrapers) {
        const scraperUrls = Array.isArray(scraper.baseUrls) ? scraper.baseUrls : [scraper.baseUrls];
        for (const url of scraperUrls) {
          targetUrls.push(url);
          sourceSiteMap[url] = scraper.siteName || getDomain(url);
        }
      }
    }
    
    if (targetUrls.length === 0) {
      return { success: false, error: 'No URLs to scrape.' };
    }
    
    let totalInserted = 0;
    const errors = [];
    
    // Helper to generate video ID
    const generateVideoId = (sourceUrl, title) => {
      return 'vid-' + Buffer.from(`${sourceUrl}-${title}-${Date.now()}`).toString('hex').substring(0, 12);
    };

    for (const url of targetUrls) {
      try {
        console.log(`Scraping: ${url}`);
        
        const result = await executeScrapeFunction({
          url,
          timeout: 30000,
          maxPages: 5,
          sourceSite: sourceSiteMap[url] || getDomain(url)
        });
        
        // Backend now returns array of videos directly
        const videos = Array.isArray(result) ? result : (result?.videos || []);
        
        if (videos.length > 0) {
          // Validate and add metadata to each video
          const videosWithMeta = videos.map(v => {
            // Ensure required fields exist
            const title = v.title || 'Untitled Video';
            const videoUrl = v.videoUrl || url;
            const thumbnailUrl = v.thumbnail || v.thumbnailUrl || null;
            
            return {
              id: v.id || generateVideoId(url, title),
              title: title,
              videoUrl: videoUrl,
              thumbnailUrl: thumbnailUrl,
              duration: v.duration || 0,
              category: v.category || 'Video',
              sourceSite: v.sourceSite || sourceSiteMap[url] || getDomain(url),
              externalId: v.externalId || null,
              description: v.description || '',
              scrapedAt: v.scrapedAt || new Date().toISOString(),
              isScraped: v.isScraped !== undefined ? v.isScraped : true
            };
          }).filter(v => v.title && v.videoUrl); // Filter out invalid entries
          
          if (videosWithMeta.length > 0) {
            const insertResult = await db.bulkInsertVideos(videosWithMeta);
            totalInserted += insertResult.inserted || 0;
          }
        }
      } catch (err) {
        console.error(`Scraper error for ${url}:`, err.message);
        errors.push({ url, error: err.message });
      }
    }
    
    const count = await db.getVideosCount();
    
    return { 
      success: true, 
      inserted: totalInserted,
      totalVideos: count,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (err) {
    console.error('Scrapers run error:', err);
    return { 
      success: false, 
      error: 'Scraper run failed',
      details: err.message 
    };
  }
});

// Get saved scrapers
ipcMain.handle('db:getScrapers', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const scrapers = await db.getScrapers();
    
    return { success: true, data: scrapers };
  } catch (err) {
    console.error('Get scrapers error:', err);
    return { 
      success: false, 
      error: 'Failed to get scrapers',
      details: err.message 
    };
  }
});

// Save scrapers to database
ipcMain.handle('db:saveScrapers', async (event, scrapers) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const result = await db.saveScrapers(scrapers);
    
    return { success: true, data: result };
  } catch (err) {
    console.error('Save scrapers error:', err);
    return { 
      success: false, 
      error: 'Failed to save scrapers',
      details: err.message 
    };
  }
});

// Get scraping backends list
ipcMain.handle('backends:list', async () => {
  try {
    const fs = require('fs');
    const dir = './backends';
    
    if (!fs.existsSync(dir)) {
      return { success: false, error: 'Backends directory not found' };
    }

    const files = fs.readdirSync(dir);
    const validExtensions = ['.js', '.mjs'];
    const backends = files.filter(f => 
      f.endsWith(validExtensions[0]) || 
      f.endsWith(validExtensions[1])
    ).map(file => file.replace('.js', '').replace('.mjs', ''));

    return { 
      success: true, 
      backends 
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Execute a scraping backend function
ipcMain.handle('backends:execute', async (event, { backendName, url }) => {
  try {
    require('child_process').execSync(`npm run build`, { 
      stdio: 'pipe',
      cwd: path.resolve('.')
    });

    const fs = require('fs');
    const dir = './backends';
    const backendPath = path.join(dir, `${backendName}${url.includes('.js') ? '.js' : '.mjs'}`);
    const configPath = './config/backends.config.js';

    if (!fs.existsSync(backendPath)) {
      return { 
        success: false, 
        error: 'Backend not found',
        details: `Could not find backend: ${backendName}`
      };
    }

    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, "module.exports = {};\n");
    }
    
    const config = require(configPath);
    const { executeScraper } = require(backendPath);

    const result = await executeScraper({ 
      url,
      timeout: config.timeout || 30000,
      maxPages: config.maxPages || 5
    });

    return { 
      success: true, 
      data: result,
      backend: backendName,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('Scraper execution error:', err);
    return { 
      success: false, 
      error: 'Scraper execution failed',
      details: err.message
    };
  }
});

// Execute scraping with specific backend
ipcMain.handle('scraper:execute', async () => {
  try {
    const defaultPath = './backends/main.js';
    const fs = require('fs');
    const configPath = './config/scraper.config.js';

    if (!fs.existsSync(defaultPath)) {
      return { 
        success: false, 
        error: 'Default scraper not found',
        details: 'Please add a backend to ./backends/'
      };
    }

    const config = require(configPath);
    
    const { executeScrapeFunction } = require(defaultPath);

    return await executeScrapeFunction({ 
      url: config.defaultScraperUrl || '',
      timeout: 30000,
      maxPages: 5
    });
  } catch (err) {
    console.error('Default scraper error:', err);
    return { 
      success: false, 
      error: 'Failed to execute default scraper',
      details: err.message
    };
  }
});


// ============================================
// IPTV / M3U Playlist Support
// ============================================

function parseM3U(content, baseUrl = '') {
  const channels = [];
  const lines = content.split('\n').map(l => l.trim());
  let currentChannel = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('#EXTM3U')) {
      continue; // Header
    }
    
    if (line.startsWith('#EXTINF:')) {
      // Parse EXTINF line: #EXTINF:<duration>,<title>
      // Or extended: #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Channel Name
      // Custom headers (e.g. http-user-agent="Mozilla/5.0 ...") may contain
      // commas INSIDE quoted values, so the title is the text AFTER the LAST
      // comma that sits outside any quotes.
      const infoLine = line;
      const attrs = {};

      const splitInfo = (text) => {
        let inQuote = null;
        let lastComma = -1;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (inQuote) {
            if (ch === inQuote) inQuote = null;
          } else if (ch === '"' || ch === "'") {
            inQuote = ch;
          } else if (ch === ',') {
            lastComma = i;
          }
        }
        const attrsText = lastComma >= 0 ? text.slice(0, lastComma) : text;
        const title = lastComma >= 0 ? text.slice(lastComma + 1).trim() : '';
        return { attrsText: attrsText.trim(), title };
      };

      const { attrsText, title: rawTitle } = splitInfo(infoLine);

      // Extract attribute pairs in either quote style: key="value" or key='value'
      const attrRegex = /([\w][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
      let match;
      while ((match = attrRegex.exec(attrsText)) !== null) {
        attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
      }

      const title = rawTitle || attrs['tvg-name'] || attrs['name'] || 'Unknown Channel';

      // Map custom http-* attributes (e.g. http-user-agent="...") to real headers
      // so recorded channels send them during playback.
      const httpHeaders = {};
      const headerMap = { 'user-agent': 'User-Agent', 'referer': 'Referer', 'origin': 'Origin', 'cookie': 'Cookie' };
      for (const k of Object.keys(attrs)) {
        const m = /^http-(.+)$/i.exec(k);
        if (m && attrs[k]) {
          const key = headerMap[m[1].toLowerCase()] || m[1];
          httpHeaders[key] = attrs[k];
        }
      }

      currentChannel = {
        name: title,
        duration: parseInt(infoLine.match(/#EXTINF:-?(\d+(?:\.\d+)?)/)?.[1] || '-1'),
        logo: attrs['tvg-logo'] || attrs['logo'] || '',
        group: attrs['group-title'] || attrs['group'] || 'Uncategorized',
        tvgId: attrs['tvg-id'] || '',
        attrs,
        httpHeaders
      };
      continue;
    }

    if (line.startsWith('#EXTGRP:')) {
      // Group title for following channels
      if (currentChannel) {
        currentChannel.group = line.substring(8).trim();
      }
      continue;
    }

if (line.startsWith('#EXTVLCOPT:') || line.startsWith('#EXTHTTP:') || line.startsWith('#KODIPROP:')) {
      // VLC/Kodi-specific options or HTTP headers - store for later playback.
      // Attribute form (http-user-agent="...") inside #EXTINF is mapped above,
      // while line form (#EXTVLCOPT:http-user-agent=..., #EXTHTTP:...) is mapped here.
      if (currentChannel) {
        if (!currentChannel.httpHeaders) currentChannel.httpHeaders = {};
        const optMatch = line.match(/#EXTVLCOPT:([^=]+)=(.*)/);
        const httpMatch = line.match(/#EXTHTTP:(\w+)=(.*)/);
        const kodiMatch = line.match(/#KODIPROP:([^=]+)=(.*)/);
        if (optMatch) currentChannel.httpHeaders[optMatch[1].trim()] = optMatch[2].trim();
        if (httpMatch) currentChannel.httpHeaders[httpMatch[1].trim()] = httpMatch[2].trim();
        if (kodiMatch) currentChannel.httpHeaders[kodiMatch[1].trim()] = kodiMatch[2].trim();
      }
      continue;
    }

    if (line && !line.startsWith('#')) {
      // This is a stream URL
      if (currentChannel) {
        let streamUrl = line.trim();
        
        // Resolve relative URLs
        if (baseUrl && !streamUrl.startsWith('http') && !streamUrl.startsWith('//')) {
          try {
            const base = new URL(baseUrl);
            if (streamUrl.startsWith('/')) {
              streamUrl = `${base.protocol}//${base.host}${streamUrl}`;
            } else {
              streamUrl = new URL(streamUrl, baseUrl).href;
            }
          } catch (e) {
            // Keep as-is if resolution fails
          }
        } else if (streamUrl.startsWith('//')) {
          streamUrl = 'https:' + streamUrl;
        }
        
        channels.push({
          name: currentChannel.name,
          url: streamUrl,
          logo: currentChannel.logo,
          group: currentChannel.group,
          tvgId: currentChannel.tvgId,
          duration: currentChannel.duration,
          httpHeaders: currentChannel.httpHeaders || {}
        });
        
        currentChannel = null;
      } else {
        // URL without preceding EXTINF
        channels.push({
          name: `Channel ${channels.length + 1}`,
          url: line.trim(),
          logo: '',
          group: 'Uncategorized',
          tvgId: '',
          duration: -1,
          httpHeaders: {}
        });
      }
    }
  }
  
  return channels;
}

ipcMain.handle('iptv:addSource', async (event, { name, url }) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    console.log(`[IPTV] Fetching playlist: ${url}`);
    const response = await require('axios').get(url, {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      maxRedirects: 5,
      validateStatus: s => s < 500
    });

    if (response.status >= 400) {
      return { success: false, error: `HTTP ${response.status} fetching playlist` };
    }

    // Always decode as UTF-8 regardless of the server's (often missing) charset,
    // so channel names never come back as ANSI/CP1252 mojibake.
    const playlistText = new TextDecoder('utf-8').decode(Buffer.from(response.data));

    const channels = parseM3U(playlistText, url);
    if (channels.length === 0) {
      return { success: false, error: 'No channels found in the playlist. Make it\'s a valid M3U/M3U8 file.' };
    }

    // Stable source id based on the playlist URL so re-adding the same list refreshes it
    // instead of duplicating channels
    const crypto = require('crypto');
    const sourceId = 'iptv-src-' + crypto.createHash('sha1').update(url).digest('hex').substring(0, 16);
    const existingSource = await db.getIptvSourceByUrl(url);

    // Save/replace source to iptv_sources table
    await db.addIptvSource({ id: sourceId, name: name || 'IPTV Source', url, channelCount: channels.length });

    // Refresh semantics: drop this source's old channels before (re)inserting
    if (existingSource) {
      await db.deleteVideosByExternalId(sourceId);
    }

    const normalizeName = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/gi, ' ').replace(/\s+/g, ' ').trim();

    // Existing channel names (other sources only — the current source was just
    // cleared above on refresh). iptv-org language and category lists share a
    // lot of channels, so dedupe by normalized name to avoid duplicates.
    const existingChannels = await db.getVideosBySource('IPTV');
    const byName = new Map(existingChannels.map(v => [normalizeName(v.title), true]));
    const seenHere = new Map();

    // id is a hash of the FULL stream URL (not a prefix) so every channel gets
    // a unique key. Re-importing the same playlist replaces cleanly.
    const videos = [];
    for (const ch of channels) {
      const nameKey = normalizeName(ch.name);
      if (!nameKey || byName.has(nameKey) || seenHere.has(nameKey)) continue;

      const group = (ch.group || '').trim();
      videos.push({
        id: 'iptv-ch-' + crypto.createHash('sha1').update(ch.url).digest('hex'),
        title: ch.name,
        videoUrl: ch.url,
        thumbnailUrl: ch.logo,
        duration: 0,
        category: group && group.toLowerCase() !== 'undefined' ? group : 'Uncategorized',
        sourceSite: 'IPTV',
        externalId: sourceId,
        scrapedAt: new Date().toISOString(),
        isScraped: false,
        type: 'Web TV',
        httpHeaders: ch.httpHeaders || {}
      });
      byName.set(nameKey, true);
      seenHere.set(nameKey, true);
    }

    // Save/replace source with the number of channels actually kept
    await db.addIptvSource({ id: sourceId, name: name || 'IPTV Source', url, channelCount: videos.length });

    const insertResult = await db.bulkInsertVideos(videos);
    console.log(`[IPTV] Added ${insertResult.inserted} channels from "${name || url}" (${channels.length} parsed, ${videos.length} kept after dedupe)`);

    // One-time migration: purge legacy rows from the old colliding-id importer
    try {
      await db.deleteLegacyIptv();
    } catch (e) {
      console.warn('[IPTV] Legacy cleanup skipped:', e.message);
    }

    return { success: true, inserted: insertResult.inserted, sourceId, channelCount: videos.length };
  } catch (err) {
    console.error('[IPTV] Failed to add source:', err);
    return { success: false, error: 'Failed to add IPTV source: ' + err.message };
  }
});

ipcMain.handle('iptv:getSources', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    const sources = await db.getIptvSources();
    return { success: true, data: sources };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('iptv:removeSource', async (event, sourceId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    await db.removeIptvSource(sourceId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('db:getVideosBySource', async (event, sourceSite) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    const videos = await db.getVideosBySource(sourceSite);
    return { success: true, data: videos };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Web search: find/aggregate videos from anywhere (YouTube search, or any
// URL/category/search page) using yt-dlp flat-playlist enumeration, with a
// generic HTML scraper fallback for sites yt-dlp cannot flatten.
// ---------------------------------------------------------------------------
function normalizeSearchEntry(entry, fallbackSite) {
  const crypto = require('crypto');
  const url = entry.webpage_url || entry.url || '';
  return {
    id: entry.id ? `${(entry.extractor || 'web')}-${entry.id}` : `web-${crypto.createHash('sha1').update(url).digest('hex').substring(0, 16)}`,
    title: (entry.title || entry.fulltitle || 'Untitled').substring(0, 200),
    thumbnailUrl: entry.thumbnail || (entry.thumbnails && entry.thumbnails[0] && entry.thumbnails[0].url) || '',
    videoUrl: url,
    duration: entry.duration || 0,
    category: entry.channel || entry.playlist_title || 'Video',
    sourceSite: entry.extractor || entry.ie_key || entry.playlist_title || fallbackSite || 'Web',
    extractor: entry.extractor || entry.ie_key || 'ytdlp'
  };
}

// ---- Hanime v8 engine ------------------------------------------------
// Native API: https://hanime.tv/api/v8/search (POST) returns elastic hits with
// slugs; https://hanime.tv/api/v8/video?id={slug} returns the videos_manifest
// with the master .m3u8. Requests go over net.fetch (Chromium stack) with
// standard browser headers, so cookies/TLS look like a normal browser session.
const HANIME_API = 'https://hanime.tv/api/v8';

function hanimeHeaders(cookieHeader, browser = false) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': browser ? '' : 'https://hanime.tv',
    'Referer': browser ? 'https://hanime.tv/' : 'https://hanime.tv/',
    'Content-Type': 'application/json'
  };
  if (browser) delete headers.Origin;
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

async function hanimeV8Search(query, count = 25) {
  const body = {
    search_text: String(query || '').trim(),
    tags: [],
    brands: []
  };
  const cookieHeader = await getSessionCookieHeader('https://hanime.tv/');
  const res = await fetch(`${HANIME_API}/search`, {
    method: 'POST',
    headers: hanimeHeaders(cookieHeader),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Hanime v8 search HTTP ${res.status}`);
  const data = await res.json();
  const hits = (data && data.data && data.data.hits && data.data.hits.hits) || [];
  const videos = [];
  for (const h of hits) {
    const src = h && h._source ? h._source : (h || {});
    const slug = h && h._source ? h._source.slug : (h.slug || '');
    if (!slug) continue;
    videos.push({
      id: `hanime-${slug}`,
      title: (src.name || 'Untitled').trim(),
      thumbnailUrl: src.poster_url || src.cover_url || src.thumb_url || '',
      videoUrl: `https://hanime.tv/videos/hentai/${slug}`,
      duration: src.duration_in_ms ? Math.floor(Number(src.duration_in_ms) / 1000) : 0,
      category: 'Hanime',
      sourceSite: 'hanime.tv',
      extractor: 'hanime-v8',
      description: src.description || ''
    });
    if (videos.length >= count) break;
  }
  return videos;
}

async function hanimeV8Video(slug) {
  const cookieHeader = await getSessionCookieHeader('https://hanime.tv/');
  const res = await fetch(`${HANIME_API}/video?id=${encodeURIComponent(slug)}`, {
    method: 'GET',
    headers: hanimeHeaders(cookieHeader, true),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Hanime v8 video HTTP ${res.status}`);
  const data = await res.json();
  const v = data && data.data ? data.data.video : (data.video || data);
  if (!v) throw new Error('Hanime video payload missing');
  const manifest = v.videos_manifest;
  const server = (manifest && Array.isArray(manifest.servers) && manifest.servers[0]) || null;
  const stream = server && server.streams && server.streams[0];
  const m3u8 = (stream && stream.url) || '';
  return {
    id: String(v.id || slug),
    title: v.name || v.title || 'Untitled',
    thumbnailUrl: v.poster_url || v.cover_url || '',
    duration: v.duration_in_ms ? Math.floor(Number(v.duration_in_ms) / 1000) : 0,
    m3u8,
    canPlay: /\.m3u8/i.test(m3u8) || /m3u8/i.test(m3u8)
  };
}

// Resolve a hanime.tv page URL to its playable master playlist.
async function resolveHanimeStream(pageUrl) {
  const m = /hanime\.tv\/videos\/hentai\/([a-zA-Z0-9_-]+)/i.exec(String(pageUrl || ''));
  const slug = m ? m[1] : '';
  if (!slug) throw new Error('Not a hanime.tv video URL');
  try {
    const info = await hanimeV8Video(slug);
    if (info.m3u8) return { ...info, slug };
  } catch (v8Err) {
    console.warn(`[resolveHanimeStream] v8 video failed (trying stealth sniff): ${v8Err.message}`);
  }
  // Stealth fallback: render the page in the offscreen browser and wait (up to
  // 20s) for Cloudflare/Turnstile to clear in the background, intercepting the
  // master .m3u8 the site's HLS player requests as soon as it appears — the
  // resolver tears the offscreen window down the instant a valid manifest is
  // captured instead of waiting out a fixed timer. cf_clearance / __cf_bm (and
  // any v8 session cookies) persist in session.defaultSession, so the *next*
  // video load on this machine skips the challenge entirely.
  const sniff = await sniffWithEarlyReturn(pageUrl, {
    timeoutMs: 20000,
    match: (e) => /\.m3u8/i.test(String(e.url || '')) || /hanime\.tv\/api\/v8\/video/i.test(String(e.url || ''))
  });
  const m3u8 = sniff.matchedUrl || (sniff.streams && sniff.streams.find(s => /\.m3u8/i.test(String(s || '')))) || null;
  if (!m3u8) throw new Error('No .m3u8 manifest found for ' + slug);
  return { id: `hanime-${slug}`, slug, m3u8, canPlay: true, title: '', thumbnailUrl: '', duration: 0, viaSniff: true };
}

// ---- Pornhub resolver ----------------------------------------------------
// Pornhub is supported by yt-dlp, but the CDN rejects default/U-A-less
// requests. Try yt-dlp with explicit browser headers first; if that fails or
// returns a bot-check / empty result, fall back to the offscreen stealth
// browser — load the video page, let the embedded player fire its HLS request
// (intercepted by the stream sniffer), and read the master .m3u8 out of
// window.flashvars.mediaDefinitions as a belt-and-suspenders source.
const PH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function resolvePornhubStream(pageUrl) {
  let ytError = null;
  try {
    const rawJson = await ytDlp.execPromise(withFFmpegArgs([
      pageUrl,
      '--dump-json',
      '-f', 'best[height<=2160]/best',
      '--no-playlist',
      '--socket-timeout', '25',
      '--user-agent', PH_UA,
      '--referer', 'https://www.pornhub.com/'
    ]));
    const info = JSON.parse(rawJson);
    const formats = info.formats || [];
    const m3u8 = formats.find(f => /\.m3u8/i.test(String(f.url || '')) && f.vcodec && f.vcodec !== 'none')
      ?.url || info.url || '';
    if (m3u8) {
      return { m3u8, title: info.title || '', duration: info.duration || 0, fromYT: true };
    }
    ytError = new Error('no playable format returned by yt-dlp');
  } catch (err) {
    ytError = err;
    console.warn(`[pornhub] yt-dlp failed (trying stealth sniff): ${err.message}`);
  }

  // Stealth fallback: render the page in the offscreen browser (real
  // fingerprint), capture the master .m3u8 as soon as the player requests it,
  // and probe flashvars for the mediaDefinition videoUrl as a DOM backup.
  const sniff = await sniffWithEarlyReturn(pageUrl, {
    timeoutMs: 20000,
    match: (e) => /\.m3u8/i.test(String(e.url || '')) || (/\.mp4/i.test(String(e.url || '')) && /phncdn\.com/i.test(String(e.url || ''))),
    probe: async () => {
      const val = await evalInStealth(
        `var fv = window.flashvars || {}; var md = fv.mediaDefinitions || [];` +
        `for (var i = 0; i < md.length; i++) { if (md[i] && /\.m3u8/i.test(md[i].videoUrl || '')) { return md[i].videoUrl; } }` +
        `return '';`, 5000);
      return typeof val === 'string' && val ? val : null;
    }
  });
  const m3u8 = sniff.matchedUrl
    || (sniff.streams && sniff.streams.find(s => /\.m3u8/i.test(String(s || ''))))
    || (sniff.streams && sniff.streams[0])
    || null;
  if (!m3u8) {
    throw new Error('No playable stream for ' + pageUrl + (ytError ? ' (yt-dlp: ' + ytError.message + ')' : ' (nothing found)'));
  }
  return { m3u8, title: '', duration: 0, fromYT: false };
}

async function searchHanime(query, count = 25) {
  let lastErr = null;
  // Fast path: official v8 search API. It now re-attaches the cf_clearance /
  // __cf_bm cookies the stealth browser stored in defaultSession, so the POST
  // presents the same cleared session to Cloudflare instead of re-challenging.
  try {
    const v8 = await hanimeV8Search(query, count);
    if (v8.length > 0) return v8;
  } catch (v8Err) {
    lastErr = v8Err;
    console.warn(`[searchHanime] v8 search failed, falling back to stealth browser: ${v8Err.message}`);
  }

  // Stealth browser: drive https://hanime.tv/search inside the offscreen window
  // (genuine fingerprint, Turnstile auto-solved, cf_clearance stored in
  // defaultSession) and read the rendered result cards straight from the DOM.
  try {
    const stealthVideos = await stealthAutoSearch('https://hanime.tv/search', query, count);
    if (stealthVideos.length > 0) {
      const hanimeLinks = stealthVideos.filter(v => /hanime\.tv\/videos\/hentai\//i.test(v.videoUrl || ''));
      if (hanimeLinks.length > 0) {
        console.log(`[searchHanime] stealth DOM returned ${hanimeLinks.length} results`);
        return hanimeLinks.slice(0, count);
      }
    }
  } catch (stealthErr) {
    lastErr = stealthErr;
    console.warn(`[searchHanime] stealth search failed: ${stealthErr.message}`);
  }

  const e = lastErr || new Error('No Hanime search backend reachable');
  e.message += ' (Hanime v8 API and stealth hanime.tv/search are currently unreachable/blocked)';
  throw e;
}

// XVideos actively blocks headless tooling (Axios/undici TLS fingerprints and
// automation headers; yt-dlp flat enumeration also gets challenged). Search its
// HTML with Electron's native network stack instead: net.fetch is Chromium, so
// it presents a genuine browser TLS/HTTP/2 signature. Combined with desktop
// Chrome request headers this passes the anti-bot layer, then we parse the
// "mozaique" grid with cheerio.
async function xvideosSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    'Referer': 'https://www.xvideos.com/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-site',
    'DNT': '1'
  };

  const res = await net.fetch(searchUrl, {
    method: 'GET',
    headers: browserHeaders,
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${res.statusText}) from ${searchUrl}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const videos = [];

  $('.mozaique .thumb-block').each((_i, el) => {
    const block = $(el);
    const link = block.find('a[href*="/video"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = href.startsWith('http') ? href : `https://www.xvideos.com${href}`;
    const title = (
      block.find('.title a').attr('title') ||
      link.attr('title') ||
      block.find('img').first().attr('alt') ||
      'Untitled'
    ).trim().substring(0, 200);

    const img = block.find('img').first();
    const thumb = img.attr('data-src') || img.attr('src') || '';

    const durText = block.find('.duration').text().trim();
    let duration = 0;
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    if (dm) {
      duration = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
    }

    const profile = block.find('.profile-name').first().text().trim();
    if (!abs.startsWith('http')) return;

    videos.push({
      id: `xvideos-${Buffer.from(abs).toString('hex').substring(0, 16)}`,
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      duration,
      category: profile || 'XVideos',
      sourceSite: 'xvideos.com',
      extractor: 'xvideos-html'
    });
  });

  // Deduplicate URLs (the same clip can appear in multiple grid slots).
  const seen = new Set();
  return videos
    .filter(v => {
      if (seen.has(v.videoUrl)) return false;
      seen.add(v.videoUrl);
      return true;
    })
    .slice(0, count || 25);
}

// XVideos offscreen-DOM engine: if net.fetch is still challenged, render the
// search page inside the stealth browser window (real browser fingerprint,
// Turnstile auto-solved, cf_clearance cookies in defaultSession) and extract
// the ".mozaique" grid straight from the rendered DOM. Mirrors the same
// normalized shape as the net.fetch variant.
const XV_GRID_SCRIPT = `
var out = [];
var blocks = [].slice.call(document.querySelectorAll('.mozaique .thumb-block'));
for (var i = 0; i < blocks.length; i++) {
  var b = blocks[i];
  var link = b.querySelector('a[href*="/video"]');
  if (!link) continue;
  var href = link.getAttribute('href') || '';
  var abs = /^https?:/i.test(href) ? href : 'https://www.xvideos.com' + href;
  if (!abs) continue;
  var titleEl = b.querySelector('.title a');
  var title = (titleEl && (titleEl.getAttribute('title') || titleEl.textContent.trim())) || '';
  if (!title) title = link.getAttribute('title') || '';
  if (!title) title = (b.querySelector('img') || {}).alt || 'Untitled';
  var img = b.querySelector('img');
  var thumb = img ? (img.getAttribute('data-src') || img.src || '') : '';
  var d = (b.querySelector('.duration') || {}).textContent || '';
  var dur = 0;
  var dm = d.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
  if (dm) dur = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
  var profile = (b.querySelector('.profile-name') || {}).textContent || '';
  out.push({ title: title.slice(0, 200), thumb: thumb, url: abs, duration: dur, profile: profile.trim() });
  if (out.length >= __LIMIT__) break;
}
return { out: out, href: location.href };
`;

async function xvideosStealthSearch(searchUrl, count = 25) {
  const win = ensureStealthWindow();
  const load = await loadInStealth(searchUrl, { pauseAfterLoadMs: 1200, challengeTimeoutMs: 20000 });
  if (!load.success) throw new Error('XVideos stealth load failed: ' + load.error);
  const code = XV_GRID_SCRIPT.replace('__LIMIT__', String(count || 25));
  const extracted = await evalInStealth(code, 8000);
  const list = (extracted && Array.isArray(extracted.out)) ? extracted.out : [];
  if (extracted && extracted.__stealthError) {
    throw new Error('XVideos DOM extraction failed: ' + extracted.__stealthError);
  }
  return list.map((r) => ({
    id: `xvideos-${Buffer.from(r.url).toString('hex').substring(0, 16)}`,
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    duration: r.duration || 0,
    category: r.profile || 'XVideos',
    sourceSite: 'xvideos.com',
    extractor: 'xvideos-stealth'
  }));
}

// ---- Pornhub search --------------------------------------------------------
// Pornhub's search page mixes the result grid with a top nav, a sidebar filter
// list and a language-filter bar (anchors pointing at /language/ plus "English /
// French / Spanish …" chips). Generic card walkers grab those and return junk,
// so pornhub gets its own selector set: match ONLY the real video card nodes
// (ul#videoSearchResult li, li.pcVideoListItem, div.ph-thumbnail-component),
// ignore anything living inside nav/header/filter bars, drop /language/ links,
// and pull the card's actual title, duration and thumbnail.
const PH_ALLOWED_CARDS = 'ul#videoSearchResult li, li.pcVideoListItem, div.ph-thumbnail-component';
const PH_VIDEO_LINK = 'a[href*="view_video.php"], a[href*="watch"], a[href*="/videos/"]';
const PH_IGNORED_ANCESTRY = 'nav, header, #header, .topNav, .mainNav, .subMenu, .filter-wrapper, .languageTop, .languageBar, .ph-sidebar';
const PH_LANG_TEXT = /^(All|All Languages|English|French|German|Italian|Spanish|Portuguese|Japanese|Chinese|Korean|Russian|Hindi|Indonesian|Turkish|Polish|Dutch|Arabic|Thai|Vietnamese|Czech|Swedish|Norwegian|Danish|Finnish|Ukrainian|Romanian|Greek|Hungarian|Hebrew)$/i;

function pornhubCardDuration(durText) {
  const m = String(durText || '').match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
  if (!m) return 0;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}

async function pornhubSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const browserHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    'Referer': 'https://www.pornhub.com/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-site',
    'DNT': '1'
  };

  const res = await net.fetch(searchUrl, {
    method: 'GET',
    headers: browserHeaders,
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText}) from ${searchUrl}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const videos = [];

  $(PH_ALLOWED_CARDS).each((_i, el) => {
    const card = $(el);
    if (card.closest(PH_IGNORED_ANCESTRY).length) return;
    const link = card.find(PH_VIDEO_LINK).first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    if (/\/language\//i.test(href)) return;
    const abs = href.startsWith('http') ? href : `https://www.pornhub.com${href}`;
    if (!abs.startsWith('http') || !/view_video\.php|\/videos\//i.test(abs)) return;
    const title = (
      card.find('span.title a').attr('title') ||
      link.attr('title') ||
      card.find('.title').first().text().trim() ||
      card.find('img').first().attr('alt') ||
      'Untitled'
    ).trim().substring(0, 200);
    if (PH_LANG_TEXT.test(title)) return;
    const img = card.find('img').first();
    const thumb = img.attr('data-thumb_url') || img.attr('data-src') || img.attr('src') || '';
    const duration = pornhubCardDuration(card.find('.duration, .video-duration, var.duration').first().text());

    videos.push({
      id: `pornhub-${Buffer.from(abs).toString('hex').substring(0, 16)}`,
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      duration,
      category: 'Pornhub',
      sourceSite: 'pornhub.com',
      extractor: 'pornhub-html'
    });
  });

  const seen = new Set();
  return videos
    .filter(v => {
      if (seen.has(v.videoUrl)) return false;
      seen.add(v.videoUrl);
      return true;
    })
    .slice(0, count || 25);
}

// Pornhub offscreen-DOM engine: render the search page in the stealth browser
// window and read the rendered cards with the same pornhub-only selectors (a
// real browser fingerprint passes the bot checks net.fetch sometimes trips).
// NOTE: this is a JS template literal AND a script string — every regex needs
// its backslashes doubled (\\d survives to \d in the evaluated code).
const PH_GRID_SCRIPT = `
var out = [];
var ignored = ['nav', 'header', '#header', '.topNav', '.mainNav', '.subMenu', '.filter-wrapper', '.languageTop', '.languageBar', '.ph-sidebar'].join(',');
var langText = /^(All|All Languages|English|French|German|Italian|Spanish|Portuguese|Japanese|Chinese|Korean|Russian|Hindi|Indonesian|Turkish|Polish|Dutch|Arabic|Thai|Vietnamese|Czech|Swedish|Norwegian|Danish|Finnish|Ukrainian|Romanian|Greek|Hungarian|Hebrew)$/i;
var cards = [].slice.call(document.querySelectorAll('ul#videoSearchResult li, li.pcVideoListItem, div.ph-thumbnail-component'));
var seen = {};
for (var i = 0; i < cards.length; i++) {
  if (out.length >= __LIMIT__) break;
  var c = cards[i];
  if (c.closest && c.closest(ignored)) continue;
  var link = c.querySelector('a[href*="view_video.php"], a[href*="watch"], a[href*="/videos/"]');
  if (!link) continue;
  var href = link.getAttribute('href') || '';
  if (!href || /\\/language\\//i.test(href)) continue;
  var abs = /^https?:/i.test(href) ? href : 'https://www.pornhub.com' + href;
  if (!/^https?:/.test(abs) || !/view_video\\.php|\\/videos\\//i.test(abs)) continue;
  if (seen[abs]) continue;
  var titleLink = c.querySelector('span.title a, .title a');
  var title = (link.getAttribute('title') || (titleLink ? (titleLink.getAttribute('title') || titleLink.textContent) : '') || (c.querySelector('.title') || {}).textContent || (c.querySelector('img') || {}).alt || '').trim();
  if (!title || langText.test(title)) continue;
  var img = c.querySelector('img');
  var thumb = img ? (img.getAttribute('data-thumb_url') || img.getAttribute('data-src') || img.src || '') : '';
  var durEl = c.querySelector('.duration') || c.querySelector('.video-duration') || c.querySelector('var.duration');
  var d = (durEl && durEl.textContent) || '';
  var dur = 0;
  var dm = d.match(/(?:(\\d+)h\\s*)?(\\d+):(\\d+)/);
  if (dm) dur = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
  seen[abs] = true;
  out.push({ title: title.slice(0, 200), thumb: thumb, url: abs, duration: dur });
}
return { out: out, href: location.href };
`;

async function pornhubStealthSearch(searchUrl, count = 25) {
  const win = ensureStealthWindow();
  const load = await loadInStealth(searchUrl, { pauseAfterLoadMs: 1500, challengeTimeoutMs: 20000 });
  if (!load.success) throw new Error('Pornhub stealth load failed: ' + load.error);
  await sleep(7000);
  const code = PH_GRID_SCRIPT.replace('__LIMIT__', String(count || 25));
  const extracted = await evalInStealth(code, 9000);
  const list = (extracted && Array.isArray(extracted.out)) ? extracted.out : [];
  if (extracted && extracted.__stealthError) {
    throw new Error('Pornhub DOM extraction failed: ' + extracted.__stealthError);
  }
  return list.map((r) => ({
    id: `pornhub-${Buffer.from(r.url).toString('hex').substring(0, 16)}`,
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    duration: r.duration || 0,
    category: 'Pornhub',
    sourceSite: 'pornhub.com',
    extractor: 'pornhub-stealth'
  })).slice(0, count || 25);
}

// Base URL of the self-hosted Express gateway (same server as PocketBase,
// default port 3000). Used as the server-side search fallback when the local
// yt-dlp binary is missing/broken or returns no results.
function resolveGatewayBaseUrl(explicit) {
  const envUrl = String(process.env.YAKFAL_GATEWAY_URL || '').trim().replace(/\/+$/, '');
  if (envUrl) return envUrl;
  const candidate = String(explicit || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return 'http://localhost:3000';
}

async function gatewayVideoSearch(baseUrl, params) {
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/api/scrape/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json && json.success && Array.isArray(json.videos) && json.videos.length > 0) {
      return { success: true, source: json.source || 'gateway', videos: json.videos, fallback: true };
    }
    const msg = (json && json.error && typeof json.error === 'string') ? json.error : 'Gateway fallback found nothing';
    return { success: false, error: msg, source: json && json.source, fallback: true };
  } catch (err) {
    console.warn('[web:search] gateway fallback failed:', err.message);
    return { success: false, error: 'Gateway fallback unreachable: ' + err.message, fallback: true };
  }
}

async function runFlatPlaylist(searchUrlOrQuery, count = 25) {
  const isTextSearch = !/^https?:\/\//i.test(searchUrlOrQuery);
  const target = isTextSearch ? `ytsearch${count}:${searchUrlOrQuery}` : searchUrlOrQuery;
  const rawJson = await ytDlp.execPromise(withFFmpegArgs([
    target,
    '--flat-playlist',
    '--dump-single-json',
    '--playlist-end', String(count + 5),
    '--no-warnings',
    '--socket-timeout', '20',
    '--extractor-args', 'generic:impersonate'
  ]));
  const doc = JSON.parse(rawJson);
  const entries = (doc && doc.entries) ? doc.entries : [doc];
  return entries;
}

ipcMain.handle('web:search', async (event, { mode, query, siteUrl, count = 25, gatewayUrl }) => {
  try {
    if (!query || typeof query !== 'string' || !query.trim()) {
      return { success: false, error: 'Nothing to search for' };
    }

    const q = query.trim();
    const gatewayBase = resolveGatewayBaseUrl(gatewayUrl);

    // yt-dlp unavailable/broken: delegate the whole search to the server gateway.
    const binaryAvailable = await ensureYtDlpBinary();
    if (!binaryAvailable) {
      console.log('[web:search] yt-dlp unavailable -> using gateway server-side search');
      return gatewayVideoSearch(gatewayBase, { query: q, mode, siteUrl, count });
    }

    // Resolve the target that yt-dlp should enumerate:
    // mode 'yt'    => plain text -> YouTube search
    // mode 'site'  => a site search template containing {query}, or a bare
    //                 site URL (homepage/base) -> auto form-search (no guessing)
    // mode 'enum'  => treat input as a literal URL to flatten
    let target = q;
    if (mode === 'site' && siteUrl && siteUrl.includes('{query}')) {
      target = siteUrl.replace(/\{query\}/g, encodeURIComponent(q));
    } else if (mode === 'site' && siteUrl) {
      target = String(siteUrl).trim().replace(/\/+$/, '');
    } else if (mode === 'enum' && !/^https?:\/\//i.test(q)) {
      return { success: false, error: 'Enter a full http(s) URL to fetch a page' };
    }

    console.log(`[web:search] mode=${mode} target=${target}`);
    let entries = [];

    // Custom base sites (no {query} template): locate the site's search form in
    // the stealth browser and run the query natively — no ?k= guessing needed.
    if (mode === 'site' && siteUrl && !siteUrl.includes('{query}') && /^https?:\/\//i.test(target)) {
      const customVideos = await stealthAutoSearch(target, q, count);
      if (customVideos.length > 0) {
        console.log(`[web:search] custom form search returned ${customVideos.length} results`);
        return { success: true, source: 'custom-form', videos: customVideos };
      }
    }

    // Hanime is an SPA — yt-dlp can't enumerate its search pages and there is
    // no HTML to scrape, so query its native JSON API directly.
    if (/^https?:\/\//i.test(target) && /hanime\.tv/i.test(target)) {
      const hanimeVideos = await searchHanime(q, count);
      if (hanimeVideos.length > 0) {
        console.log(`[web:search] hanime v8 API returned ${hanimeVideos.length} results`);
        return { success: true, source: 'hanime-v8', videos: hanimeVideos };
      }
    }

    // Pornhub: the search page's top nav / sidebar filters / language bar
    // (/language/ + "English / French / Spanish" chips) confuse generic card
    // walkers. Parse the result grid with pornhub-specific selectors instead —
    // HTML first (net.fetch), then the offscreen (real-browser) DOM engine.
    if (/^https?:\/\//i.test(target) && /(^|\.)pornhub\.com$/i.test(new URL(target).hostname)) {
      const phSearchUrl = /[?&](?:search|query)=/i.test(target)
        ? target
        : 'https://www.pornhub.com/video/search?search=' + encodeURIComponent(q);
      let phVideos = [];
      try {
        phVideos = await pornhubSearchHtml(phSearchUrl, count);
      } catch (phErr) {
        console.warn(`[web:search] pornhub HTML search failed: ${phErr.message}`);
      }
      if (phVideos.length === 0) {
        try {
          phVideos = await pornhubStealthSearch(phSearchUrl, count);
          console.log('[web:search] pornhub stealth DOM fallback engaged');
        } catch (phErr) {
          console.warn(`[web:search] pornhub stealth search failed: ${phErr.message}`);
        }
      }
      if (phVideos.length > 0) {
        console.log(`[web:search] pornhub search returned ${phVideos.length} results`);
        return { success: true, source: 'pornhub', videos: phVideos };
      }
    }

    // XVideos blocks yt-dlp enumeration and plain scrapers, so search its HTML
    // with the Chromium network stack (net.fetch) + browser headers first, then
    // fall back to the offscreen (real-browser) DOM engine.
    if (/^https?:\/\//i.test(target) && /(^|\.)xvideos\.com$/i.test(new URL(target).hostname)) {
      let xvVideos = [];
      try {
        xvVideos = await xvideosSearchHtml(target, count);
      } catch (xvErr) {
        console.warn(`[web:search] xvideos HTML search failed: ${xvErr.message}`);
      }
      if (xvVideos.length === 0) {
        try {
          xvVideos = await xvideosStealthSearch(target, count);
          console.log('[web:search] xvideos stealth DOM fallback engaged');
        } catch (stealthErr) {
          console.warn(`[web:search] xvideos stealth search failed: ${stealthErr.message}`);
        }
      }
      if (xvVideos.length > 0) {
        console.log(`[web:search] xvideos search returned ${xvVideos.length} results`);
        return { success: true, source: 'xvideos', videos: xvVideos };
      }
    }

    try {
      entries = await runFlatPlaylist(target, count);
    } catch (flatErr) {
      console.warn(`[web:search] flat-playlist failed for ${target}: ${flatErr.message}`);
    }

    let videos = entries
      .filter(e => e && e._type !== 'playlist' && e.id && e.id !== 'N/A' && ((e.webpage_url || e.url)))
      .map(e => normalizeSearchEntry(e, getDomain(target)))
      .filter(v => v.videoUrl && v.videoUrl.startsWith('http'));

    // Deduplicate
    const seen = new Set();
    videos = videos.filter(v => {
      if (seen.has(v.videoUrl)) return false;
      seen.add(v.videoUrl);
      return true;
    }).slice(0, count);

    if (videos.length > 0) {
      return { success: true, source: 'yt-dlp', videos };
    }

    // Stealth fallback for site searches: yt-dlp blocked/challenged a search
    // URL -> load the already-substituted results URL in the offscreen (real
    // browser) engine and read the rendered result cards from the DOM.
    if (mode === 'site' && /^https?:\/\//i.test(target)) {
      const stealthVideos = await stealthAutoSearch(target, q, count);
      if (stealthVideos.length > 0) {
        console.log(`[web:search] stealth fallback returned ${stealthVideos.length} results`);
        return { success: true, source: 'stealth', videos: stealthVideos };
      }
    }

    // Fallback: HTML scraping for sites yt-dlp can't enumerate
    console.log(`[web:search] flat-playlist gave nothing for ${target}, trying HTML scraper`);
    const { executeScrapeFunction } = require('../backends/main.js');
    const scraped = await executeScrapeFunction({
      url: target,
      timeout: 20000,
      maxPages: 1,
      sourceSite: getDomain(target)
    });
    const scrapedVideos = (Array.isArray(scraped) ? scraped : (scraped?.videos || []))
      .map(v => ({
        id: v.id || `scraped-${Buffer.from(v.videoUrl || v.url || target).toString('hex').substring(0, 12)}`,
        title: v.title || 'Untitled',
        thumbnailUrl: v.thumbnail || v.thumbnailUrl || '',
        videoUrl: v.videoUrl || v.url || '',
        duration: v.duration || 0,
        category: v.category || 'Video',
        sourceSite: v.sourceSite || getDomain(target),
        extractor: 'html-scraper'
      }))
      .filter(v => v.videoUrl && v.videoUrl.startsWith('http'))
      .slice(0, count);

    if (scrapedVideos.length > 0) {
      return { success: true, source: 'html-scraper', videos: scrapedVideos };
    }

    // Last resort: delegate the search to the server-side gateway.
    console.log(`[web:search] local search gave nothing for ${target}, trying gateway`);
    const gatewayResult = await gatewayVideoSearch(gatewayBase, { query: q, mode, siteUrl, count });
    if (gatewayResult.success) {
      return gatewayResult;
    }

    return {
      success: false,
      error: 'No videos found. This site may block automation — try a category/search page URL, a direct video URL, or another provider. (Gateway fallback: ' + (gatewayResult.error || 'no results') + ')',
      details: `target: ${target}`
    };
  } catch (err) {
    console.error('[web:search] error:', err.message);
    // yt-dlp threw mid-search: fall back to the server-side gateway before failing.
    try {
      const gatewayResult = await gatewayVideoSearch(gatewayBase, { query: q, mode, siteUrl, count });
      if (gatewayResult.success) return gatewayResult;
    } catch (_gwErr) { /* keep the original error */ }
    return { success: false, error: 'Search failed: ' + err.message, details: err.message };
  }
});

ipcMain.handle('web:addVideos', async (event, { videos, tags }) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    if (!Array.isArray(videos) || videos.length === 0) {
      return { success: false, error: 'No videos to add' };
    }
    const now = new Date().toISOString();
    const toInsert = videos.map(v => ({
      id: v.id || `web-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      title: v.title || v.videoTitle || 'Untitled',
      videoUrl: v.videoUrl || v.url || '',
      thumbnailUrl: v.thumbnailUrl || v.thumbnail || '',
      duration: v.duration || 0,
      category: v.category || (tags && tags.category) || 'Video',
      sourceSite: v.sourceSite || (tags && tags.sourceSite) || 'Web',
      type: v.type || (tags && tags.type) || 'Scraped Show',
      description: v.description || '',
      scrapedAt: now,
      isScraped: true,
      httpHeaders: v.httpHeaders || null
    }));
    const result = await db.bulkInsertVideos(toInsert);
    return { success: true, inserted: result.inserted || 0 };
  } catch (err) {
    console.error('[web:addVideos] error:', err);
    return { success: false, error: 'Failed to add videos: ' + err.message };
  }
});

// yt-dlp bulk scrape: extract video info from a list of URLs and persist
ipcMain.handle('scrapers:ytDlpBulk', async (event, { urls, sourceSite }) => {
  try {
    const binaryAvailable = await ensureYtDlpBinary();
    if (!binaryAvailable) {
      return { success: false, error: 'yt-dlp binary is not available' };
    }

    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    let inserted = 0;
    const errors = [];

    for (const url of urls) {
      try {
        // Hanime must never reach yt-dlp.exe — route through the stealth
        // resolver (v8 API + offscreen .m3u8 sniff) like stream extraction.
        if (/hanime\.tv/i.test(url)) {
          const h = await resolveHanimeStream(url);
          await db.bulkInsertVideos([{
            id: h.id || `hanime-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
            title: h.title || 'Hanime video',
            videoUrl: h.m3u8 || url,
            thumbnailUrl: h.thumbnailUrl || '',
            duration: h.duration || 0,
            category: 'Hanime',
            sourceSite: 'hanime.tv',
            scrapedAt: new Date().toISOString(),
            isScraped: true
          }]);
          inserted++;
          continue;
        }
        const rawJson = await ytDlp.execPromise(withFFmpegArgs([
          url, '--dump-json', '-f', 'b',
          '--extractor-args', 'generic:impersonate'
        ]));
        const info = JSON.parse(rawJson);
        const formats = info.formats || [];
        const videoFormats = formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.url);
        const bestVideo = videoFormats.sort((a, b) => {
          const aRes = (a.height || 0) * (a.width || 0);
          const bRes = (b.height || 0) * (b.width || 0);
          return bRes !== aRes ? bRes - aRes : (b.tbr || 0) - (a.tbr || 0);
        })[0];

        const streamUrl = bestVideo?.url || info.url;
        if (!streamUrl) { errors.push({ url, error: 'No stream found' }); continue; }

        await db.bulkInsertVideos([{
          id: info.id || `yt-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
          title: info.title || 'Unknown',
          videoUrl: streamUrl,
          thumbnailUrl: info.thumbnail || info.thumbnails?.[0]?.url || '',
          duration: info.duration || 0,
          category: info.categories?.[0] || 'Video',
          sourceSite: sourceSite || info.extractor || getDomain(info.webpage_url || url),
          scrapedAt: new Date().toISOString(),
          isScraped: true
        }]);
        inserted++;
      } catch (err) {
        console.warn(`[yt-dlp bulk] Failed for ${url}:`, err.message);
        errors.push({ url, error: err.message });
      }
    }

    return { success: true, inserted, errors: errors.length > 0 ? errors : undefined };
  } catch (err) {
    return { success: false, error: err.message };
  }
});


  // Initialize database FIRST, then create window
  app.whenReady().then(async () => {
    await initializeAppDatabase();
    await ensureYtDlpBinary();
    
    isReady = true;
    if (!mainWindow) createWindow();
    await startVideoServer();
    setupWebRequestHeaders();
    ensureDirectories();
    registerMediaShortcuts();
    credentialVault.init(app.getPath('userData'));
    setupAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && BrowserWindow.getAllWindows().length === 0) {
      if (videoServer && typeof videoServer.close === 'function') {
        videoServer.close();
      }
      app.quit();
    }
  });

  app.on('before-quit', () => {
    closeMiniPlayer();
    destroyStealthWindow();
    globalShortcut.unregisterAll();
    if (videoServer && typeof videoServer.close === 'function') {
      try { videoServer.close(); } catch (_e) { /* already closed */ }
    }
    killBackgroundProcesses();
  });

  // Prevent window from opening twice
  app.whenReady().then(() => {
    if (!mainWindow && process.env.NODE_ENV === 'development') {
      createWindow();
    }
  });
