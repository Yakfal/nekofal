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

const { app, BrowserWindow, ipcMain, session, dialog, shell, globalShortcut, net, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
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
// Live playback state pushed by the renderer (mediaActive). Used to auto-float
// to the MiniPlayer when the main window is minimized during active playback.
let mediaActiveResume = null;

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

// Node.js availability probe for yt-dlp's --js-runtimes. YouTube now requires
// a JS runtime to evaluate its player JavaScript (EJS). yt-dlp tolerates a
// missing/unusable runtime gracefully, but passing the flag with no node on
// PATH still logs EJS warnings for nothing — so it is added only when a real
// node binary is probed (once, cached). Child processes get a fresh PATH so
// 'node' resolves to the standalone binary even inside packaged Electron.
let jsRuntimeAvailable = null;
function isJsRuntimeAvailable() {
  if (jsRuntimeAvailable !== null) return jsRuntimeAvailable;
  try {
    const probe = spawnSync('node', ['--version'], {
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }
    });
    jsRuntimeAvailable = probe.status === 0 && /^v\d+\./.test(String(probe.stdout || ''));
  } catch {
    jsRuntimeAvailable = false;
  }
  if (!jsRuntimeAvailable) {
    console.log('node not found on PATH; omitting --js-runtimes node for yt-dlp.');
  }
  return jsRuntimeAvailable;
}

function withJsRuntimeArgs(args) {
  if (!isJsRuntimeAvailable()) return args;
  return [...args, '--js-runtimes', 'node'];
}

// All yt-dlp invocations: ffmpeg + optional JS runtime in one wrapper.
function withYtDlpArgs(args) {
  return withJsRuntimeArgs(withFFmpegArgs(args));
}

// True for yt-dlp formats that resolve to an HLS (m3u8) master playlist.
// The <video> element + hls.js plays these directly, and YouTube's per-tier
// HLS variants carry BOTH video and audio at every level — so a 4K/1440p
// "video-only" m3u8 format still plays with sound (unlike raw DASH splits).
function isHlsFormat(f) {
  if (!f) return false;
  const proto = String(f.protocol || '').toLowerCase();
  const url = String(f.manifest_url || f.url || '');
  return proto === 'm3u8' || proto === 'm3u8_native'
    || /\.m3u8/i.test(url)
    || /\/manifest\/hls_variant\//i.test(url) || /\/api\/manifest\//i.test(url);
}

// Readable quality label for a yt-dlp format: adds (2K)/(4K) suffixes so the
// player menu clearly shows the high-resolution tiers.
function ytQualityLabel(f) {
  if (f && f.format_note && String(f.format_note).trim()) {
    const note = String(f.format_note).trim();
    if (note.includes('2160p') && !note.includes('4K')) return `${note} (4K)`;
    if (note.includes('1440p') && !note.includes('2K')) return `${note} (2K)`;
    return note;
  }
  const h = f && f.height;
  if (h >= 4320) return '8K';
  if (h === 2160) return '2160p (4K)';
  if (h === 1440) return '1440p (2K)';
  if (h) return `${h}p`;
  return (f && (f.format || f.format_id)) || 'auto';
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
    titleBarStyle: 'default',
    autoHideMenuBar: true
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

  // Auto-mini player: when the main window is minimized during active playback,
  // ask the renderer to float the current video into the MiniPlayer (it closes
  // the in-window player so there is no double audio). Nothing happens when no
  // media is active, or when the mini is already up.
  mainWindow.on('minimize', () => {
    if (!mediaActiveResume || !mediaActiveResume.payload) return;
    if (miniPlayerWindow && !miniPlayerWindow.isDestroyed()) return;
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (wc && !wc.isDestroyed()) {
      wc.send('minimize-to-mini');
    }
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
    show: false,
    autoHideMenuBar: true
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

    // Pornhub CDN fix: phncdn.com media hosts and pornhub.com pages reject
    // requests with a missing/wrong Referer, Origin or UA. Stamp a full
    // www.pornhub.com referer + origin + desktop Chrome/124 UA on every host
    // in the CDN family so the HLS segments and player/API calls authenticate
    // (also overrides the VLC-style UA the isStream branch above would
    // otherwise attach).
    if (/\.(?:phncdn\.com|pornhub\.com)$/i.test(hostname)) {
      headers['Referer'] = 'https://www.pornhub.com/';
      headers['Origin'] = 'https://www.pornhub.com';
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
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
  // v1.0.31: run the stealth window off-screen instead of offscreen-rendered.
  // Some Cloudflare/Turnstile checks fingerprint the offscreen compositor and
  // mark it a bot; a real (but out-of-bounds and never shown) window paints
  // through the normal compositor and passes those checks.
  stealthWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    x: -10000,
    y: -10000,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    autoHideMenuBar: true,
    backgroundColor: '#0B0F17',
    webPreferences: {
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

    win.loadURL(url, {
      userAgent: STEALTH_UA,
      ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {})
    }).catch(err => done({ error: err.message }));
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
    .filter(u => !isAdNetworkUrl(u))
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
async function sniffWithEarlyReturn(pageUrl, { timeoutMs = 20000, pauseAfterLoadMs = 1500, match, probe, extraHeaders } = {}) {
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

  loadInStealth(pageUrl$, { pauseAfterLoadMs, challengeTimeoutMs: 20000, timeoutMs: Math.max(timeoutMs, 25000), extraHeaders })
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
  return list.map((r) => ({
    id: scrapeVideoId(`custom_${host || 'site'}`, r.url),
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    pageUrl: r.url,
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
  // electron-updater expects a function returning Promise<null> to bypass signature validation
  autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);

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
ipcMain.handle('scrapers:extractStream', async (event, { url, formatId, height }) => {
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
          isHls: /\.m3u8/i.test(info.m3u8),
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
          isHls: typeof ph.isHls === 'boolean' ? ph.isHls : /\.m3u8/i.test(ph.m3u8),
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

    // Wrapper sites (Zhentube / HentaiHaven / Uncensored-Hentai): the video
    // page is a thin shell around a third-party stream host, and its DOM is
    // littered with ad-network iframes. Extract the real stream ourselves first
    // (ad overlays filtered out): a direct .mp4/.m3u8 goes straight to the
    // player; a media-host embed URL is handed back to yt-dlp below (its
    // dedicated streamtape/doodstream/mp4upload extractors handle those).
    if (/^https?:/i.test(url) && isWrapperSiteUrl(url)) {
      const wrapperOrigin = (() => { try { return new URL(url).origin + '/'; } catch { return ''; } })();
      try {
        const wrap = await resolveEmbeddedPageStream(url);
        if (wrap && wrap.direct) {
          console.log(`[wrapper] direct ${url} -> ${wrap.streamUrl}`);
          return {
            success: true,
            streamUrl: wrap.streamUrl,
            isHls: /\.m3u8/i.test(wrap.streamUrl),
            extractor: 'wrapper-direct',
            httpHeaders: {
              'User-Agent': PH_UA,
              'Referer': wrapperOrigin
            }
          };
        }
        if (wrap && wrap.embedUrl) {
          console.log(`[wrapper] embed ${url} -> ${wrap.embedUrl}`);
          url = wrap.embedUrl;
        }
      } catch (wrapErr) {
        console.warn(`[wrapper] extraction failed (letting yt-dlp try): ${wrapErr.message}`);
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
      // YouTube: dump ALL formats (DASH + per-tier HLS) up to 2160p with the
      // default client so the player menu lists every resolution tier (incl.
      // 1440p (2K) / 2160p (4K)). Calling with a restrictive `-f` expression
      // or a restricted player_client roster reduces the manifest to a single
      // low-res progressive format, so we deliberately omit both and consume
      // info.formats directly. The per-tier m3u8 (m3u8_native) formats carry
      // video+audio at every height, so 4K/2K play with sound via hls.js.
      ytDlpArgs = [
        url,
        '-j',
        '--no-playlist'
      ];
    } else {
      // Other sites: use JSON output with impersonate for Cloudflare bypass.
      // -f 'b' picks the best combined stream (merges video+audio via ffmpeg
      // when the platform serves them separately).
      ytDlpArgs = [
        url,
        '-j',
        '--no-playlist',
        '-f', 'b',
        '--extractor-args', 'generic:impersonate'
      ];
    }
    
    const rawOutput = await ytDlp.execPromise(withYtDlpArgs(ytDlpArgs));

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

      // Direct-URL format list for instant, no-re-extraction quality switching:
      // one entry per height, preferring a form that carries audio so playback
      // never turns silent mid-switch. YouTube's per-tier HLS (m3u8_native)
      // formats are the ONLY ≥1080p sources with audio at that tier — hls.js
      // renders the manifest directly, so we treat any .m3u8 format as
      // audio-capable and use its manifest_url as the playable URL.
      const menuFormats = [];
      const byHeightBest = new Map();
      for (const f of formats) {
        if (!f.vcodec || f.vcodec === 'none') continue;
        const hlsLike = isHlsFormat(f);
        const url = f.manifest_url || f.url || '';
        if (!url) continue;
        const key = f.height || f.format_id;
        if (!key) continue;
        const candidate = {
          formatId: f.format_id,
          label: ytQualityLabel(f),
          height: f.height || 0,
          width: f.width || 0,
          url,
          protocol: f.protocol || '',
          httpHeaders: f.http_headers || null,
          hasAudio: hlsLike || !!(f.acodec && f.acodec !== 'none'),
          tbr: f.tbr || 0
        };
        const prev = byHeightBest.get(key);
        if (!prev || (candidate.hasAudio && !prev.hasAudio) || (candidate.hasAudio === prev.hasAudio && (candidate.tbr || 0) > (prev.tbr || 0))) {
          byHeightBest.set(key, candidate);
        }
      }
      for (const f of [...byHeightBest.values()].sort(byResDesc)) {
        menuFormats.push({ label: f.label, height: f.height, url: f.url, httpHeaders: f.httpHeaders, hasAudio: f.hasAudio, formatId: f.formatId, protocol: f.protocol });
      }

      // A specific format was requested (manual quality switch in the player).
      if (formatId) {
        const fmt = formats.find(f => f.format_id === formatId);
        if (fmt && (fmt.url || fmt.manifest_url)) {
          const fmtHls = isHlsFormat(fmt);
          // HLS tiers: manifest_url is the master playlist (with audio).
          // Progressive/DASH: the raw .url may include a limiting query.
          streamUrl = fmtHls ? (fmt.manifest_url || fmt.url) : (fmt.url || fmt.manifest_url);
          isHLS = fmtHls;
          httpHeaders = fmt.http_headers || httpHeaders;
        }
      } else if (height) {
        // A specific resolution tier was requested (standard-quality fallback
        // used when the extraction could not enumerate per-height formats).
        //
        // 1) Prefer an already-scraped menu tier at or below the cap — zero
        //    extra yt-dlp round-trips and the CDN signatures are fresh from
        //    the same manifest. HLS tiers carry audio, so sound is preserved.
        // 2) Only as a last resort re-resolve against the page itself.
        const heightTier = [...byHeightBest.values()]
          .filter(f => f.height <= height && f.url)
          .sort(byResDesc)[0];
        if (heightTier) {
          streamUrl = heightTier.url;
          isHLS = /\.m3u8|\/manifest\/hls_variant\//i.test(streamUrl) || heightTier.protocol === 'm3u8'
            || heightTier.protocol === 'm3u8_native';
          httpHeaders = heightTier.httpHeaders || httpHeaders;
        } else {
          try {
            const capArgs = [
              url,
              '-j',
              '--no-playlist',
              '-f', `best[height<=${height}]/bestvideo[height<=${height}]+bestaudio/best`
            ];
            const capOutput = await ytDlp.execPromise(withYtDlpArgs(capArgs));
            const capInfo = JSON.parse(capOutput);
            if (capInfo && capInfo.url) {
              streamUrl = capInfo.url;
              isHLS = capInfo.url.includes('.m3u8') || capInfo.protocol === 'm3u8_native'
                || capInfo.protocol === 'm3u8';
              httpHeaders = capInfo.http_headers || httpHeaders;
            }
          } catch (capErr) {
            console.warn('[yt-dlp] Height-capped re-extraction failed, keeping default:', capErr.message);
          }
        }
      } else {
        // 1) Highest HLS master playlist — every resolution tier (1080p/1440p/2160p)
        //    in one manifest (with audio at each level); hls.js exposes the
        //    tiers to the quality menu. YouTube serves these as m3u8_native
        //    formats whose manifest_url is the master.
        const hlsMaster = sortedFormats.find(f => isHlsFormat(f) && (f.manifest_url || f.url));
        if (hlsMaster) {
          streamUrl = hlsMaster.manifest_url || hlsMaster.url;
          isHLS = isHlsFormat({ protocol: hlsMaster.protocol, manifest_url: streamUrl })
            || /\/manifest\/hls_variant\//i.test(streamUrl);
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

      // Direct-URL format list (one per height) so the player can hot-swap
      // without re-running yt-dlp; progressive formats (with audio) preferred.
      const menuFormats = [];
      const byHeightBest = new Map();
      for (const f of videoFormats) {
        const url = f.url || f.manifest_url || '';
        if (!url) continue;
        const key = f.height || f.format_id;
        if (!key) continue;
        const candidate = {
          formatId: f.format_id,
          label: f.format_note || (f.height ? `${f.height}p` : null) || f.format || f.format_id,
          height: f.height || 0,
          url,
          protocol: f.protocol || '',
          httpHeaders: f.http_headers || null,
          hasAudio: !!(f.acodec && f.acodec !== 'none'),
          tbr: f.tbr || 0
        };
        const prev = byHeightBest.get(key);
        if (!prev || (candidate.hasAudio && !prev.hasAudio) || (candidate.hasAudio === prev.hasAudio && (candidate.tbr || 0) > (prev.tbr || 0))) {
          byHeightBest.set(key, candidate);
        }
      }
      for (const f of [...byHeightBest.values()].sort((a, b) => {
        const aRes = (a.height || 0);
        const bRes = (b.height || 0);
        return bRes - aRes;
      })) {
        menuFormats.push({ label: f.label, height: f.height, url: f.url, httpHeaders: f.httpHeaders, hasAudio: f.hasAudio, formatId: f.formatId });
      }

      // If a specific format was requested, re-resolve the stream with that format
      if (formatId) {
        try {
          const fmtOutput = await ytDlp.execPromise(withYtDlpArgs([
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
        // Direct-URL quality list ({ label, height, url }) for instant format
        // switching in the player; per-format best picks, progressive-first.
        formats: (typeof menuFormats !== 'undefined' && menuFormats.length > 0)
          ? menuFormats
          : isYouTube
            ? null
            : {
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

    // Wrapper sites (Zhentube / HentaiHaven / Uncensored-Hentai): swap the
    // ad-wrapped page for the extracted direct/embed URL so yt-dlp downloads
    // from the real stream host. Ad-network iframes are filtered out first.
    if (/^https?:/i.test(String(url)) && isWrapperSiteUrl(String(url))) {
      try {
        const wrap = await resolveEmbeddedPageStream(String(url));
        if (wrap && wrap.direct) {
          console.log(`[Download] wrapper direct ${url} -> ${wrap.streamUrl}`);
          targetUrl = wrap.streamUrl;
        } else if (wrap && wrap.embedUrl) {
          console.log(`[Download] wrapper embed ${url} -> ${wrap.embedUrl}`);
          targetUrl = wrap.embedUrl;
        }
      } catch (wrapErr) {
        console.warn(`[Download] wrapper extraction failed (downloading page anyway): ${wrapErr.message}`);
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
    const args = withYtDlpArgs([
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
    pageUrl: str(source.pageUrl || source.webUrl),
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
// what favorites are keyed on), and the item must be playable — either via a
// direct stream/file url OR a re-extractable page url (streams rotate, pages
// live long). Everything is trimmed/coerced in normalizeFavoriteVideo.
function validateFavoritePayload(videoData) {
  const video = normalizeFavoriteVideo(videoData);
  if (!video.id) {
    return { ok: false, video, error: 'Favorite requires a valid video id (missing id/media_id)' };
  }
  if (!video.videoUrl && !video.pageUrl) {
    return { ok: false, video, error: 'Favorite requires a playable url or a page url for video "' + video.title + '"' };
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

ipcMain.handle('db:addMediaWeight', async (_event, payload) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    const result = await db.addMediaWeight(payload || {});

    return { success: true, data: result };
  } catch (err) {
    console.error('Add media weight error:', err);
    return {
      success: false,
      error: 'Failed to adjust media weight'
    };
  }
});

ipcMain.handle('db:getTopMediaWeights', async (_event, payload) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };

    const result = await db.getTopMediaWeights(payload || {});

    return { success: true, data: result };
  } catch (err) {
    console.error('Get top media weights error:', err);
    return {
      success: false,
      error: 'Failed to get top media weights'
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

// Renderer pushes live playback state so a minimize during playback can auto
// float to the MiniPlayer. Fire-and-forget (sender only).
ipcMain.on('media:active', (event, state) => {
  if (state && state.active && state.payload && state.payload.streamUrl) {
    mediaActiveResume = {
      payload: {
        mode: state.payload.mode === 'audio' ? 'audio' : 'video',
        title: String(state.payload.title || 'Nekofal Mini Player'),
        streamUrl: String(state.payload.streamUrl || ''),
        streamHls: !!state.payload.streamHls,
        poster: String(state.payload.poster || ''),
        currentTime: Number(state.payload.currentTime) || 0,
        volume: Number.isFinite(Number(state.payload.volume)) ? Number(state.payload.volume) : 1,
        muted: !!state.payload.muted,
        videoId: state.payload.videoId != null ? state.payload.videoId : null,
        isLocal: !!state.payload.isLocal
      }
    };
  } else {
    mediaActiveResume = null;
  }
});

ipcMain.handle('mini:restore', (event, payload) => {
  try {
    // The mini player hand-back: push the CURRENT playback state (fresh
    // time/volume/mute from the mini window) back into the main window so full
    // playback resumes in place, then close the mini window.
    const safe = {
      title: String(payload?.title || 'Nekofal Mini Player'),
      streamUrl: String(payload?.streamUrl || ''),
      streamHls: !!payload?.streamHls,
      poster: String(payload?.poster || ''),
      currentTime: Number(payload?.currentTime) || 0,
volume: Number.isFinite(Number(payload?.volume)) ? Number(payload.volume) : 1,
      muted: !!payload?.muted,
      videoId: payload?.videoId != null ? payload.videoId : null,
      isLocal: !!payload?.isLocal
    };
    if (!safe.streamUrl) {
      closeMiniPlayer();
      return { success: false, error: 'No stream URL to restore' };
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('mini:restore-in-main', safe);
    }
    closeMiniPlayer();
    return { success: true };
  } catch (err) {
    console.error('[Mini] restore error:', err.message);
    return { success: false, error: err.message };
  }
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
// ---------------------------------------------------------------------------
// Scraper identity: every search result MUST carry a non-empty, collision-free
// id so per-card state (star/save) can never leak across the grid. The original
// ids hashed the URL with Buffer.from(url).toString('hex').substring(0, N),
// which only encodes the leading "https://" — identical for every card, so one
// favorite lit the whole grid. Prefer a stable provider key (xVideos video key /
// Pornhub viewkey / Hanime slug) and fall back to a SHA-1 of the page URL.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function hashUrl(u) {
  return crypto.createHash('sha1').update(String(u || '')).digest('hex').substring(0, 16);
}

function scrapeVideoId(prefix, pageUrl, rawKey) {
  const key = String(rawKey || '').trim() || hashUrl(pageUrl);
  return `${prefix}_${key}`;
}

function xvideosVideoKey(u) {
  const m = String(u || '').match(/\/video[./]?([A-Za-z0-9]+)/i);
  return m ? m[1] : '';
}

function pornhubViewkey(u) {
  const m = String(u || '').match(/viewkey=([A-Za-z0-9_-]+)/i);
  return m ? m[1] : '';
}

// ---- Shared HTML-search junk filter ----------------------------------------
// Several adult grids (xHamster / XNXX / Pornhub / XVideos) interleave real
// video thumbs with category thumbnails, language-switch chips, profile/avatar
// links and broken blocks. These predicates are the universal garbage filter:
// reject image-file URLs (.png/.jpg/...), category/language filter paths
// (/tags/, /languages/, /spanish/...), and chip-style language/image titles.
const SCRAPE_LANG_TEXT = /^(English|French|Spanish|Italian|Portuguese|German|Russian|Japanese)$/i;
const SCRAPE_FILTER_PATH = /\/(?:tags?|languages?|spanish|english|french|german|russian|italian|portuguese|japanese|categor(?:y|ies))\//i;
const SCRAPE_IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp)(?:[?#].*)?$/i;

const AD_NETWORKS = ["exoclick", "adsterra", "popads", "juicyads", "doubleclick", "adform", "traffichaus"];
const AD_NETWORK_RE = new RegExp('(?:^|[^a-z0-9])(?:' + AD_NETWORKS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?:[^a-z0-9]|$)', 'i');

function isAdNetworkUrl(url) {
  return AD_NETWORK_RE.test(String(url || ''));
}

// Ad overlays on wrapper sites (PopAds, ExoClick, AdSterra, JuicyAds…) hide
// behind generic <iframe src> tags too, sometimes with ad-only parameters in
// the query string. Anything matching an ad network OR an ad parameter pattern
// is treated as an overlay and never returned as a stream/embed candidate.
const AD_IFRAME_PARAMS = /(?:popunder|popads|exoclick|adsterra|adspaces|juicyads|doubleclick|adform|traffichaus|trafficjunky|pagead|googlesyndication)|\b(?:pub_ad|pp_ads|pm_ads?)\b/i;

function isAdIframeUrl(url) {
  const u = String(url || '');
  return isAdNetworkUrl(u) || AD_IFRAME_PARAMS.test(u);
}

// Wrapper sites: the video page is a thin shell around a third-party stream
// host, and yt-dlp's "first iframe" heuristic can land on an ad overlay. These
// are routed through resolveEmbeddedPageStream() before yt-dlp ever sees them.
function isWrapperSiteUrl(u) {
  try {
    const host = new URL(String(u || '')).hostname.toLowerCase();
    return /zhentube|hentaihaven|uncensored/i.test(host);
  } catch (_e) {
    return false;
  }
}

const SCRAPER_TITLE_BLACKLIST = [
  'xnxx gold', 'top creators live', 'new channel', 'liked', 'autoplay', 'videos i like',
  'uncensored hentai', 'ai hentai', 'latest releases', 'most popular', 'most liked',
  'settings', 'sign in', 'privacy policy', 'terms of service', 'contact', 'about',
  'clear', 'pick your poison', 'rta', 'dmca', 'faq', 'home'
];

// Duration-only strings that show up as the anchor text on xHamster / XVideos
// thumb cards (e.g. "5m 30s", "12:34", "1,000") are never real titles — reject
// them so they never bubble up as a video name.
const SCRAPE_METRIC_TITLE = /^(?:\d{1,3}(?:\.\d{1,2})?[kmhKMH]?|\d{1,2}:\d{2}|\d+h\s*\d+m\s*\d*s|\d+m\s*\d+s|\d+s)$/;

function isScrapeJunkUrl(url) {
  const u = String(url || '');
  return SCRAPE_IMAGE_FILE.test(u) || SCRAPE_FILTER_PATH.test(u);
}

function isScrapeJunkTitle(title) {
  const t = String(title || '').trim();
  if (!t || t.length < 4) return true;
  if (/^(?:untitled|image source|image)$/i.test(t)) return true;
  if (SCRAPE_METRIC_TITLE.test(t)) return true;
  if (SCRAPER_TITLE_BLACKLIST.some(b => t.toLowerCase() === b)) return true;
  return SCRAPE_LANG_TEXT.test(t) || /\.(?:png|jpe?g|gif|svg|webp)\b/i.test(t);
}

function scrapeThumbUrl(img) {
  if (!img) return '';
  const get = (n) => (img.attr
    ? String(img.attr(n) || '')
    : (typeof img.getAttribute === 'function' ? String(img.getAttribute(n) || '') : ''));
  // Lazy-loaded grids publish the real image in data-src first; the raw src is
  // often a placeholder or a 1x1 tracking gif, so prefer data-src.
  return get('data-src') || get('src') || get('data-lazy-src');
}

// v1.0.33: strict thumbnail-title fallback for the grid engines (XNXX, xHamster,
// …). Try the card's own title attribute first, then its poster <img alt>, then
// the raw text content — and reject anything that is empty, "untitled"/"Image",
// or shorter than 4 characters so category/avatar/chip cards never leak in.
// v1.0.36: xHamster rotates its title anchor between .title-link and
// .video-title, so the anchor's title/text is tried before the whole-block text.
function cleanThumbTitle(block) {
  const anchor = block.find('.title-link a, .video-title a, .title-link, .video-title, a.a-title, .title a').first();
  const anchored = anchor.length
    ? String(anchor.attr('title') || anchor.text().replace(/\s+/g, ' ').trim() || '')
    : '';
  const own = String(block.attr && block.attr('title') ? block.attr('title') : '');
  const img = block.find('img').first();
  const alt = String(img.attr('alt') || '');
  const text = String(block.text().replace(/\s+/g, ' ').trim() || '');
  const title = (anchored || own || alt || text).trim().substring(0, 200);
  if (isScrapeJunkTitle(title)) return '';
  return title;
}

// Flat-playlist enumerations (YouTube especially) often omit a top-level
// `thumbnail` and only expose a `thumbnails` ladder that starts at 120x90.
// Pick the largest entry so hero banners and cards get a crisp image.
function bestThumbnailUrl(entry) {
  if (entry.thumbnail) return entry.thumbnail;
  const list = Array.isArray(entry.thumbnails) ? entry.thumbnails : [];
  if (list.length === 0) return '';
  let best = null;
  let bestArea = -1;
  for (const t of list) {
    const area = (Number(t && t.width) || 0) * (Number(t && t.height) || 0);
    if (t && t.url && area >= bestArea) { best = t; bestArea = area; }
  }
  return (best && best.url) || (list[list.length - 1] && list[list.length - 1].url) || '';
}

function normalizeSearchEntry(entry, fallbackSite) {
  const url = entry.webpage_url || entry.url || '';
  return {
    id: entry.id ? `${(entry.extractor || 'web')}_${entry.id}` : `web_${hashUrl(url)}`,
    title: (entry.title || entry.fulltitle || 'Untitled').substring(0, 200),
    thumbnailUrl: bestThumbnailUrl(entry),
    videoUrl: url,
    pageUrl: url,
    duration: entry.duration || 0,
    category: entry.channel || entry.playlist_title || 'Video',
    sourceSite: entry.extractor || entry.ie_key || entry.playlist_title || fallbackSite || 'Web',
    extractor: entry.extractor || entry.ie_key || 'ytdlp'
  };
}

// ---- Hanime engine ----------------------------------------------------
// Search goes through the active Hanime search service (the same upstream the
// backend gateway proxies for /api/scrape/hanime): POST search_text/json to
// https://search.htv-services.com/ returns elastic hits with slugs. The old
// hanime.tv/api/v8/search shard gets sunset/rotated behind Cloudflare, while
// this service key stays reachable. Video detail still uses the native v8
// endpoint (https://hanime.tv/api/v8/video?id={slug}) which returns the
// videos_manifest with the master .m3u8 (or a direct .mp4 fallback stream).
const HANIME_API = 'https://hanime.tv/api/v8';
const HANIME_SEARCH_API = 'https://search.htv-services.com/';
const STEALTH_TURNSTILE_SETTLE_MS = 3000;
// Hentaimama's Turnstile sizing needs a longer settle than the shared default:
// the challenge has to fully clear AND the WP/DLE grid re-render before the DOM
// fallback parser can safely read the result cards.
const HENTAIMAMA_SETTLE_MS = 7000;

// Cloudflare-bypass header block for the offscreen webview sniff fallback.
// Presenting a full desktop-browser header set on the initial page load (plus
// the stored cf_clearance/__cf_bm cookies in defaultSession) makes the
// challenge resolve without an interactive visit, so the JS-driven HLS player
// can fire its v2.hanime.tv / .m3u8 requests that the sniffer intercepts.
const HANIME_SNIFF_HEADERS =
  'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\r\n' +
  'Accept-Language: en-US,en;q=0.9\r\n' +
  'Upgrade-Insecure-Requests: 1\r\n' +
  'Sec-Fetch-Dest: document\r\n' +
  'Sec-Fetch-Mode: navigate\r\n' +
  'Sec-Fetch-Site: none\r\n' +
  'Sec-Fetch-User: ?1\r\n' +
  'DNT: 1\r\n';

function hanimeHeaders(cookieHeader, browser = false) {
  // Present a full browser-fetch header set so htv-services (search) and the
  // v8 API see a genuine Chrome XHR: Sec-CH-UA family, fetch-context hints and
  // the cross-origin origin/referer of hanime.tv. The cleared cf_clearance /
  // __cf_bm cookies from session.defaultSession ride along as Cookie when the
  // stealth browser has unlocked them.
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://hanime.tv',
    'Referer': 'https://hanime.tv/',
    'Content-Type': 'application/json',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="122", "Chromium";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'X-Requested-With': 'XMLHttpRequest'
  };
  // browser === true simulates the site's own in-page fetch (no cross-origin
  // Origin / XHR marker) — used by the v8 video resolver.
  if (browser) {
    delete headers.Origin;
    delete headers['X-Requested-With'];
  }
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

async function hanimeV8Search(query, count = 25) {
  const text = String(query || '').trim();
  const body = {
    search_text: text,
    tags: [],
    tags_match: 'or',
    keyword: text,
    page: 0,
    order_by: '',
    ordering: 'desc',
    c_type_filter: '',
    is_bunny: true
  };
  const cookieHeader = await getSessionCookieHeader('https://hanime.tv/');
  const res = await fetch(HANIME_SEARCH_API, {
    method: 'POST',
    headers: hanimeHeaders(cookieHeader),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`Hanime search HTTP ${res.status}`);
  const data = await res.json();
  return parseHanimeSearchPayload(data, count, 'hanime-v8');
}

// htv-services answers with the v8-shaped elastic payload; tolerate a few
// structural variants so a format shuffle upstream never returns zero rows.
// Shared by the direct v8 fetch path and the offscreen stealth capture so
// both backends produce identical result shapes.
function parseHanimeSearchPayload(data, count = 25, extractor = 'hanime-v8') {
  const nestedHits = data && data.data && data.data.hits && (data.data.hits.hits || data.data.hits);
  const hits = Array.isArray(nestedHits)
    ? nestedHits
    : (Array.isArray(data && data.hits) ? data.hits : []);
  const videos = [];
  for (const h of hits) {
    const src = h && h._source ? h._source : (h || {});
    const slug = src.slug || (h && h._source && h._source.slug) || '';
    if (!slug) continue;
    const pageUrl = `https://hanime.tv/videos/hentai/${slug}`;
    // Some hit payloads embed the playable stream (master .m3u8 or direct
    // .mp4) directly; when present use it as videoUrl so playback skips the
    // extra video?id round-trip. Otherwise keep the page URL for the resolver.
    const rawStream = String(src.stream_url || src.hls_url || src.video_url || src.url || '').trim();
    const directStream = (rawStream && (/\.m3u8/i.test(rawStream) || /\.mp4/i.test(rawStream)))
      ? rawStream
      : '';
    videos.push({
      id: scrapeVideoId('hanime', pageUrl, slug),
      title: (src.name || 'Untitled').trim(),
      thumbnailUrl: src.poster_url || src.cover_url || src.thumb_url || '',
      videoUrl: directStream || pageUrl,
      pageUrl,
      isHLS: /\.m3u8/i.test(directStream),
      httpHeaders: directStream ? { 'Referer': 'https://hanime.tv/', 'Origin': 'https://hanime.tv' } : null,
      duration: src.duration_in_ms ? Math.floor(Number(src.duration_in_ms) / 1000) : 0,
      category: 'Hanime',
      sourceSite: 'hanime.tv',
      extractor: directStream ? 'hanime-search-direct' : extractor,
      description: src.description || ''
    });
    if (videos.length >= count) break;
  }
  return videos;
}

// v1.0.29: offscreen stealth Hanime search. Instead of POSTing straight to
// search.htv-services.com from a plain net.fetch (which Cloudflare challenges
// when the request leaves the freed session), navigate the hidden offscreen
// window to https://hanime.tv/search?q=... and let the page's own React app
// issue the htv-services POST with a genuine browser fingerprint. Electron 28
// removed the body-capturing webRequest.filter() stream API, so response
// payloads are captured via the CDP (webContents.debugger) network protocol
// (Network.responseReceived -> Network.getResponseBody on loadingFinished).
// If no payload arrives (the SPA did not auto-submit from the query string),
// fall back to reading the rendered result cards out of the live DOM.
const HANIME_DOM_SCRIPT = `
(function(){
  var out = [];
  var seen = {};
  var anchors = [].slice.call(document.querySelectorAll('a[href*="/videos/hentai/"]'));
  for (var i = 0; i < anchors.length && out.length < __LIMIT__; i++) {
    var a = anchors[i];
    var raw = String(a.getAttribute('href') || '');
    if (!raw || raw.charAt(0) === '#') continue;
    var abs;
    try { abs = new URL(raw, location.href).href; } catch (e) { continue; }
    if (seen[abs]) continue;
    if (/\.(png|jpe?g|gif|svg|webp)([?#]|$)/i.test(abs)) continue;
    var img = a.querySelector('img');
    var thumb = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '') : '';
    var title = (a.getAttribute('title') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title || title.length < 4 || /^(untitled|image)$/i.test(title)) title = 'Untitled';
    var durText = '';
    var nodes = a.querySelectorAll('.duration, [class*="duration"]');
    for (var k = 0; k < nodes.length; k++) { durText = (nodes[k].textContent || '').trim(); if (durText) break; }
    if (!durText) {
      var tx = a.textContent.match(/(?:\\d+h\\s*)?\\d{1,2}:\\d{2}/);
      durText = tx ? tx[0] : '';
    }
    seen[abs] = true;
    out.push({ title: title, thumb: thumb, url: abs, durationText: durText });
  }
  return { out: out, href: location.href, title: document.title };
})();
`;

async function hanimeStealthSearch(query, count = 25) {
  const text = String(query || '').trim();
  if (!text) return [];
  const searchUrl = 'https://hanime.tv/search?q=' + encodeURIComponent(text);
  const win = ensureStealthWindow();
  const payloads = [];
  const pendingIds = new Map();
  let attached = false;

  // 1) CDP network capture: record every search.htv-services.com response body
  //    as it lands, so results come straight from the network layer.
  try {
    win.webContents.debugger.attach('1.3');
    attached = true;
    win.webContents.debugger.on('message', (_event, method, params) => {
      if (!params) return;
      if (method === 'Network.responseReceived' || method === 'Network.requestWillBeSent') {
        const u = (params.response && params.response.url) || (params.request && params.request.url) || '';
        const id = params.requestId;
        if (id && u && /search\.htv-services\.com/i.test(String(u))) pendingIds.set(id, String(u));
      }
      if (method === 'Network.loadingFinished') {
        const id = params.requestId;
        if (!id || !pendingIds.has(id)) return;
        win.webContents.debugger.sendCommand('Network.getResponseBody', { requestId: id })
          .then(({ body, base64Encoded }) => {
            const rawText = Buffer.isBuffer(body)
              ? body.toString('utf8')
              : (base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : String(body || ''));
            let json = null;
            try { json = JSON.parse(rawText); } catch (_e) { json = null; }
            if (json) payloads.push({ url: pendingIds.get(id), json });
          })
          .catch(() => { /* frame navigated away before body fetch */ })
          .finally(() => pendingIds.delete(id));
      }
    });
    await win.webContents.debugger.sendCommand('Network.enable');
  } catch (err) {
    console.warn(`[hanimeStealthSearch] CDP attach failed (DOM fallback only): ${err.message}`);
  }

  try {
    const load = await loadInStealth(searchUrl, { pauseAfterLoadMs: STEALTH_TURNSTILE_SETTLE_MS, challengeTimeoutMs: 20000, timeoutMs: 30000 });
    if (!load.success) throw new Error(`hanime search page load failed: ${load.error}`);

    // Wait for the page's own POST to htv-services to land (then catch any
    // stragglers), so the network path is preferred over DOM scraping.
    const payloadDeadline = Date.now() + 10000;
    while (payloads.length === 0 && Date.now() < payloadDeadline && !win.isDestroyed()) {
      await sleep(500);
    }
    await sleep(500);

    // 2) Network payload path: parse the captured htv-services responses.
    for (const { url, json } of payloads) {
      const parsed = parseHanimeSearchPayload(json, count, 'hanime-stealth-search');
      if (parsed.length > 0) {
        console.log(`[hanimeStealthSearch] captured ${parsed.length} hits from ${url}`);
        return parsed;
      }
    }

    // 3) DOM fallback: read the rendered result cards from the live page.
    for (let i = 0; i < 15; i++) {
      if (win.isDestroyed()) break;
      const res = await evalInStealth(buildAutoSearchScript(HANIME_DOM_SCRIPT, { limit: count }), 6000);
      if (res && res.__stealthError) throw new Error(`hanime DOM extract failed: ${res.__stealthError}`);
      const out = (res && Array.isArray(res.out)) ? res.out : [];
      const valid = out.filter(e => e && e.url && !isScrapeJunkUrl(e.url));
      if (valid.length > 0) {
        return valid.map(r => {
          const m = (r.durationText || '').match(/(?:(\d+)h\s*)?(\d{1,2}):(\d{2})/);
          const duration = m ? (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) : 0;
          return {
            id: scrapeVideoId('hanime', r.url),
            title: String(r.title || 'Untitled').trim().substring(0, 200),
            thumbnailUrl: r.thumb || '',
            videoUrl: r.url,
            pageUrl: r.url,
            isHLS: false,
            httpHeaders: { 'Referer': 'https://hanime.tv/', 'Origin': 'https://hanime.tv' },
            duration,
            category: 'Hanime',
            sourceSite: 'hanime.tv',
            extractor: 'hanime-stealth-search'
          };
        });
      }
      await sleep(700);
    }
    return [];
  } finally {
    if (attached) {
      try { win.webContents.debugger.detach(); } catch (_e) { /* already detached */ }
    }
  }
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
  const servers = (manifest && Array.isArray(manifest.servers)) ? manifest.servers : [];
  // Walk every server/stream for a master .m3u8 first, then a direct .mp4, so
  // the returned stream is always the cleanest playable URL (never a page).
  let m3u8 = '';
  let direct = '';
  for (const server of servers) {
    const streams = (server && Array.isArray(server.streams)) ? server.streams : [];
    for (const stream of streams) {
      const streamUrl = String((stream && stream.url) || '').trim();
      if (!streamUrl) continue;
      if (/\.m3u8/i.test(streamUrl)) { m3u8 = streamUrl; break; }
      if (!direct && /\.mp4/i.test(streamUrl)) direct = streamUrl;
    }
    if (m3u8) break;
  }
  const playable = m3u8 || direct;
  return {
    id: String(v.id || slug),
    title: v.name || v.title || 'Untitled',
    thumbnailUrl: v.poster_url || v.cover_url || '',
    duration: v.duration_in_ms ? Math.floor(Number(v.duration_in_ms) / 1000) : 0,
    m3u8: playable,
    canPlay: /\.m3u8/i.test(playable) || /\.mp4/i.test(playable)
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
    extraHeaders: HANIME_SNIFF_HEADERS,
    match: (e) => /\.m3u8/i.test(String(e.url || ''))
      || /hanime\.tv\/api\/v8\/video/i.test(String(e.url || ''))
      || /v2\.hanime\.tv/i.test(String(e.url || ''))
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
    const rawJson = await ytDlp.execPromise(withYtDlpArgs([
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
      return { m3u8, title: info.title || '', duration: info.duration || 0, fromYT: true, isHls: /\.m3u8/i.test(m3u8) };
    }
    ytError = new Error('no playable format returned by yt-dlp');
  } catch (err) {
    ytError = err;
    console.warn(`[pornhub] yt-dlp failed (trying stealth sniff): ${err.message}`);
  }

  // Stealth fallback: render the page in the offscreen browser (real
  // fingerprint), capture the master .m3u8 as soon as the player requests it,
  // and probe flashvars.mediaDefinitions for the videoUrl as a DOM backup —
  // preferring the HLS master, then the best-quality direct MP4.
  const sniff = await sniffWithEarlyReturn(pageUrl, {
    timeoutMs: 20000,
    match: (e) => /\.m3u8/i.test(String(e.url || '')) || (/\.mp4/i.test(String(e.url || '')) && /phncdn\.com/i.test(String(e.url || ''))),
    probe: async () => {
      const val = await evalInStealth(
        `var fv = window.flashvars || {}; var md = fv.mediaDefinitions || [];` +
        `var pick = function (re) { for (var i = 0; i < md.length; i++) { if (md[i] && re.test(md[i].videoUrl || '')) return md[i].videoUrl; } return ''; };` +
        `var hls = pick(/\\\\.m3u8/i); if (hls) return hls;` +
        `var mp4 = pick(/\\\\.mp4/i); if (mp4) return mp4;` +
        `return '';`, 5000);
      return typeof val === 'string' && val ? val : null;
    }
  });
  const m3u8 = sniff.matchedUrl
    || (sniff.streams && sniff.streams.find(s => /\.m3u8/i.test(String(s || ''))))
    || (sniff.streams && sniff.streams.find(s => /\.mp4/i.test(String(s || '')) && /phncdn\.com/i.test(String(s || ''))))
    || (sniff.streams && sniff.streams[0])
    || null;
  if (!m3u8) {
    throw new Error('No playable stream for ' + pageUrl + (ytError ? ' (yt-dlp: ' + ytError.message + ')' : ' (nothing found)'));
  }
  return { m3u8, title: '', duration: 0, fromYT: false, isHls: /\.m3u8/i.test(m3u8) };
}

async function searchHanime(query, count = 25) {
  let lastErr = null;

  // Primary (v1.0.29): offscreen stealth search. The hidden browser window
  // loads https://hanime.tv/search?q=..., auto-solves Cloudflare/Turnstile,
  // and its own React app issues the htv-services.com POST with a real browser
  // fingerprint; the response payload is captured from the network layer (CDP)
  // or read back from the rendered DOM.
  try {
    const stealthVideos = await hanimeStealthSearch(query, count);
    if (stealthVideos.length > 0) return stealthVideos;
    lastErr = new Error('stealth search returned no results');
  } catch (stealthErr) {
    lastErr = stealthErr;
    console.warn(`[searchHanime] stealth search failed, falling back to v8 API: ${stealthErr.message}`);
  }

  // Fallback: direct v8 search API — still works while the cleared
  // cf_clearance / __cf_bm cookies from a prior stealth visit live in
  // session.defaultSession, so the POST presents the same freed session.
  try {
    const v8 = await hanimeV8Search(query, count);
    if (v8.length > 0) return v8;
  } catch (v8Err) {
    lastErr = v8Err;
    console.warn(`[searchHanime] v8 search failed: ${v8Err.message}`);
  }

  const e = lastErr || new Error('No Hanime search backend reachable');
  e.message += ' (Hanime stealth search and v8 API are currently unreachable/blocked)';
  throw e;
}

// ---- Wrapper-page stream resolution (ad-bypass) ------------------------------
// Zhentube / HentaiHaven / Uncensored-Hentai video pages are thin wrappers: the
// real stream (mp4upload, vhaven, doodstream, streamtape, mixdrop, …) lives in
// an <iframe> next to a forest of ad-network overlays (PopAds, ExoClick,
// AdSterra, JuicyAds…). yt-dlp's generic extractor walks the top-level page, can
// pick an ad overlay as "the stream", and on the wrapper sites usually fails
// outright. So we resolve the real media ourselves, strictly ignoring the ad
// layer, in this order:
//   1. HTML5 media served by the page (<video src>/<source src>, <object data>,
//      plain <a href> download links) — .mp4/.m3u8/.m3u/.webm;
//   2. iframes/embeds whose URL is a direct media file or a KNOWN embed host —
//      never an ad network, never a URL carrying ad parameters;
//   3. a deep dive into the chosen embed page (vhaven/mixdrop often expose an
//      HTML5 <video> with a real .mp4 behind the iframe);
//   4. any remaining external http(s) iframe as a last resort, still ad-filtered.
// A direct .mp4/.m3u8 is returned for the frontend player; a media-host embed is
// handed to yt-dlp whose dedicated streamtape/doodstream/mp4upload extractors
// support those hosts.
const EMBED_MEDIA_HOSTS = /(?:mp4upload|doodstream|dood\.|streamtape|filemoon|goo\.armygum|speedostream|vidsrc|ok\.ru|mystream|netu|mixdrop|vhaven|akstream)/i;

async function resolveEmbeddedPageStream(pageUrl, opts = {}) {
  const cheerio = require('cheerio');
  const depth = Number(opts.depth) || 0;
  if (depth > 3) throw new Error('Wrapper chain too deep: ' + pageUrl);

  let referer = String(opts.referer || '');
  let domain = '';
  try {
    const parsedHost = new URL(pageUrl).hostname;
    domain = parsedHost;
    if (!referer) referer = `https://${parsedHost}/`;
  } catch (_e) { referer = referer || ''; }

  const browserHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1'
  };

  const res = await net.fetch(pageUrl, {
    method: 'GET',
    headers: browserHeaders,
    redirect: 'follow',
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText}) from ${pageUrl}`);
  const html = await res.text();
  if (!html || html.length < 200) throw new Error('Empty or challenge page returned by ' + pageUrl);
  const $ = cheerio.load(html);
  const absOf = (u) => { try { return new URL(u, pageUrl).href; } catch { return ''; } };
  const isMediaFile = (src) => /\.(?:mp4|m3u8|m3u|webm|ts)(?:[?#].*)?$/i.test(String(src || ''));
  const hosted = (u) => { try { return new URL(u).hostname === domain; } catch { return false; } };
  const pickDirect = (list) => list.find(hosted) || list[0];

  // 1) Direct media tags, <object data> and plain download links.
  const directCandidates = [];
  const seenDirect = new Set();
  const pushDirect = (raw) => {
    const abs = absOf(raw);
    if (abs && !seenDirect.has(abs) && !isAdIframeUrl(abs) && !isScrapeJunkUrl(abs) && isMediaFile(abs)) {
      seenDirect.add(abs);
      directCandidates.push(abs);
    }
  };
  $('video[src], video > source[src], source[src], object[data], audio[src], video source[data-src], video[data-src]').each((_i, el) => {
    const raw = $(el).attr('src') || $(el).attr('data') || $(el).attr('data-src') || '';
    pushDirect(raw);
  });
  if (directCandidates.length === 0) {
    // Some wrapper themes publish the video as a download-style <a href> link.
    $('a[href]').each((_i, el) => {
      const raw = String($(el).attr('href') || '');
      if (isMediaFile(raw)) pushDirect(raw);
    });
  }
  if (directCandidates.length) {
    return { direct: true, streamUrl: pickDirect(directCandidates) };
  }

  // 2) iframes/embeds: accept direct media files and KNOWN media hosts, and
  //    reject anything that smells like an ad overlay.
  const embedCandidates = [];
  const seenEmbed = new Set();
  $('iframe[src], embed[src], object[data]').each((_i, el) => {
    const raw = $(el).attr('src') || $(el).attr('data') || '';
    const abs = absOf(raw);
    if (!abs || seenEmbed.has(abs) || isAdIframeUrl(abs)) return;
    seenEmbed.add(abs);
    if (isMediaFile(abs)) { seenDirect.add(abs); directCandidates.push(abs); return; }
    if (EMBED_MEDIA_HOSTS.test(abs)) embedCandidates.push(abs);
  });
  if (directCandidates.length) {
    return { direct: true, streamUrl: pickDirect(directCandidates) };
  }
  // Prefer a same-host/self-hosted embed, then media hosts in page order.
  const embed = embedCandidates.find(hosted) || embedCandidates[0] || '';

  // 3) Deep dive: the embed page itself may surface a real HTML5 <video>.
  if (embed) {
    try {
      const deep = await resolveEmbeddedPageStream(embed, { referer: pageUrl, depth: depth + 1 });
      if (deep && deep.direct) {
        return { direct: true, streamUrl: deep.streamUrl };
      }
    } catch (_e) { /* embed is flaky/gone — hand the embed URL to yt-dlp below */ }
    return { embedUrl: embed };
  }

  // 4) Last resort: any external http(s) iframe (generic embed hosts change).
  //    Ad networks are still filtered out — never an ad URL as the "stream".
  let lastResort = '';
  $('iframe[src], embed[src]').each((_i, el) => {
    if (lastResort) return;
    const abs = absOf($(el).attr('src') || '');
    if (abs && /^https?:/i.test(abs) && !isAdIframeUrl(abs) && !isScrapeJunkUrl(abs)) lastResort = abs;
  });
  if (lastResort) return { embedUrl: lastResort };

  throw new Error('No video source or embed found in ' + pageUrl);
}

// Backwards-compatible alias used by the download handler.
async function resolveZhentubeStream(pageUrl) {
  return resolveEmbeddedPageStream(pageUrl, { referer: 'https://zhentube.ru/' });
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

  // v1.0.35: query strictly inside video card containers (.mozaique .thumb-block,
  // .video-block, #content .thumb-block). Global menu entries ("login", "join
  // for free", "sign in") and blank chrome live outside these and never match.
  $('.mozaique .thumb-block, .video-block, #content .thumb-block').each((_i, el) => {
    const block = $(el);
    const link = block.find('a[href*="/video"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = href.startsWith('http') ? href : `https://www.xvideos.com${href}`;
    if (!/^https?:/i.test(abs)) return;
    if (isScrapeJunkUrl(abs)) return;
    // Title: anchor title attr first, then its text, then link title/poster
    // alt — covering the title anchors xvideos rotates between (.title a,
    // .title-link, a.a-title, .video-title). Reject menu/login junk,
    // metric-only or <4 char strings.
    const titleEl = block.find('.title a, .p a, p a, a.a-title, .title-link, .video-title, .video-title a, .story-title a').first();
    let title = (
      String(titleEl.attr('title') || '') ||
      String(titleEl.text().replace(/\s+/g, ' ').trim() || '') ||
      String(link.attr('title') || '') ||
      String(block.find('img').first().attr('alt') || '') ||
      String(block.text().replace(/\s+/g, ' ').trim() || '')
    ).trim().substring(0, 200);
    // isScrapeJunkTitle folds in SCRAPER_TITLE_BLACKLIST, length + metric rules.
    if (isScrapeJunkTitle(title)) return;

    const img = block.find('img').first();
    const thumb = scrapeThumbUrl(img);

    const durText = block.find('.duration').text().trim();
    let duration = 0;
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    if (dm) {
      duration = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
    }

    const profile = block.find('.profile-name').first().text().trim();
    // Sanitize: skip image/avatar URLs and category/language filter links, and
    // require a real duration — the mozaique grid also embeds non-video thumbs.
    if (!duration) return;

    videos.push({
      id: scrapeVideoId('xvideos', abs, xvideosVideoKey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
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
function xvJunk(t) {
  t = (t || '').trim();
  if (!t || t.length < 4) return true;
  if (/^(untitled|image source|image)$/i.test(t)) return true;
  if (/^(?:\\d{1,3}(?:\\.\\d{1,2})?[kmhKMH]?|\\d{1,2}:\\d{2})$/.test(t)) return true;
  var black = /^(xnxx gold|top creators live|new channel|liked|autoplay|videos i like|uncensored hentai|ai hentai|latest releases|most popular|most liked|settings|sign in|privacy policy|terms of service|contact|about|clear|pick your poison|rta|dmca|faq|home)$/i;
  if (black.test(t)) return true;
  if (/^(English|French|Spanish|Italian|Portuguese|German|Russian|Japanese)$/i.test(t)) return true;
  return /\\.(?:png|jpe?g|gif|svg|webp)\\b/i.test(t);
}
var out = [];
var blocks = [].slice.call(document.querySelectorAll('.mozaique .thumb-block, .video-block, #content .thumb-block'));
for (var i = 0; i < blocks.length; i++) {
  var b = blocks[i];
  var link = b.querySelector('a[href*="/video"]');
  if (!link) continue;
  var href = link.getAttribute('href') || '';
  var abs = /^https?:/i.test(href) ? href : 'https://www.xvideos.com' + href;
  if (!abs) continue;
  var titleEl = b.querySelector('.title a, .p a, p a');
  var title = '';
  if (titleEl) title = titleEl.getAttribute('title') || titleEl.textContent.replace(/\\s+/g, ' ').trim() || '';
  if (!title) title = link.getAttribute('title') || '';
  if (!title) title = (b.querySelector('img') || {}).alt || '';
  title = title.trim().slice(0, 200);
  if (xvJunk(title)) continue;
  var img = b.querySelector('img');
  var thumb = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
  var d = (b.querySelector('.duration') || {}).textContent || '';
  var dur = 0;
  var dm = d.match(/(?:(\\d+)h\\s*)?(\\d+):(\\d+)/);
  if (dm) dur = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
  if (!dur) continue;
  if (/\\.(?:png|jpe?g|gif|webp)(?:[?#].*)?$/i.test(abs)) continue;
  if (/\\/(?:tags?|languages?|spanish|english|french|german|russian|italian|portuguese|japanese)\\//i.test(abs)) continue;
  var profile = (b.querySelector('.profile-name') || {}).textContent || '';
  out.push({ title: title, thumb: thumb, url: abs, duration: dur, profile: profile.trim() });
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
    id: scrapeVideoId('xvideos', r.url, xvideosVideoKey(r.url)),
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    pageUrl: r.url,
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
// (#videoSearchResult li.pcVideoListItem, div.videoMaster), ignore anything
// living inside nav/header/footer/filter bars (.adLink, .sponsored,
// .language-select, .sub-nav), drop /language/ and /categories/ links, and pull
// the card's actual title, duration and thumbnail. A valid hit MUST have a
// thumbnail image AND a viewkey= link.
const PH_ALLOWED_CARDS = '#videoSearchResult li.pcVideoListItem, div.videoMaster';
const PH_VIDEO_LINK = 'a[href*="view_video.php"], a[href*="watch"], a[href*="/videos/"]';
const PH_IGNORED_ANCESTRY = 'nav, header, #header, #footer, .topNav, .mainNav, .sub-nav, .subMenu, .filter-wrapper, .languageTop, .languageBar, .language-select, .ph-sidebar, .adLink, .sponsored';
const PH_LANG_TEXT = /^(English|French|Spanish|Italian|Portuguese|German|Russian|Japanese)$/i;
const PH_FILTER_HREF = /\/language\/|\/categories\//i;

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
    // Age-gate cookies: pornhub gates search pages behind an age check; these
    // three flags plus the desktop Chrome UA let the request through cleanly.
    'Cookie': 'age_verified=1; platform=pc; has_js=1',
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
    const abs = href.startsWith('http') ? href : `https://www.pornhub.com${href}`;
    // Strict: a real pornhub result MUST be a viewkey video page. This drops
    // category/pornstar/channel/set links and any /language/ or /categories/
    // filter links that can sit inside the result wrapper.
    if (PH_FILTER_HREF.test(abs)) return;
    if (!/view_video\.php\?viewkey=/i.test(abs)) return;
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
    // A result without a thumbnail image is a filter chip / broken card, not a video.
    if (!thumb) return;
    const duration = pornhubCardDuration(card.find('.duration, .video-duration, var.duration').first().text());
    if (!duration) return;

    videos.push({
      id: scrapeVideoId('pornhub', abs, pornhubViewkey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
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
var ignored = ['nav', 'header', '#header', '#footer', '.topNav', '.mainNav', '.sub-nav', '.subMenu', '.filter-wrapper', '.languageTop', '.languageBar', '.language-select', '.ph-sidebar', '.adLink', '.sponsored'].join(',');
var langText = /^(English|French|Spanish|Italian|Portuguese|German|Russian|Japanese)$/i;
var filterHref = /\\/language\\/|\\/categories\\//i;
var cards = [].slice.call(document.querySelectorAll('#videoSearchResult li.pcVideoListItem, div.videoMaster'));
var seen = {};
for (var i = 0; i < cards.length; i++) {
  if (out.length >= __LIMIT__) break;
  var c = cards[i];
  if (c.closest && c.closest(ignored)) continue;
  var link = c.querySelector('a[href*="view_video.php"], a[href*="watch"], a[href*="/videos/"]');
  if (!link) continue;
  var href = link.getAttribute('href') || '';
  if (!href || filterHref.test(href)) continue;
  var abs = /^https?:/i.test(href) ? href : 'https://www.pornhub.com' + href;
  if (!/view_video\\.php\\?viewkey=/i.test(abs)) continue;
  if (seen[abs]) continue;
  var titleLink = c.querySelector('span.title a, .title a');
  var title = (link.getAttribute('title') || (titleLink ? (titleLink.getAttribute('title') || titleLink.textContent) : '') || (c.querySelector('.title') || {}).textContent || (c.querySelector('img') || {}).alt || '').trim();
  if (!title || langText.test(title)) continue;
  var img = c.querySelector('img');
  var thumb = img ? (img.getAttribute('data-thumb_url') || img.getAttribute('data-src') || img.src || '') : '';
  if (!thumb) continue;
  var durEl = c.querySelector('.duration') || c.querySelector('.video-duration') || c.querySelector('var.duration');
  var d = (durEl && durEl.textContent) || '';
  var dur = 0;
  var dm = d.match(/(?:(\\d+)h\\s*)?(\\d+):(\\d+)/);
  if (dm) dur = (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10);
  if (!dur) continue;
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
    id: scrapeVideoId('pornhub', r.url, pornhubViewkey(r.url)),
    title: r.title || 'Untitled',
    thumbnailUrl: r.thumb || '',
    videoUrl: r.url,
    pageUrl: r.url,
    duration: r.duration || 0,
    category: 'Pornhub',
    sourceSite: 'pornhub.com',
    extractor: 'pornhub-stealth'
  })).slice(0, count || 25);
}

// ---- xHamster search -------------------------------------------------------
// xhamster's search page interleaves real video thumbs (.video-thumb) with
// sidebar category/language chips that reuse similar markup. Match strictly on
// the .video-thumb containers, require a real /videos/{slug}-{id} video link,
// junk-filter the URL + title, and demand a duration before accepting a hit.
function xhamsterVideoKey(u) {
  const m = String(u || '').match(/\/videos\/([^/?#]+)/i);
  return m ? m[1] : '';
}

async function xhamsterSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const browserHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://xhamster.com/',
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

  $('.video-thumb, .video-item, a.video-thumb__image-container').each((_i, el) => {
    const block = $(el);
    // `a.video-thumb__image-container` IS the video link itself, so use it
    // directly when the matched element is an anchor; otherwise look inside.
    const link = block.is('a[href*="/videos/"]') ? block : block.find('a[href*="/videos/"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = /^https?:/i.test(href) ? href : `https://xhamster.com${href}`;
    if (!/^https?:/i.test(abs)) return;
    // Strict: real xHamster results always live under /videos/.
    if (!/\/videos\//i.test(abs)) return;
    if (isScrapeJunkUrl(abs)) return;
    const title = cleanThumbTitle(block);
    if (!title) return;
    const img = block.find('img').first();
    const thumb = scrapeThumbUrl(img);
    const durText = block.find('.duration, var.duration, .thumb-duration').first().text().trim();
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;
    // A thumb without a duration is a category/avatar card, not a video.
    if (!duration) return;

    videos.push({
      id: scrapeVideoId('xhamster', abs, xhamsterVideoKey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
      duration,
      category: 'xHamster',
      sourceSite: 'xhamster.com',
      extractor: 'xhamster-html'
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

// ---- SpankBang search (HTML) ------------------------------------------------
async function spankBangSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const sbHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://spankbang.com/',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1'
  };
  const res = await net.fetch(searchUrl, {
    method: 'GET',
    headers: sbHeaders,
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText}) from ${searchUrl}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const videos = [];
  const seen = new Set();
  const junk = new Set();

  $('.video-item, a.video-item, .video-list .video-item').each((_i, el) => {
    const block = $(el);
    // Real SpankBang hits always live under /{id}/video/{slug}/ — reject
    // category/\"New Videos\"/channel/ad chips exactly like the suite.
    const link = block.is('a[href*="/video/"]') ? block : block.find('a[href*="/video/"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = /^https?:/i.test(href) ? href : `https://spankbang.com${href}`;
    if (!/^https?:\/\//i.test(abs)) return;
    if (!/\/video\//i.test(abs)) return;
    if (isScrapeJunkUrl(abs) || seen.has(abs)) return;
    seen.add(abs);
    const title = cleanThumbTitle(block);
    if (!title) return;
    const img = block.find('img').first();
    const thumb = scrapeThumbUrl(img);
    const durText = block.find('.duration, var.duration, .d').first().text().trim();
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;
    if (duration < 1) return;
    videos.push({
      id: scrapeVideoId('spankbang', abs, spankBangVideoKey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
      duration,
      category: 'SpankBang',
      sourceSite: 'spankbang.com',
      extractor: 'spankbang-html'
    });
  });

  return videos.filter(v => v.videoUrl && v.videoUrl.startsWith('http')).slice(0, count);
}

function spankBangVideoKey(u) {
  const m = String(u || '').match(/\/video\/([0-9a-zA-Z]+)/i);
  return m ? m[1] : '';
}

// ---- HQPorner search (HTML) -------------------------------------------------
async function hqPornerSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const hqHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://hqporner.com/',
    'Upgrade-Insecure-Requests': '1',
    'DNT': '1'
  };
  const res = await net.fetch(searchUrl, {
    method: 'GET',
    headers: hqHeaders,
    signal: AbortSignal.timeout(20000),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${res.statusText}) from ${searchUrl}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  const videos = [];
  const seen = new Set();

  $('.video-item, a.video-item, .video-mozaique .video-item, .wd-videos a').each((_i, el) => {
    const block = $(el);
    // Real HQPorner (WP) results anchor under /hd/{id}/ — categories, channels
    // and ad chips anchor elsewhere, so require /hd/ + a real duration.
    const link = block.is('a[href*="/hd/"]') ? block : block.find('a[href*="/hd/"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = /^https?:/i.test(href) ? href : `https://hqporner.com${href}`;
    if (!/^https?:\/\//i.test(abs)) return;
    if (!/\/hd\//i.test(abs)) return;
    if (isScrapeJunkUrl(abs) || seen.has(abs)) return;
    seen.add(abs);
    const title = cleanThumbTitle(block);
    if (!title) return;
    const img = block.find('img').first();
    const thumb = scrapeThumbUrl(img);
    const durText = block.find('.duration, var.duration').first().text().trim();
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;
    if (duration < 1) return;
    videos.push({
      id: scrapeVideoId('hqporner', abs, hqPornerVideoKey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
      duration,
      category: 'HQPorner',
      sourceSite: 'hqporner.com',
      extractor: 'hqporner-html'
    });
  });

  return videos.filter(v => v.videoUrl && v.videoUrl.startsWith('http')).slice(0, count);
}

function hqPornerVideoKey(u) {
  const m = String(u || '').match(/\/hd\/([0-9a-zA-Z]+)/i);
  return m ? m[1] : '';
}

// ---- XNXX search -----------------------------------------------------------
// XNXX reuses the xvideos-family ".mozaique .thumb-block" result grid. Parse
// only real /video-{id} thumbs, sanitize junk URLs/titles, and require a
// duration (same rules as the xvideos and pornhub parsers above).
function xnxxVideoKey(u) {
  const m = String(u || '').match(/\/video-([0-9]+)/i);
  return m ? m[1] : '';
}

async function xnxxSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const browserHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.xnxx.com/',
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

  $('.mozaique .thumb-block, #content .thumb-block').each((_i, el) => {
    const block = $(el);
    const link = block.find('a[href*="/video-"], a[href*="/video/"]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = /^https?:/i.test(href) ? href : `https://www.xnxx.com${href}`;
    if (!/^https?:/i.test(abs)) return;
    // Strict: only real /video-{id} (classic) or /video/{slug} result pages.
    if (!/\/video-|\/video\//i.test(abs)) return;
    if (isScrapeJunkUrl(abs)) return;
    // v1.0.36: expanded title resolution across the anchors xNXX uses
    // (.title a, .thumb-under a, .title-link, a.a-title, .video-title) — anchor
    // title attr -> anchor text -> poster alt -> card title attr. Reject outright
    // when the result is empty, "untitled"/"Image"/"Image source" (brand-new
    // /video/ slugs default to those), purely metric/duration text, or <4 chars.
    const titleEl = block.find('.title a, p a, .thumb-under a, .thumb-under .name a, a.a-title, .title-link, .video-title a').first();
    const title = (
      String(titleEl.attr('title') || '') ||
      String(titleEl.text().replace(/\s+/g, ' ').trim() || '') ||
      String(block.find('img').first().attr('alt') || '') ||
      String(block.attr('title') || '')
    ).trim().substring(0, 200);
    if (!title || isScrapeJunkTitle(title)) return;
    const img = block.find('img').first();
    const thumb = scrapeThumbUrl(img);
    const durText = block.find('.duration').text().trim();
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;
    if (!duration) return;

    videos.push({
      id: scrapeVideoId('xnxx', abs, xnxxVideoKey(abs)),
      title,
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
      duration,
      category: 'XNXX',
      sourceSite: 'xnxx.com',
      extractor: 'xnxx-html'
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

// ---- HentaiHaven search -----------------------------------------------------
// HentaiHaven's WP loop mixes real post cards with nav/footer links that share
// the same title markup. Restrict to genuine article post-card containers and
// drop any entry whose title matches the classic nav/footer strings (Privacy
// Policy, Terms of Service, "Pick Your Poison", etc.).
const HENTAIHAVEN_CARD_SELECTORS = 'article.post, article.post-card, .site-content .grid-item, .post-card';
const HENTAI_NAV_TITLES = /^(?:Privacy Policy|Terms of Service|Contact|About|Clear|Pick Your Poison|AI Hentai|RTA|DMCA|FAQ|Home)$/i;

async function hentaiHavenSearchHtml(searchUrl, count = 25) {
  const cheerio = require('cheerio');
  const browserHeaders = {
    'User-Agent': PH_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://hentaihaven.xxx/',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
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

  $(HENTAIHAVEN_CARD_SELECTORS).each((_i, el) => {
    const card = $(el);
    // A post card links to one video page — grab the first plausible anchor.
    const link = card.find('a[href]').first();
    if (!link.length) return;
    const href = String(link.attr('href') || '');
    const abs = /^https?:/i.test(href) ? href : `https://hentaihaven.xxx${href.startsWith('/') ? href : '/' + href}`;
    if (!/^https?:/i.test(abs)) return;
    if (isScrapeJunkUrl(abs)) return;
    const img = card.find('img').first();
    const title = (
      link.attr('title') ||
      card.find('.entry-title, .post-title, h2, h3, h4, .title').first().text().trim() ||
      img.attr('alt') ||
      card.text().replace(/\s+/g, ' ').trim() ||
      'Untitled'
    ).trim().substring(0, 200);
    if (HENTAI_NAV_TITLES.test(title)) return;
    if (isScrapeJunkTitle(title)) return;
    const thumb = scrapeThumbUrl(img);
    const durText = card.find('.duration, var.duration, .time').first().text().trim();
    const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
    const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;

    videos.push({
      id: scrapeVideoId('hentaihaven', abs),
      title: title || 'Untitled',
      thumbnailUrl: thumb,
      videoUrl: abs,
      pageUrl: abs,
      duration,
      category: 'HentaiHaven',
      sourceSite: 'hentaihaven.xxx',
      extractor: 'hentaihaven-html'
    });
  });

  const seen = new Set();
  return videos
    .filter(v => {
      if (!v.videoUrl || seen.has(v.videoUrl)) return false;
      seen.add(v.videoUrl);
      return true;
    })
    .slice(0, count || 25);
}

// ---- Hentaimama search ------------------------------------------------------
// Hentaimama is a JS-rendered WP/DLE theme, so scrape it in the stealth (real
// browser) window and extract ONLY article post-card containers — clean video
// page links, no nav/footer junk. The grid can re-render while Turnstile
// settles, so the extractor covers both WP (.site-content .grid-item,
// article.post) and DLE (short-item / video-item) template families, and the
// caller re-polls the DOM until cards appear.
const HENTAIMAMA_EXTRACT_SCRIPT = `
var out = [];
var items = [].slice.call(document.querySelectorAll(
  'article.post, article.post-card, .site-content .grid-item, .post-card, .short-item, .video-item, .short, .movie-item, .main-box .item, .items .post'
));
for (var i = 0; i < items.length; i++) {
  var b = items[i];
  var a = b.querySelector('a[href]');
  if (!a) continue;
  var raw = String(a.getAttribute('href') || '');
  if (!raw || /^\\\\s*javascript/i.test(raw)) continue;
  var abs;
  try { abs = new URL(raw, location.href).href; } catch (e) { continue; }
  if (/\\\\.(css|js|png|jpe?g|gif|svg|webp|ico|woff|ttf|mp4|m3u8)([?#]|$)/i.test(abs)) continue;
  var img = b.querySelector('img');
  var thumb = img ? (img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '') : '';
  var alt = img ? img.getAttribute('alt') : '';
  var head = b.querySelector('.post-title a, .entry-title a, .title a, .post-title, .video-title, h2, h3, h4');
  var title = (a.getAttribute('title') || alt || (head ? head.textContent.trim() : '') || b.textContent.replace(/\\\\s+/g, ' ').trim() || '').slice(0, 200);
  var d = ((b.querySelector('.duration, .time, .date') || {}).textContent || '').trim();
  out.push({ title: title, thumb: thumb, url: abs, duration: d });
  if (out.length >= __LIMIT__) break;
}
return { out: out, href: location.href, title: document.title };
`;

async function hentaiMamaStealthSearch(searchUrl, count = 25) {
  const win = ensureStealthWindow();
  // Hentaimama's Turnstile needs a longer settle than the shared default, so
  // the challenge clears AND the JS grid re-renders before the DOM is read.
  const load = await loadInStealth(searchUrl, { pauseAfterLoadMs: HENTAIMAMA_SETTLE_MS, challengeTimeoutMs: 25000 });
  if (!load.success) throw new Error('Hentaimama stealth load failed: ' + load.error);
  const code = HENTAIMAMA_EXTRACT_SCRIPT.replace('__LIMIT__', String(count || 25));

  // DOM fallback parser: re-poll until the rendered grid actually appears
  // (slow WP/DLE grid paints + lazy card loading), then accept the first
  // non-empty, junk-filtered read.
  let extracted = null;
  for (let i = 0; i < 6; i++) {
    if (win.isDestroyed()) break;
    extracted = await evalInStealth(code, 8000);
    if (extracted && extracted.__stealthError) {
      throw new Error('Hentaimama DOM extraction failed: ' + extracted.__stealthError);
    }
    const list = (extracted && Array.isArray(extracted.out)) ? extracted.out : [];
    if (list.some((r) => r && r.url && !isScrapeJunkUrl(r.url))) break;
    await sleep(1200);
  }
  const list = (extracted && Array.isArray(extracted.out)) ? extracted.out : [];
  if (extracted && extracted.__stealthError) {
    throw new Error('Hentaimama DOM extraction failed: ' + extracted.__stealthError);
  }
  const seen = new Set();
  return list
    .filter((r) => {
      const t = String(r.title || '').trim();
      if (isScrapeJunkTitle(t)) return false;
      if (HENTAI_NAV_TITLES.test(t)) return false;
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r) => {
      const durText = String(r.duration || '').trim();
      const dm = durText.match(/(?:(\d+)h\s*)?(\d+):(\d+)/);
      const duration = dm ? (dm[1] ? parseInt(dm[1], 10) * 3600 : 0) + parseInt(dm[2], 10) * 60 + parseInt(dm[3], 10) : 0;
      return {
        id: scrapeVideoId('hentaimama', r.url),
        title: String(r.title || 'Untitled').substring(0, 200),
        thumbnailUrl: r.thumb || '',
        videoUrl: r.url,
        pageUrl: r.url,
        duration,
        category: 'Hentaimama',
        sourceSite: 'hentaimama',
        extractor: 'hentaimama-stealth'
      };
    })
.slice(0, count || 25);
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
      // Server rows may arrive without an id/pageUrl; give each one a stable,
      // collision-free identity so per-card favorite state stays isolated.
      const videos = json.videos.map((v) => {
        const pageUrl = String(v.pageUrl || v.videoUrl || v.url || '').trim();
        return {
          ...v,
          id: v.id || scrapeVideoId('gateway', pageUrl),
          pageUrl: v.pageUrl || pageUrl
        };
      });
      return { success: true, source: json.source || 'gateway', videos, fallback: true };
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
  const rawJson = await ytDlp.execPromise(withYtDlpArgs([
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
      // Always use the canonical search URL; a stale /search/:slug target or a
      // bare pornhub.com root behaves differently than the real search page.
      const phSearchUrl = 'https://www.pornhub.com/video/search?search=' + encodeURIComponent(q);
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

    // xHamster mixes real video thumbs (.video-thumb) with category/language
    // chips, so parse the grid with xhamster-specific selectors + the shared
    // junk/duration filter instead of generic card walkers.
    if (/^https?:\/\//i.test(target) && /(^|\.)xhamster\.com$/i.test(new URL(target).hostname)) {
      const xhSearchUrl = 'https://xhamster.com/search.php?q=' + encodeURIComponent(q);
      try {
        const xhVideos = await xhamsterSearchHtml(xhSearchUrl, count);
        if (xhVideos.length > 0) {
          console.log(`[web:search] xhamster search returned ${xhVideos.length} results`);
          return { success: true, source: 'xhamster', videos: xhVideos };
        }
      } catch (xhErr) {
        console.warn(`[web:search] xhamster HTML search failed: ${xhErr.message}`);
      }
    }

    // XNXX reuses the xvideos-family ".mozaique .thumb-block" grid; parse it
    // strictly (real /video-{id} links only, junk-filtered, duration required).
    if (/^https?:\/\//i.test(target) && /(^|\.)xnxx\.com$/i.test(new URL(target).hostname)) {
      const xnSearchUrl = 'https://www.xnxx.com/search/' + encodeURIComponent(q);
      try {
        const xnVideos = await xnxxSearchHtml(xnSearchUrl, count);
        if (xnVideos.length > 0) {
          console.log(`[web:search] xnxx search returned ${xnVideos.length} results`);
          return { success: true, source: 'xnxx', videos: xnVideos };
        }
      } catch (xnErr) {
        console.warn(`[web:search] xnxx HTML search failed: ${xnErr.message}`);
      }
    }

    // SpankBang search (HTML): server-rendered .video-item grid. Each real
    // hit anchors under /{id}/video/ so we require that path and junk-filter
    // like the rest of the top-tier suite.
    if (/^https?:\/\//i.test(target) && /(^|\.)spankbang\.com$/i.test(new URL(target).hostname)) {
      const sbSearchUrl = 'https://spankbang.com/s/' + encodeURIComponent(q) + '/';
      try {
        const sbVideos = await spankBangSearchHtml(sbSearchUrl, count);
        if (sbVideos.length > 0) {
          console.log(`[web:search] spankbang search returned ${sbVideos.length} results`);
          return { success: true, source: 'spankbang', videos: sbVideos };
        }
      } catch (sbErr) {
        console.warn(`[web:search] spankbang HTML search failed: ${sbErr.message}`);
      }
    }

    // HQPorner search (HTML): WP post grid under /hd/ real-video paths.
    if (/^https?:\/\//i.test(target) && /(^|\.)hqporner\.com$/i.test(new URL(target).hostname)) {
      const hqSearchUrl = 'https://hqporner.com/?s=' + encodeURIComponent(q);
      try {
        const hqVideos = await hqPornerSearchHtml(hqSearchUrl, count);
        if (hqVideos.length > 0) {
          console.log(`[web:search] hqporner search returned ${hqVideos.length} results`);
          return { success: true, source: 'hqporner', videos: hqVideos };
        }
      } catch (hqErr) {
        console.warn(`[web:search] hqporner HTML search failed: ${hqErr.message}`);
      }
    }

    // Deprecated v1.0.37: hentaihaven's WP loop nav/footer links masquerade as
    // post cards and ad-hijacked overlays keep breaking the parse; the site is
    // pruned from the active suite (see scraper-suite pruning note below).
    if (false && /^https?:\/\//i.test(target) && /(^|\.)hentaihaven\./i.test(new URL(target).hostname)) {
      // Pruned from the active suite in v1.0.37 — branch disabled.
    }

    // Deprecated v1.0.37: Hentaimama's JS-rendered WP theme keeps rotating
    // ad-hijacked .post-item overlays and its stealth DOM work was getting flaky;
    // the site is pruned from the active suite alongside hentaihaven/zhentube/
    // uncensored-hentai (see scraper-suite pruning note).
    if (false && /^https?:\/\//i.test(target) && /(^|\.)hentaimama\./i.test(new URL(target).hostname)) {
      // Pruned from the active suite in v1.0.37 — branch disabled.
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
      .map(v => {
        const pageUrl = String(v.pageUrl || v.videoUrl || v.url || '').trim();
        return {
          id: v.id || scrapeVideoId('scraped', pageUrl),
          title: v.title || 'Untitled',
          thumbnailUrl: v.thumbnail || v.thumbnailUrl || '',
          videoUrl: v.videoUrl || v.url || '',
          pageUrl,
          duration: v.duration || 0,
          category: v.category || 'Video',
          sourceSite: v.sourceSite || getDomain(target),
          extractor: 'html-scraper'
        };
      })
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

// Home feed: YouTube trending. Primary source is yt-dlp flat enumeration of the
// official trending feed; if the binary is unavailable or the feed is blocked,
// fall back to a broad popularity search so the Home shelf is never empty.
ipcMain.handle('web:trending', async (_event, { count = 12 } = {}) => {
  const limit = Math.min(Math.max(Number(count) || 12, 1), 40);
  const shape = (entries, source) => {
    const seen = new Set();
    return entries
      .filter(e => e && e._type !== 'playlist' && ((e.webpage_url || e.url)))
      .map(e => normalizeSearchEntry(e, 'YouTube'))
      .filter(v => v.videoUrl && /^https?:\/\//i.test(v.videoUrl))
      .filter(v => {
        if (seen.has(v.pageUrl || v.videoUrl)) return false;
        seen.add(v.pageUrl || v.videoUrl);
        return true;
      })
      .slice(0, limit)
      .map(v => ({ ...v, videoTitle: v.title, source }));
  };
  try {
    const binaryAvailable = await ensureYtDlpBinary();
    if (!binaryAvailable) {
      return { success: false, error: 'yt-dlp unavailable' };
    }
    // Fire both sources at once: yt-dlp's trending tab is preferred, but it
    // redirects to the YouTube home page in some regions/accounts, so a broad
    // popularity search runs in parallel as a guaranteed fallback.
    const trendingTask = runFlatPlaylist('https://www.youtube.com/feed/trending', limit)
      .then(entries => shape(entries, 'trending'))
      .catch(err => { console.warn('[web:trending] trending feed unavailable:', String(err.message || '').split('\n')[0]); return []; });
    // Pass a bare query: runFlatPlaylist() adds the `ytsearch<count>:` prefix
    // itself. (Pre-prefixing here produced `ytsearch6:ytsearch6:...`, which
    // YouTube answers with zero results — making the whole shelf look empty.)
    const searchTask = runFlatPlaylist('popular music videos this week', limit)
      .then(entries => shape(entries, 'popular'))
      .catch(err => { console.warn('[web:trending] popularity search failed:', err.message); return []; });

    const trending = await trendingTask;
    if (trending.length > 0) return { success: true, source: 'yt-dlp-trending', videos: trending };
    const popular = await searchTask;
    if (popular.length > 0) return { success: true, source: 'yt-dlp-search', videos: popular };
    return { success: false, error: 'Trending is temporarily unavailable' };
  } catch (err) {
    return { success: false, error: err.message };
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
        const rawJson = await ytDlp.execPromise(withYtDlpArgs([
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
    // Hide the native application menu (File/Edit/View/Window/Help) entirely —
    // the app is a kiosk-style media hub and its controls live in the web UI.
    Menu.setApplicationMenu(null);
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
