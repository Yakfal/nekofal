import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { bindMediaKey, unbindMediaKey } from '../utils/mediaKeys.js';
import { pickBestStream, isYouTubeUrl } from '../services/customScraper.js';
import { favoritePayloadFor, getMediaId, autoSync } from '../services/dbAdapter.js';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import './VideoPlayer.css';

// v1.0.68 YouTube freeze: the diagnostic hlsPlay/controlHls import hls.js LIVE
// from node_modules (file:// URL) and play every time inside this renderer,
// while the vite-BUNDLED class persistently fails its very first manifest XHR
// with a status-0 refusal. Boot the live class once and route the isYt
// pipeline through it — the single untested delta vs the always-working probe.
let LIVE_HLS_CLS = null;
const LIVE_HLS_URL = 'hls.js';
const LIVE_HLS_BOOT = import('hls.js').then((m)=>{const C=(m&&(m.default||m.Hls))||null;if(C){if(!C.Events) C.Events=Hls.Events; LIVE_HLS_CLS=C;}}).catch(()=>{LIVE_HLS_CLS=null;});

// ---- Static configuration (hoisted above the component to avoid TDZ) ----
// Declared with `var` so the output has no block-scoped bindings at module
// level, which is what makes Temporal Dead Zone errors impossible at runtime.
var EXTRACTION_TIMEOUT_MS = 30000;
// Stealth-driven providers (hanime) must load a full browser session,
// clear Cloudflare/Turnstile and wait for the Astro player to hydrate before
// any /hls/ master is emitted, so grant them extra headroom (the sniff
// window lives ~20s and can run longer-than-average on slow loads).
var STEALTH_EXTRACTION_TIMEOUT_MS = 65000;
var PREF_KEY = 'pmh-preferences';

// v1.0.88 — GLOBAL persistent volume memory.
// The volume the user picked lives in ONE localStorage key and is re-applied to
// every <video> element on every source (YouTube/HLS, IPTV, adult scrapers,
// local files). Previously the choice was only kept in the `pmh-preferences`
// blob and applied opportunistically, so a fresh element booted at its default
// of 1.0 and a 10% setting snapped back to 100% on the next video.
var VOLUME_STORAGE_KEY = 'nekofal_user_volume';
var CLICK_DEBOUNCE_MS = 250;
var TIME_POLL_MS = 250;

function clampVolume(v) {
  const n = Number(v);
  if (!isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

// Returns the remembered volume, or null when nothing valid is stored.
function readStoredVolume() {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (raw === null || raw === undefined || raw === '') return null;
    return clampVolume(raw);
  } catch (_e) {
    return null;
  }
}

function writeStoredVolume(v) {
  const n = clampVolume(v);
  if (n === null) return;
  try { localStorage.setItem(VOLUME_STORAGE_KEY, String(n)); } catch (_e) {}
}
var SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Standard resolution tiers shown in the quality menu for YouTube/direct
// streams whose extraction did not enumerate per-height formats. Selecting one
// re-extracts the stream capped at that height (fresh CDN signature included).
var QUALITY_FALLBACKS = [
  { label: '1080p', height: 1080 },
  { label: '720p', height: 720 },
  { label: '480p', height: 480 },
  { label: '360p', height: 360 }
];

// Playback blip recovery: how many times to retry a stream that hiccups on the
// network, with exponential backoff between attempts.
var MAX_PLAYBACK_RETRIES = 5;
var RETRY_BACKOFF_MS = [800, 1600, 3200, 6400, 12800];
// IPTV/Web TV dead-stream budget: if a live channel does not reach
// 'playing' within this window (no manifest, stalled tunnel, server reject),
// it is treated as unavailable — mark it dead in the DB and skip/close.
var IPTV_WATCHTIMEOUT_MS = 12000;

// Local video server port (from electron main.js). Defaults to 5001 but can be
// dynamic if the preferred ports were busy — refresh via getVideoServerInfo().
var videoProxyPort = 5001;
// Per-launch secret that must be appended to every local-proxy URL (SSRF guard).
var videoProxyToken = null;

function proxyOrigin() { return `http://localhost:${videoProxyPort}`; }

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY)) || {};
  } catch {
    return {};
  }
}

function writePref(key, value) {
  const prefs = readPrefs();
  prefs[key] = value;
  localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
}

// ---- HLS / yt-dlp quality helpers ------------------------------------------

// Common bitrate→height mapping (approximate; real-world varies by codec).
function estimateHeightFromBitrate(bps) {
  if (bps >= 8000000)  return 4320;
  if (bps >= 3500000)  return 2160;
  if (bps >= 2000000)  return 1080;
  if (bps >= 1000000)  return 720;
  if (bps >= 500000)   return 480;
  if (bps >= 250000)   return 360;
  if (bps >= 120000)   return 240;
  return 144;
}

// Resolve height from an HLS level: l.height → attrs.RESOLUTION → bitrate.
function parseHlsResolution(l) {
  if (!l) return { width: 0, height: 0 };
  let h = Number(l.height) || 0;
  let w = Number(l.width) || 0;
  if ((!h || !w) && l.attrs && l.attrs.RESOLUTION) {
    const m = String(l.attrs.RESOLUTION).match(/(\d+)\s*[xX]\s*(\d+)/);
    if (m) { w = parseInt(m[1], 10); h = parseInt(m[2], 10); }
  }
  if (!h && l.bitrate) h = estimateHeightFromBitrate(l.bitrate);
  return { width: w, height: h };
}

// Human-readable label for a given height (e.g. 1440 → "1440p (2K)").
function qualityLabel(h) {
  if (!h || h <= 0) return '';
  const tiers = [
    [4320, '4320p (8K)'],
    [2160, '2160p (4K)'],
    [1440, '1440p (2K)'],
    [1080, '1080p'],
    [720, '720p'],
    [480, '480p'],
    [360, '360p'],
    [240, '240p'],
    [144, '144p']
  ];
  for (const [tier, name] of tiers) {
    if (h >= tier) return name;
  }
  return `${h}p`;
}

// v1.0.66: UNIVERSAL quality-menu deduplicator. Multiple sources hand the
// dropdown rows that render the SAME label (two "720p" entries — hls.js
// separates 720p30/720p60, the adult inline parsers can emit a script-call row
// AND a JSON-key row for one resolution, YouTube's roster can carry two
// formats at one height). Collapse by the DISPLAY string (label → height →
// width), keep the FIRST occurrence (best/first in engine order), and stamp
// the source-engine index so quality switching still routes to the correct
// level/format even though the display list is sorted high→low.
function dedupeQualityRows(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Map();
  for (let i = 0; i < raw.length; i++) {
    const q = raw[i];
    if (!q) continue;
    const label = (typeof q.label === 'string' && q.label.trim())
      || qualityLabel(q.height)
      || (q.width ? `${Math.round(q.width)}px` : '')
      || (q.formatId ? String(q.formatId) : '');
    const key = label.toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, { ...q, _engineIndex: i });
    }
  }
  return [...seen.values()].sort((a, b) =>
    ((b.height || 0) - (a.height || 0)) || (a._engineIndex - b._engineIndex)
  );
}

function VideoPlayer({ video, onClose, channelList, channelIndex, onZapTo }) {
  const { setMediaSession } = usePlayback();
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const streamHlsRef = useRef(false);
  const webviewRef = useRef(null);
  const progressRef = useRef(null);
  const volumeRef = useRef(null);
  const volumeHoverTimer = useRef(null);
  const controlsTimeoutRef = useRef(null);
  const channelIndexRef = useRef(Number.isInteger(channelIndex) ? channelIndex : 0);
  const osdTimerRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const isPaused = !isPlaying;
  const [isControlsVisible, setIsControlsVisible] = useState(true);
  const [osd, setOsd] = useState(null);
  const isZapping = Array.isArray(channelList) && channelList.length > 0;
  const [isLoading, setIsLoading] = useState(true);
  const [isExtracting, setIsExtracting] = useState(false);
  const [streamError, setStreamError] = useState(null);
  const [hasError, setHasError] = useState(false);
  const [streamUrl, setStreamUrl] = useState(null);
  const [isDRM, setIsDRM] = useState(false);
  const [drmWebUrl, setDrmWebUrl] = useState(null);
  const [volume, setVolume] = useState(() => {
    // Order matters: the globally remembered volume wins so that loading a
    // DIFFERENT video does not reset the user's choice. An explicit
    // `startVolume` (mini-player restore) is still honoured when present,
    // because that path is deliberately carrying over one specific session's
    // audio level.
    if (typeof video?.startVolume === 'number') return clampVolume(video.startVolume);
    const stored = readStoredVolume();
    if (stored !== null) return stored;
    const p = readPrefs();
    return typeof p.defaultVolume === 'number' ? clampVolume(p.defaultVolume) : 1;
  });
  const [isMuted, setIsMuted] = useState(() => {
    if (typeof video?.startMuted === 'boolean') return video.startMuted;
    return false;
  });
  const [isFav, setIsFav] = useState(false);
  const [favChecking, setFavChecking] = useState(true);
  const [favToggling, setFavToggling] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(() => {
    const p = readPrefs();
    return typeof p.defaultRate === 'number' ? p.defaultRate : 1;
  });
  const [qualityLevels, setQualityLevels] = useState([]);
  // v1.0.61: extractor-enumerated HLS variant tiers ({ height, label, url }).
  // Kept separate from the hls.js-derived menu because a tokenized master
  // (hanime) collapses to ONE height-0 level — the extracted variants give
  // the dropdown real resolutions and per-variant URLs to switch to.
  const [extractQualityLevels, setExtractQualityLevels] = useState([]);
  // v1.0.62: the RAW remote master (pre-proxy) for the current playback — the
  // local proxy path is useless as a base for absolute variant URLs. Used by
  // the degenerate-manifest recovery parser.
  const originStreamUrlRef = useRef(null);
  // v1.0.62: one master-quality parse attempt per origin — prevents a loop
  // where every degenerate manifest re-triggers the same fetch.
  const masterParseAttemptedRef = useRef(null);
  // v1.0.63: preserve play/pause state across quality-switch source reloads.
  // null = normal autoplay; false = keep the player paused after the swap.
  const pendingPlayRef = useRef(null);
  // Dual-engine fallback: direct-URL format list ({ label, height, url })
  // from extraction when hls.js has no levels (non-HLS playback). Used to
  // hot-swap quality by re-pointing <video> without re-running yt-dlp.
  const [directFormats, setDirectFormats] = useState([]);
  const [selectedQuality, setSelectedQuality] = useState('auto');
  const [menuOpen, setMenuOpen] = useState(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const pendingSeekRef = useRef(null);
  const lastSaveTimeRef = useRef(0);
  // v1.0.61: the active httpHeaders handed to getProxiedUrl — re-used when
  // switching to an HLS variant URL (segment/CDN hosts need them, too).
  const activeHttpHeadersRef = useRef(null);
  // v1.0.61: remember which stream the saved-quality pref was auto-applied to,
  // so a variant switch doesn't re-trigger the same switch on the next
  // manifest parse.
  const variantAppliedRef = useRef(null);
  // v1.0.61: debounce watch-history progress pushes to the cloud (continue
  // watching crosses devices while the video is still on screen).
  const syncTimerRef = useRef(null);
  const ytLiveElRef = useRef(null); // reserved: legacy YT fresh-element probe, unused in v1.0.68
  const mirrorYt = useCallback((fn) => { try { if (ytLiveElRef.current && typeof fn === "function") fn(ytLiveElRef.current); } catch (_e) {} }, []);

  // --- REAL-TIME ACTIVE MEDIA DOM BRIDGE ---
  const getActiveMediaElement = () => {
    if (ytLiveElRef && ytLiveElRef.current && (!ytLiveElRef.current.paused || ytLiveElRef.current.currentTime > 0)) {
      return ytLiveElRef.current;
    }
    if (videoRef && videoRef.current && (!videoRef.current.paused || videoRef.current.currentTime > 0)) {
      return videoRef.current;
    }
    const domVideos = Array.from(document.querySelectorAll('video'));
    const active = domVideos.find(v => !v.paused || v.currentTime > 0);
    return active || (videoRef ? videoRef.current : null) || (ytLiveElRef ? ytLiveElRef.current : null);
  };
  const ytReExtractRef = useRef(0);
  const ytReloadRef = useRef(0); // v1.0.68: bounded fresh-hls-instance retries for YT master refusals
  const ytParsedRef = useRef(false); // v1.0.68: true once the current stream's hls parsed its master (restart guard)
  const [hlsRetryKey, setHlsRetryKey] = useState(0);
  const hlsFallbackUsedRef = useRef(false);
  const hlsSelfHealUsedRef = useRef(false);
  const sourceUrlRef = useRef(null);
  const streamUrlRef = useRef(null);
  const networkRetryRef = useRef(0);
  const stallCountRef = useRef(0);
  const retryTimerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const audioNodesRef = useRef(null);
  // IPTV watchdog: a live/Web TV channel must start PLAYING within
  // IPTV_WATCHTIMEOUT_MS of stream load, or it is treated as dead (skip/close).
  const iptvWatchRef = useRef(null);
  const deadIptvMarkedRef = useRef(new Set());
  const [streamUnavailable, setStreamUnavailable] = useState(false);

  // ---------------------------------------------------------------------------
  // WebAudio enhancement: route the media element through a light EQ +
  // compressor so audio never sounds compressed/flat (thin highs, muffled
  // lows). All wrapped in try/catch — sources blocked by cross-origin/CORS
  // (or an already-claimed element) fall back to the normal pipeline silently.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const el = videoRef.current;
    if (!el || audioNodesRef.current) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx = null;
    try {
      ctx = new AC();
      const source = ctx.createMediaElementSource(el);
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 20;
      compressor.ratio.value = 3;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 4000;
      shelf.gain.value = 3;
      const lowshelf = ctx.createBiquadFilter();
      lowshelf.type = 'lowshelf';
      lowshelf.frequency.value = 150;
      lowshelf.gain.value = 1.5;
      source.connect(lowshelf).connect(shelf).connect(compressor).connect(ctx.destination);
      audioCtxRef.current = ctx;
      audioNodesRef.current = { source, compressor, shelf, lowshelf };
      // Help the context resume if AutoplayPolicy suspended it mid-playback.
      el.addEventListener('play', () => {
        if (audioCtxRef.current && audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
      });
    } catch (err) {
      console.warn('[VideoPlayer] WebAudio enhancement unavailable:', err.message);
      if (ctx) { ctx.close().catch(() => {}); }
      audioCtxRef.current = null;
      audioNodesRef.current = null;
    }
    return () => {
      if (audioNodesRef.current && audioNodesRef.current.source) {
        try { audioNodesRef.current.source.disconnect(); } catch { /* already gone */ }
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
        audioNodesRef.current = null;
      }
    };
  }, []);

  // Register custom stream headers (referer/UA/cookies from extraction or the
  // record) with the main process so Electron's session can inject them
  // natively on the raw stream requests - no server-side relay involved.
  const registerStreamHeaders = useCallback(async (url, httpHeaders) => {
    try {
      const api = window.api || window.electronAPI;
      if (api?.setStreamHeaders && httpHeaders && typeof httpHeaders === 'object' && Object.keys(httpHeaders).length) {
        api.setStreamHeaders(String(url), httpHeaders).catch(() => {});
      }
    } catch { /* best-effort */ }
  }, []);

  // Resolve how a stream should be played.
  //  - Local files (file:// or a drive path) go through the local file server
  //    (Range/seek support) - never the remote gateway.
  //  - Remote streams play DIRECT (raw source URL, no Express relay). Custom
  //    headers from http_headers are registered so Electron's network layer
  //    attaches them natively (User-Agent / Referer) to every request.
  const getProxiedUrl = useCallback((url, httpHeaders = null) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        // Already routed through our local file server — return as-is (re-inject
        // the per-launch token if a stale stored URL is missing it).
        if (u.hostname === 'localhost' && u.pathname.includes('/video/proxy')) {
          if (videoProxyToken && !u.searchParams.get('t')) {
            u.searchParams.set('t', videoProxyToken);
            return u.toString();
          }
          return url;
        }
        const isLocalFile = url.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(url);
        if (isLocalFile) {
          return `http://localhost:${videoProxyPort}/video/proxy/stream?t=${videoProxyToken}&src=${encodeURIComponent(url)}`;
        }
        // v1.0.68 YouTube: googlevideo master/child/segment URIs get REFUSED
        // (status 0 xhr errors) when fetched repeatedly from the renderer on a
        // fast-working IP — YT's burst filter + short-lived signed URLs. Route
        // every googlevideo fetch through our local video proxy instead: main
        // fetches from Node (stable) and rewrites the m3u8 child URIs so hls.js
        // never talks to googlevideo directly.
        if (/googlevideo\.com/i.test(u.hostname) && videoProxyToken) {
          return `http://localhost:${videoProxyPort}/video/proxy/stream?t=${videoProxyToken}&src=${encodeURIComponent(url)}`;
        }
        if (httpHeaders && Object.keys(httpHeaders).length) {
          registerStreamHeaders(url, httpHeaders);
        }
        return url;
      }
    } catch (e) {
      // Invalid URL, use as-is
    }
    return url;
  }, [registerStreamHeaders]);

  // Learn the real video-server port from the main process (port may be dynamic
  // when the preferred 5001..5010 range was busy).
  useEffect(() => {
    let alive = true;
    window.api?.getVideoServerInfo?.().then((info) => {
      if (alive && info && info.port) {
        videoProxyPort = Number(info.port) || 5001;
      }
      if (alive && info && info.token) {
        videoProxyToken = info.token;
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Keep a ref mirror of the active stream URL for retry logic.
  useEffect(() => {
    streamUrlRef.current = streamUrl;
  }, [streamUrl]);

  // Favorite state: seed from the real favorites table (a heart toggle in the
  // player must reflect the same DB rows the card grid shows).
  useEffect(() => {
    let alive = true;
    const api = window.api || window.electronAPI;
    const favKey = getMediaId(video);
    if (!api?.checkIsFavorite || !favKey) {
      setFavChecking(false);
      return undefined;
    }
    setFavChecking(true);
    api.checkIsFavorite(favKey).then((res) => {
      if (!alive) return;
      setIsFav(!!(res && res.success && res.favorited));
    }).catch(() => {}).finally(() => {
      if (alive) setFavChecking(false);
    });
    return () => { alive = false; };
  }, [video]);

  // Favorite heart toggle. Bidirectional and optimistic: when the item is not
  // favorited we add it, when it is we remove it — the red filled heart (♥)
  // flips to hollow (♡) instantly, then we reconcile against the DB result.
  const toggleFavorite = useCallback(async (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (e && e.preventDefault) e.preventDefault();
    if (favToggling) return;
    const api = window.api || window.electronAPI;
    const payload = favoritePayloadFor(video);
    if (!payload.id) return;
    const nextFav = !isFav;
    setFavToggling(true);
    setIsFav(nextFav);
    try {
      if (nextFav) {
        // Favorite: add via the canonical payload (id + pageUrl + provider).
        if (api?.setFavorite) {
          const res = await api.setFavorite(payload);
          if (res && res.success === false) setIsFav(!nextFav);
        } else if (api?.toggleFavorite) {
          const res = await api.toggleFavorite(payload);
          if (res && res.success) setIsFav(!!(res.data ? res.data.favorited : res.favorited));
        }
      } else {
        // Unfavorite: remove by the canonical media id (favorites rows are
        // keyed on `id = media_id`; pageUrl is kept as a legacy fallback).
        const removeKey = payload.media_id || payload.id || payload.pageUrl;
        if (api?.removeFavorite) {
          const res = await api.removeFavorite(removeKey);
          if (res && res.success === false) setIsFav(!nextFav);
        } else if (api?.toggleFavorite) {
          const res = await api.toggleFavorite(payload);
          if (res && res.success) setIsFav(!!(res.data ? res.data.favorited : res.favorited));
        }
      }
      window.dispatchEvent(new Event('favorites-synced'));
    } catch (err) {
      console.warn('[VideoPlayer] Favorite toggle failed:', err);
      setIsFav(!nextFav);
    } finally {
      setFavToggling(false);
    }
  }, [video, favToggling, isFav]);

  // Utility: Promise with timeout
  const withTimeout = useCallback((promise, ms, timeoutError) => {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(timeoutError), ms))
    ]);
  }, []);

  // Persist the current playback position to SQLite (resume support)
  const savePosition = useCallback((pos) => {
    const api = window.api || window.electronAPI;
    if (!video?.id || !api?.saveVideoPosition) return;
    const rounded = Math.max(0, Math.floor(pos || 0));
    api.saveVideoPosition(video.id, rounded).catch(() => {});
  }, [video]);

  // v1.0.61: upsert the watch_history row (continue-watching feed) with the
  // latest progress + duration. Fires on timeupdate (>30s), pause, ended and
  // close so the shelf and the cloud mirror stay fresh even for videos whose
  // resume position has no `videos` row (e.g. hanime search results).
  const recordWatchHistory = useCallback((pos, dur) => {
    const api = window.api || window.electronAPI;
    if (!api?.setWatchHistory || !video || !video.id) return;
    const now = new Date().toISOString();
    const position = Math.max(0, Math.floor(Number(pos) || 0));
    const duration = Math.max(0, Math.floor(Number(dur) || Number(video.duration) || 0));
    api.setWatchHistory({
      id: video.id,
      media_id: video.id,
      title: video.videoTitle || video.title || 'Untitled',
      videoUrl: video.videoUrl || video.url || '',
      pageUrl: video.pageUrl || video.webUrl || '',
      thumbnailUrl: video.thumbnailUrl || video.thumbnail || '',
      duration,
      position,
      positionUpdatedAt: Date.now(),
      watchedAt: now
    }).catch(() => {});
  }, [video]);

  // v1.0.61: debounced cloud push of watch progress (no-op when offline).
  const scheduleSync = useCallback(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      try { autoSync(); } catch (_e) { /* best-effort */ }
    }, 2500);
  }, []);

  // Skip seeking to resume positions that are basically done watching
  const shouldResume = useCallback((pos) => {
    const p = Number(pos) || 0;
    const videoEl = videoRef.current;
    const dur = videoEl?.duration || 0;
    if (p < 5) return false;
    if (dur > 0 && p >= dur - 10) return false;
    return true;
  }, []);

  // Seek to the saved resume position once metadata is available
  const seekToResume = useCallback((videoEl) => {
    if (!pendingSeekRef.current) return;
    const pos = pendingSeekRef.current;
    pendingSeekRef.current = null;
    if (!shouldResume(pos)) return;
    try {
      videoEl.currentTime = pos;
    } catch (e) { /* not ready yet */ }
  }, [shouldResume]);

  // Close player - always accessible
  const closePlayer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const videoEl = videoRef.current;
    if (videoEl) {
      const pos = videoEl.currentTime || 0;
      const dur = videoEl.duration || 0;
      // Persist final position so we can resume next time (reset if finished)
      savePosition(pos >= 5 && (dur <= 0 || pos < dur - 10) ? pos : 0);
      // v1.0.61: flush the continue-watching row + cloud progress on close.
      recordWatchHistory(pos, dur);
      scheduleSync();
      videoEl.pause();
      videoEl.src = '';
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (webviewRef.current) {
      webviewRef.current.src = 'about:blank';
    }
    if (onClose) onClose();
  }, [onClose, savePosition, recordWatchHistory, scheduleSync]);

  // ---- Native OS media controls bridge --------------------------------------
  // PlaybackContext owns navigator.mediaSession and forwards OS media commands
  // here as 'nek-media-command' events. Channel zapping takes over next/prev
  // when live, otherwise they seek like the hardware media keys do.

  // Mirror live playback state into the OS media session (and keep the main
  // process topped-up with a mini-player payload for auto-float on minimize).
  useEffect(() => {
    if (!video) return undefined;
    const artist = isZapping
      ? (video.groupTitle || video.sourceSite || 'Live TV')
      : (video.artistName || video.sourceSite || '');
    setMediaSession({
      active: true,
      title: video.videoTitle || video.title || 'Nekofal',
      artist,
      album: isZapping ? 'Live TV' : 'Nekofal',
      artwork: video.thumbnailUrl ? [{ src: video.thumbnailUrl, sizes: '512x512', type: 'image/jpeg' }] : [],
      playing: isPlaying,
      position: currentTime,
      duration,
      rate: playbackRate,
      streamUrl: streamUrlRef.current || streamUrl || video.videoUrl || '',
      streamHls: !!streamHlsRef.current || !!video.isHLS,
      poster: video.thumbnailUrl || '',
      videoId: video.id != null ? video.id : null,
      isLocal: !!video.isLocal,
      volume,
      muted: isMuted,
      mode: 'video'
    });
  }, [video, isZapping, isPlaying, currentTime, duration, playbackRate, streamUrl, volume, isMuted, setMediaSession]);

  // Clear the OS media session when the player unmounts.
  useEffect(() => () => { setMediaSession(null); }, [setMediaSession]);

  // Keyboard handlers - Escape always closes
  useEffect(() => {
    const handleKeyDown = (e) => {
      const tag = e.target && e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
      if (typing && e.key !== 'Escape') return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePlayer();
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        togglePlayPause();
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
      if (e.key === 'm' || e.key === 'M') {
        toggleMute();
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seekRelative(-5);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        seekRelative(5);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (isZapping) zap(-1);
        else adjustVolume(0.1);
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (isZapping) zap(1);
        else adjustVolume(-0.1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // ------------- Mouse inactivity controls auto-hide -------------
  // Controls stay on screen while the cursor is active (or paused) and fade
  // out after 2.5s of no movement during playback (Netflix-style).
  const clearControlsTimer = useCallback(() => {
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
  }, []);

  const hideControlsSoon = useCallback(() => {
    clearControlsTimer();
    controlsTimeoutRef.current = setTimeout(() => {
      // Pause guard: never hide the controls while the video is paused. The
      // pause-guard effect below also forces them visible on pause, but this
      // ref check closes the race where the 2.5s timer fires right after a
      // pause click (before React has re-rendered with isPaused=true).
      const el = videoRef.current;
      if (el && el.paused) return;
      setIsControlsVisible(false);
    }, 2500);
  }, [clearControlsTimer]);

  const resetControlsTimeout = useCallback(() => {
    setIsControlsVisible(true);
    clearControlsTimer();
    if (!isPaused) hideControlsSoon();
  }, [isPaused, clearControlsTimer, hideControlsSoon]);

  // Global inactivity listener: ANY cursor movement anywhere in the window
  // shows the controls and restarts the 2.5s hide timer. A window-level
  // listener (instead of onMouseMove on the container) keeps working even when
  // the cursor hovers iframes/webviews or the HTML5 video itself, which swallow
  // local DOM mousemove events.
  useEffect(() => {
    window.addEventListener('mousemove', resetControlsTimeout);
    return () => window.removeEventListener('mousemove', resetControlsTimeout);
  }, [resetControlsTimeout]);

  // Seek relative
  const seekRelative = useCallback((seconds) => {
    const videoEl = videoRef.current;
    if (videoEl && videoEl.duration) {
      videoEl.currentTime = Math.max(0, Math.min(videoEl.duration - 0.1, videoEl.currentTime + seconds));
      resetControlsTimeout();
    }
  }, [resetControlsTimeout]);

// v1.0.88 — the single place a volume change is committed.
  // Writes BOTH the new global key and the legacy prefs blob, mirrors onto any
  // YouTube bridge element, and updates React state in one shot so the slider,
  // the OSD and the media element can never disagree.
  const commitVolume = useCallback((nextVol, opts) => {
    const options = opts || {};
    const v = clampVolume(nextVol);
    if (v === null) return;
    const shouldMute = options.muteWhenZero !== undefined
      ? !!options.muteWhenZero && v === 0
      : v === 0;
    const videoEl = videoRef.current;
    if (videoEl) {
      try {
        videoEl.volume = v;
        videoEl.muted = shouldMute;
      } catch (_e) {}
    }
    mirrorYt((mv) => {
      try { mv.volume = v; mv.muted = shouldMute; } catch (_e) {}
    });
    setVolume(v);
    setIsMuted(shouldMute);
    writeStoredVolume(v);
    writePref('defaultVolume', v);
  }, [mirrorYt]);

  // v1.0.88 — force the remembered volume onto a freshly attached <video>.
  // Called on metadata/canplay so a stream that boots at volume 1.0 (or that
  // Chromium restores from its own per-element cache) is corrected
  // immediately, for EVERY source type.
  const forceApplyStoredVolume = useCallback((el) => {
    const videoEl = el || videoRef.current;
    if (!videoEl) return;
    const stored = readStoredVolume();
    // An explicit per-session level (mini-player restore) outranks the global
    // preference, but it still has to reach the element.
    const target = (typeof video?.startVolume === 'number')
      ? clampVolume(video.startVolume)
      : (stored !== null ? stored : clampVolume(volume));
    if (target === null) return;
    try {
      videoEl.volume = target;
      videoEl.muted = target === 0;
    } catch (_e) {}
    mirrorYt((mv) => {
      try { mv.volume = target; mv.muted = target === 0; } catch (_e) {}
    });
    setVolume(target);
    setIsMuted(target === 0);
  }, [mirrorYt, volume, video]);

  // Adjust volume
  const adjustVolume = useCallback((delta) => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    commitVolume((typeof videoEl.volume === 'number' ? videoEl.volume : volume) + delta);
  }, [commitVolume, volume]);

  // Toggle play/pause
  // v1.0.71: ensure UI <-> media are in sync at attach time
  const syncPlayerWithAppState = useCallback(() => {
    let videoEl = videoRef.current;
    if (!videoEl) return;
    const ytLive = ytLiveElRef.current;
    if (ytLive && ytLive !== videoEl) {
      const liveAdv = (ytLive.currentTime || 0) > (videoEl.currentTime || 0) + 0.05;
      const liveHasDur = typeof ytLive.duration === 'number' && isFinite(ytLive.duration) && ytLive.duration > 0;
      const elHasDur = typeof videoEl.duration === 'number' && isFinite(videoEl.duration) && videoEl.duration > 0;
      if (liveAdv || (liveHasDur && !elHasDur) || ytLive.currentTime >= 0.5) {
        videoEl = ytLive;
      }
    }
    try {
      const activeSpeed = typeof playbackRate === 'number' && !isNaN(playbackRate) ? playbackRate : 1;
      // v1.0.88: prefer the remembered volume over a not-yet-applied element
      // default. Reading `videoEl.volume` here (as before) latched 1.0 on a fresh
      // element and then persisted it, permanently destroying the user's
      // choice.
      const remembered = (typeof video?.startVolume === 'number')
        ? clampVolume(video.startVolume)
        : (readStoredVolume() !== null ? readStoredVolume() : clampVolume(volume));
      const appliedVol = remembered !== null ? remembered : (videoEl.volume || 0);
      videoEl.volume = isMuted ? 0 : appliedVol;
      videoEl.muted = !!isMuted;
      videoEl.playbackRate = activeSpeed;
      setDuration(videoEl.duration || 0);
      setCurrentTime(videoEl.currentTime || 0);
      setIsPlaying(!videoEl.paused);
      setVolume(videoEl.muted ? 0 : videoEl.volume);
      setPlaybackRate(activeSpeed);
      mirrorYt((mv) => {
        try {
          mv.volume = videoEl.volume; mv.muted = videoEl.muted; mv.playbackRate = videoEl.playbackRate;
        } catch (_e) {}
      });
    } catch (_e) {}
  }, [isMuted, volume, playbackRate, mirrorYt, video]);

  // Single source of truth for play/pause.
  // `paused` is sampled ONCE, before the action is taken. The previous version
  // re-read videoEl.paused AFTER calling play()/pause(); play() is async, so
  // that read raced the promise and wrote the opposite value into isPlaying
  // (the button kept showing the play glyph mid-playback). onPlay/onPause are
  // still the authority that confirms this state once the element settles.
  const togglePlay = useCallback((e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const activeEl = getActiveMediaElement();
    if (!activeEl) return;

    if (activeEl.paused) {
      activeEl.play().catch(console.error);
    } else {
      activeEl.pause();
    }
  }, []);

  // v1.0.88 — POLLING FALLBACK for the timer / progress bar / duration.
  // For YouTube the actual playing element is a dynamically created freshVid
  // (stored in ytLiveElRef.current); when that element is advancing but the
  // React-bound <video> node is hidden/stuck, the UI never updates.
  useEffect(() => {
    const syncInterval = setInterval(() => {
      const activeEl = getActiveMediaElement();
      if (!activeEl) return;

      // 1. Force Volume Preset Retention
      const savedVol = parseFloat(localStorage.getItem('nekofal_user_volume') ?? '1.0');
      if (Math.abs(activeEl.volume - savedVol) > 0.01) {
        activeEl.volume = savedVol;
      }

      // 2. Sync Play/Pause Button Icon State
      const isCurrentlyPlaying = !activeEl.paused && !activeEl.ended && activeEl.readyState > 1;
      setIsPlaying(isCurrentlyPlaying);

      // 3. Sync Current Time & Duration
      if (activeEl.duration && !isNaN(activeEl.duration) && activeEl.duration > 0) {
        setDuration(activeEl.duration);
      }
      if (typeof activeEl.currentTime === 'number') {
        setCurrentTime(activeEl.currentTime);
      }
    }, 200);

    return () => clearInterval(syncInterval);
  }, []);

  // v1.0.88 — ONE debounced click handler for the whole player surface.
  // (Defined further down, right after `toggleFullscreen`, because it depends
  // on it and a dep array would otherwise read it inside its temporal dead
  // zone during the first render.)

  // Alias for the keyboard / media-key call sites.
  const togglePlayPause = togglePlay;

  // Container-level click: clicking the video or its letterbox toggles playback.
  // A click that ORIGINATED inside the custom control bar must be ignored here,
  // otherwise it also bubbles through this container and cancels out the
  // control's own onClick — a double toggle that made the play button a no-op.
  // v1.0.88: this is now folded into `handleSurfaceClick`, which debounces and
  // filters control-area clicks itself.


  // Pause guard: while paused, controls must stay visible regardless of mouse
  // activity — clear any pending hide timer and force them on.
  useEffect(() => {
    if (isPaused) {
      clearControlsTimer();
      setIsControlsVisible(true);
    }
  }, [isPaused, clearControlsTimer]);

  // Auto-hide shortly after playback starts (and any time the controls are
  // re-shown during playback without a click that armed the timer).
  useEffect(() => {
    if (!isPaused && !isLoading && !menuOpen && isControlsVisible && !controlsTimeoutRef.current) {
      hideControlsSoon();
    }
  }, [isPaused, isLoading, menuOpen, isControlsVisible, hideControlsSoon]);

  useEffect(() => () => {
    clearControlsTimer();
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
  }, [clearControlsTimer]);

  // ---------------- IPTV zapping (channel surfing) ----------------
  // The current channel index is mirrored into a ref so rapid ArrowUp/Down
  // presses during live TV don't race the async prop update from the parent.
  useEffect(() => {
    if (Number.isInteger(channelIndex)) channelIndexRef.current = channelIndex;
  }, [channelIndex]);

  // Cable-style On-Screen Display: channel number, logo, name and group,
  // shown for 3s whenever the channel changes.
  const showOsd = useCallback((ch, num) => {
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    setOsd({
      number: num,
      name: ch?.title || ch?.videoTitle || 'Channel',
      group: ch?.groupTitle || ch?.category || 'Live TV',
      logo: ch?.thumbnailUrl || ''
    });
    osdTimerRef.current = setTimeout(() => setOsd(null), 3000);
  }, []);

  const zap = useCallback((dir) => {
    if (!isZapping) return;
    const list = channelList;
    const idx = channelIndexRef.current;
    const next = idx + dir;
    if (next < 0 || next >= list.length) return;
    const ch = list[next];
    showOsd(ch, next + 1);
    setMenuOpen(null);
    resetControlsTimeout();
    if (onZapTo) onZapTo(ch, next);
  }, [isZapping, channelList, showOsd, onZapTo, resetControlsTimeout]);

  // ---- IPTV dead-stream watchdog (v1.0.57) ---------------------------------
  // A live channel that never reaches 'playing' (bad manifest, geo-block,
  // dead relay, server drop) is marked unavailable in the DB so the next
  // validation pass / shelf build skips it, then the player zaps forward or
  // closes. The mark is fire-once per channel id to avoid spamming the DB.
  const clearIptvWatch = useCallback(() => {
    if (iptvWatchRef.current) {
      clearTimeout(iptvWatchRef.current);
      iptvWatchRef.current = null;
    }
  }, []);

  const handleIptvUnavailable = useCallback((fromWatchdog) => {
    clearIptvWatch();
    const chId = video && (video.id || video.videoId);
    if (chId != null && !deadIptvMarkedRef.current.has(String(chId))) {
      deadIptvMarkedRef.current.add(String(chId));
      const api = window.api || window.electronAPI;
      api?.updateVideoAvailability?.([{ id: chId, isOnline: 0 }]).catch((err) => {
        console.warn('[VideoPlayer] updateVideoAvailability failed:', err && err.message ? err.message : err);
      });
    }
    setStreamUnavailable(true);
    setTimeout(() => setStreamUnavailable(false), 2600);
    if (osdTimerRef.current) clearTimeout(osdTimerRef.current);
    setOsd(null);
    if (isZapping && channelList && channelList.length > 0) {
      const idx = channelIndexRef.current;
      const next = idx + 1;
      if (next >= 0 && next < channelList.length) {
        zap(1);
        return;
      }
    }
    closePlayer();
  }, [video, isZapping, channelList, channelIndexRef, clearIptvWatch, zap, closePlayer]);

  // Latest-ref handles to the IPTV watchdog callbacks. The stream-init effect
  // below must NOT list these in its dependency array: their identities track
  // isPaused (via zap → resetControlsTimeout), so a pause click used to re-run
  // the effect, tear the stream down and restart it from 0s. Reading them via
  // refs keeps the effect keyed only on the real stream source (streamUrl).
  const clearIptvWatchRef = useRef(clearIptvWatch);
  clearIptvWatchRef.current = clearIptvWatch;
  const handleIptvUnavailableRef = useRef(handleIptvUnavailable);
  handleIptvUnavailableRef.current = handleIptvUnavailable;

  useEffect(() => {
    if (isZapping && channelList && channelList.length) {
      const idx = Math.min(Math.max(channelIndexRef.current, 0), channelList.length - 1);
      showOsd(channelList[idx], idx + 1);
    }
  }, []);

  // Toggle fullscreen (with state sync)
  const toggleFullscreen = useCallback(() => {
    const container = document.querySelector('.video-player-container');
    if (!container) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      }
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }, []);

// v1.0.88 — ONE debounced click handler for the whole player surface.
  // Previously the <video>, the container and the backdrop each owned their own
  // toggle handler, so one physical click could be counted two or three times
  // and cancel itself out. That is the reported "sometimes pauses, sometimes
  // needs several clicks, sometimes misses completely" flakiness.
  //
  // Single vs double is decided with the browser's NATIVE `dblclick` event, not
  // by counting clicks in a window. Counting clicks is fragile in exactly the
  // situation users hit: the first click reveals the control bar, so the second
  // click of the same gesture lands on the control overlay, is filtered as
  // "interactive", and leaves the pending single-click toggle armed — the video
  // then toggles AND never goes fullscreen. `dblclick` is dispatched on the
  // deepest common ancestor of the two clicks, so it still fires on the
  // container when the two clicks straddle the video and the control bar.
  const clickTimerRef = useRef(null);

  const isInteractiveTarget = (target) => {
    if (!target || typeof target.closest !== 'function') return false;
    return !!target.closest('.player-controls-overlay, .control-bar, .controls-row-inner, .progress-track, .volume-slider, .volume-overlay, .popup-menu, .osd-banner, .vp-toast, button, webview');
  };

  const clearPendingClick = () => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };

  const handleSurfaceClick = useCallback((e) => {
    // Halt propagation so an ancestor handler can never observe the same
    // physical click (that double-count was the original defect).
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();

    // ANY new click cancels a pending single-click toggle first. Without this,
    // a click that lands on a control right after a video click would leave the
    // old toggle armed and firing 250ms later.
    clearPendingClick();

    // Controls, menus, sliders, buttons and <webview> own their own clicks.
    if (isInteractiveTarget(e && e.target)) return;

    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePlay();
    }, CLICK_DEBOUNCE_MS);
  }, [togglePlay]);

  const handleSurfaceDoubleClick = useCallback((e) => {
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    clearPendingClick();
    // Double-clicking a control (e.g. a button) must not fullscreen.
    if (isInteractiveTarget(e && e.target)) return;
    toggleFullscreen();
  }, [toggleFullscreen]);

  // Drop a pending single-click toggle on unmount so play/pause can never fire
  // against an element that is being torn down.
  useEffect(() => clearPendingClick, []);


  // Sync fullscreen state from the browser
  useEffect(() => {
    const sync = () => {
      setIsFullscreen(!!(document.fullscreenElement || document.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    window.addEventListener('resize', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
      window.removeEventListener('resize', sync);
    };
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const nextMuted = !videoEl.muted;
    videoEl.muted = nextMuted;
    setIsMuted(nextMuted);
    // Un-muting from a 0 level used to hard-reset to 1.0 and persist that,
    // silently discarding the user's remembered level.
    if (!nextMuted && videoEl.volume === 0) commitVolume(1);
    else if (nextMuted) {
      // Keep the level, remember that we are muted.
      writeStoredVolume(videoEl.volume);
      writePref('defaultVolume', videoEl.volume);
    }
    mirrorYt((v) => { try { v.muted = videoEl.muted; v.volume = videoEl.volume; } catch (_e) {} });
  }, [mirrorYt, commitVolume]);

  // Volume change from slider
  const handleVolumeChange = useCallback((e) => {
    const newVol = parseFloat(e && e.target ? e.target.value : NaN);
    if (isNaN(newVol)) return;
    commitVolume(newVol);
  }, [commitVolume]);

  // Volume overlay: keep open while moving into the slider, then close 300ms
  // after the cursor leaves both the button and the slider.
  const openVolume = useCallback(() => {
    if (volumeHoverTimer.current) clearTimeout(volumeHoverTimer.current);
    setVolumeOpen(true);
  }, []);

  const scheduleCloseVolume = useCallback(() => {
    if (volumeHoverTimer.current) clearTimeout(volumeHoverTimer.current);
    volumeHoverTimer.current = setTimeout(() => setVolumeOpen(false), 300);
  }, []);

  useEffect(() => () => {
    if (volumeHoverTimer.current) clearTimeout(volumeHoverTimer.current);
  }, []);

  // Progress bar click to seek
  const handleProgressClick = useCallback((e) => {
    const videoEl = videoRef.current;
    if (videoEl && videoEl.duration && progressRef.current) {
      const rect = progressRef.current.getBoundingClientRect();
      const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const t = percent * videoEl.duration;
      videoEl.currentTime = t;
      mirrorYt((v) => { try { v.currentTime = t; } catch (_e) {} });
      setCurrentTime(t);
    }
  }, [mirrorYt]);

  // Switch the active yt-dlp stream to a specific format (non-HLS videos) by
  // re-extracting that exact format from the source page. Accepts a format_id
  // (exact format) or a { height } resolution cap (standard-quality fallback).
  const switchYtQuality = useCallback(async (level) => {
    if (!level || (!level.formatId && !level.height)) return;
    const api = window.api || window.electronAPI;
    const videoEl = videoRef.current;
    const pos = videoEl ? videoEl.currentTime || 0 : 0;
    const wasPlaying = videoEl && !videoEl.paused;

    try {
      setIsLoading(true);
      setIsExtracting(true);
      setStreamError(null);
      setHasError(false);
      const opts = level.formatId ? { formatId: level.formatId } : { height: level.height };
      const res = await api.extractStream(sourceUrlRef.current || video.videoUrl, opts);
      if (res?.success && res.data?.videoUrl) {
        pendingSeekRef.current = pos;
        const proxied = getProxiedUrl(res.data.videoUrl, res.data.httpHeaders || null);
        setStreamUrl(proxied);
        // Refresh the direct-format menu with whatever tiers the re-extraction
        // returned so switching again is instant (no second yt-dlp round trip).
        if (Array.isArray(res.data.formats) && res.data.formats.length) {
          setDirectFormats(res.data.formats.map((f) => ({ ...f })));
        }
        setSelectedQuality(level.label);
      } else {
        setSelectedQuality('auto');
      }
    } catch (err) {
      console.warn('[VideoPlayer] Quality switch failed:', err.message);
      setSelectedQuality('auto');
    } finally {
      setIsLoading(false);
      setIsExtracting(false);
    }
  }, [video, getProxiedUrl]);

  // v1.0.61: switch an HLS stream to an EXTRACTOR-ENUMERATED variant
  // sub-playlist (hanime quality tiers). Since the variant is itself HLS, it
  // re-enters through hls.js (plays a single-level media playlist natively
  // well) — native <video> cannot play .m3u8, so we can't reuse the direct
  // format hot-swap for these. Position is preserved via pendingSeekRef.
  // Declared BEFORE switchDirectFormat (which routes HLS-tier rows through it).
  const applyVariantLevel = useCallback((item) => {
    if (!item || !item.url) return;
    const videoEl = videoRef.current;
    const pos = videoEl ? videoEl.currentTime || 0 : 0;
    // v1.0.63: remember the user's play/pause state across the source swap
    // (consumed + reset by the next init effect run).
    pendingPlayRef.current = videoEl ? videoEl.paused : false;
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    streamHlsRef.current = true;
    // Preserve an outstanding resume seek (first manifold parse before
    // playback) — fall back to the live position when already playing.
    pendingSeekRef.current = pendingSeekRef.current || pos;
    setStreamUrl(getProxiedUrl(item.url, activeHttpHeadersRef.current));
    setSelectedQuality(item.label || qualityLabel(item.height) || 'Auto');
  }, [getProxiedUrl]);

  // Instant format hot-swap: point <video> straight at the chosen format's URL
  // (no re-extraction). The stream-URL state change re-initializes the media
  // element through the standard pipeline, which resumes at the saved position.
  const switchDirectFormat = useCallback((fmt) => {
    if (!fmt || !fmt.url) return;
    // v1.0.66: an HLS URL (a YT per-tier roster row, or a variant sub-playlist)
    // MUST go back through hls.js — a raw .m3u8 handed to native <video> is
    // unplayable on Chromium. Route those through the variant engine, which
    // preserves position + play/pause state across the swap.
    if (typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported()
        && /\.m3u8|\.m3u|\/hls\/|api\/manifest/i.test(fmt.url)) {
      applyVariantLevel(fmt);
      return;
    }
    const videoEl = videoRef.current;
    const pos = videoEl ? videoEl.currentTime || 0 : 0;
    // v1.0.67: pin play/pause intent explicitly (same contract as
    // applyVariantLevel). The re-init effect then restores the position AND
    // resumes/stays-paused deterministically — quality buttons never yank a
    // paused user into playback mid-source-swap.
    pendingPlayRef.current = videoEl ? videoEl.paused : false;
    // Convert off the HLS engine for this stream so playback re-enters via the
    // native path with the raw URL (the re-init effect reads this ref).
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    streamHlsRef.current = false;
    pendingSeekRef.current = pos;
    const proxied = getProxiedUrl(fmt.url, fmt.httpHeaders || null);
    setStreamUrl(proxied);
    setSelectedQuality(fmt.label || qualityLabel(fmt.height) || 'Auto');
  }, [getProxiedUrl, applyVariantLevel]);

  // Quality selection (HLS levels → enumerated variants → direct formats →
  // yt-dlp re-extraction)
  const handleQualityChange = useCallback(async (val) => {
    const hls = hlsRef.current;
    // 0) v1.0.61: enumerated variant URL (hanime). hls.js can't
    //    currentLevel-switch a degenerate/single-level master capture, so
    //    point the whole pipeline at the chosen variant sub-playlist.
    if (typeof val === 'number') {
      const item = qualityLevels[val] || null;
      if (item && item.url && /(\.m3u8|\.m3u|\/hls\/)/i.test(item.url)) {
        setSelectedQuality(item.label || 'Auto');
        const pref = item.height || item.label;
        if (pref) writePref('preferredQuality', pref);
        await applyVariantLevel(item);
        return;
      }
    }
    // 1) HLS path (master .m3u8 in hls.js): switch levels in-place.
    if (hls && hls.levels && hls.levels.length) {
      setSelectedQuality(val);
      if (typeof val === 'number') {
        writePref('preferredQuality', val);
      } else {
        const prefs = readPrefs();
        delete prefs.preferredQuality;
        localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      }
      hls.currentLevel = typeof val === 'number' ? val : -1;
      return;
    }
    // 2/3) Non-HLS: direct-URL format swap first, yt-dlp re-extraction fallback.
    if (typeof val === 'number') {
      const fmt = directFormats[val] || qualityLevels[val] || QUALITY_FALLBACKS[val];
      if (fmt) {
        if (fmt.url) {
          await switchDirectFormat(fmt);
          return;
        }
        if (fmt.formatId || fmt.height) {
          await switchYtQuality(fmt);
          return;
        }
      }
    }
    setSelectedQuality(val);
  }, [directFormats, qualityLevels, switchDirectFormat, switchYtQuality, applyVariantLevel]);

  // Playback speed selection
  const handleRateChange = useCallback((rate) => {
    setPlaybackRate(rate);
    writePref('defaultRate', rate);
    const videoEl = videoRef.current;
    if (videoEl) {
      videoEl.playbackRate = rate;
      mirrorYt((v) => { try { v.playbackRate = rate; } catch (_e) {} });
    }
    if (hlsRef.current && hlsRef.current.media) {
      try { hlsRef.current.media.playbackRate = rate; } catch (_e) {}
    }
  }, [mirrorYt]);

  // Start a native yt-dlp download (progress shows in the Downloads drawer)
  const handleDownload = useCallback(async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const api = window.api || window.electronAPI;
    if (!api?.downloadVideo || isDownloading) return;
    setIsDownloading(true);
    setDownloadStarted(false);
    try {
      const name = video?.videoTitle || video?.title || 'video';
      const result = await api.downloadVideo({
        url: video.videoUrl || video.url,
        title: name,
        suggestedFilename: `${name.replace(/[^\w\- ]+/g, '').trim() || 'video'}.mp4`
      });
      if (result?.success) setDownloadStarted(true);
    } catch (err) {
      console.error('[VideoPlayer] Download failed:', err);
    } finally {
      setIsDownloading(false);
    }
  }, [video, isDownloading]);

  // ---------- Floating mini-player (PiP) ----------
  const handleFloatToMini = useCallback(async () => {
    const videoEl = videoRef.current;
    const api = window.api || window.electronAPI;
    const payload = {
      mode: 'video',
      title: video?.videoTitle || video?.title || 'Nekofal Mini Player',
      streamUrl: streamUrl || video?.videoUrl || '',
      streamHls: !!(streamHlsRef.current || video?.isHLS),
      poster: video?.thumbnailUrl || '',
      currentTime: videoEl ? videoEl.currentTime || 0 : 0,
      volume: videoEl ? videoEl.volume : (readPrefs().defaultVolume ?? 1),
      muted: videoEl ? videoEl.muted : false,
      videoId: video?.id ?? null,
      isLocal: !!video?.isLocal
    };
    const res = await api?.openMiniPlayer?.(payload);
    if (res?.success) closePlayer();
  }, [video, streamUrl, closePlayer]);

  // OS media commands (play/pause/seek) forwarded from navigator.mediaSession.
  // Channel zapping takes over next/prev while live; otherwise they seek.
  useEffect(() => {
    const onCommand = (e) => {
      const videoEl = videoRef.current;
      const detail = (e && e.detail) || {};
      if (!videoEl) return;
      switch (detail.command) {
        case 'play':
          videoEl.play().catch(() => {});
          break;
        case 'pause':
          videoEl.pause();
          break;
        case 'seekto':
          if (typeof detail.seekTime === 'number' && videoEl.duration) {
            videoEl.currentTime = Math.max(0, Math.min(detail.seekTime, videoEl.duration));
          }
          break;
        case 'previous':
          if (isZapping) zap(-1);
          else seekRelative(-10);
          break;
        case 'next':
          if (isZapping) zap(1);
          else seekRelative(10);
          break;
        default:
          break;
      }
    };
    window.addEventListener('nek-media-command', onCommand);
    return () => window.removeEventListener('nek-media-command', onCommand);
  }, [isZapping, zap, seekRelative]);

  // Auto-mini float requested by the main process (window minimized during
  // playback) — reuse the manual Float-To-Mini handler, which closes this
  // player once the mini window is playing (no double audio).
  useEffect(() => {
    const onFloat = () => { handleFloatToMini(); };
    window.addEventListener('nek-float-to-mini', onFloat);
    return () => window.removeEventListener('nek-float-to-mini', onFloat);
  }, [handleFloatToMini]);

  // ---------- Quality quick presets (dynamic from HLS/yt-dlp levels) ----------
  // The active engine: hls.js levels when a master manifest is in charge,
  // otherwise the extraction's direct-URL format list.
  const engineItems = qualityLevels.length > 0 ? qualityLevels : directFormats;
  // Unique resolved heights from the active engine, sorted high→low.
  const availableQualityHeights = Array.from(
    new Set(engineItems.map((l) => l.height).filter((h) => h > 0))
  ).sort((a, b) => b - a);
  const hasQualityLevels = availableQualityHeights.length > 0;

  // Stream identity for the quality affordance: a YouTube watch page or an
  // already-direct media file always has quality options even before (or when)
  // extraction yields no explicit format list.
  const rawSource = String(video?.pageUrl || video?.webUrl || video?.videoUrl || video?.url || video?.streamUrl || '');
  const isYouTube = isYouTubeUrl(rawSource);

  // v1.0.64: the Quality button is ALWAYS rendered while a video stream is
  // loaded (never hidden by missing quality data). The menu populates by
  // priority:
  //   1) engine rows — extractor `qualities`, hls.js `MANIFEST_PARSED`
  //      levels mapped to '1080p/720p/...', or direct-URL formats
  //   2) YouTube re-extract standard tiers (switching re-extracts there)
  //   3) single "Auto (Source Default)" option — the menu is never empty.
  const streamActive = !!streamUrl && !hasError;
  // v1.0.66: the dropdown renders the deduplicated list (one label per
  // resolution, sorted 1080p→360p) — each row carries the ORIGINAL engine
  // index (_engineIndex) so clicking a menu entry routes straight to the right
  // hls.js level / direct format without an off-by-one from the dedup.
  const qualityRows = dedupeQualityRows(
    engineItems.length > 0 ? engineItems : (isYouTube ? QUALITY_FALLBACKS : [])
  );
  const qualityResolutionLabels = qualityRows.map((l) =>
    (l && (l.label || (l.height ? `${l.height}p` : ''))) || ''
  );
  const hasMultipleResolutions = new Set(qualityResolutionLabels).size >= 2;
  const qualityMenuItems = hasMultipleResolutions ? qualityRows : [];
  const qualityHasFallbackOnly = qualityMenuItems.length === 0;

  // Map a chosen chip height to the ACTIVE engine's item index (HLS levels or
  // direct formats) and route through the shared quality handler.
  const handlePresetChange = useCallback((preset) => {
    if (preset === 'auto') {
      handleQualityChange('auto');
      return;
    }
    const items = engineItems;
    const hit = items.findIndex((l) => (l.height || 0) === preset);
    if (hit !== -1) {
      handleQualityChange(hit);
    } else {
      setSelectedQuality(preset);
    }
  }, [engineItems, handleQualityChange]);

  // Resolved height of the currently selected item (for chip active state).
  const currentQualityHeight = useCallback(() => {
    if (selectedQuality === 'auto') return null;
    if (typeof selectedQuality === 'number') {
      const lvl = engineItems[selectedQuality];
      return lvl ? lvl.height : null;
    }
    // String selection (e.g. a yt-dlp format label): resolve to its height.
    const lvl = engineItems.find((l) => String(l.label) === String(selectedQuality));
    return lvl ? (lvl.height || null) : null;
  }, [selectedQuality, engineItems]);

  // Label shown on the quality trigger button.
  const qualityTriggerLabel = useCallback(() => {
    if (selectedQuality === 'auto') return 'Auto';
    if (typeof selectedQuality === 'number') {
      const lvl = engineItems[selectedQuality];
      return (lvl && (lvl.label || qualityLabel(lvl.height))) || `Quality ${selectedQuality + 1}`;
    }
    return selectedQuality;
  }, [selectedQuality, engineItems]);

  // ---------- Hardware media-key bindings ----------
  useEffect(() => {
    bindMediaKey('playpause', () => togglePlayPause());
    bindMediaKey('stop', () => closePlayer());
    bindMediaKey('next', () => seekRelative(10));
    bindMediaKey('previous', () => seekRelative(-10));
    return () => {
      unbindMediaKey('playpause');
      unbindMediaKey('stop');
      unbindMediaKey('next');
      unbindMediaKey('previous');
    };
  });

  // v1.0.68: the init effect must NOT re-run (and destroy the in-flight hls
  // instance) when quality enrichment or the variant callback identity changes.
  // The handlers read these through refs; the effect deps stay stable-once.
  const extractQualityLevelsRef = useRef(extractQualityLevels);
  const applyVariantLevelRef = useRef(applyVariantLevel);
  useEffect(() => { extractQualityLevelsRef.current = extractQualityLevels; }, [extractQualityLevels]);
  useEffect(() => { applyVariantLevelRef.current = applyVariantLevel; });

  // Retry extraction
  const handleRetry = useCallback(() => {
    setHasError(false);
    setStreamError(null);
    loadStream();
  }, []);

  // Retry a playing source after a temporary network blip. Uses exponential
  // backoff, resets on manifest/play success, and gives up after
  // MAX_PLAYBACK_RETRIES attempts (then the caller surfaces the raw error).
  const scheduleRetry = useCallback((source, kind) => {
    if (networkRetryRef.current >= MAX_PLAYBACK_RETRIES) return false;
    const attempt = networkRetryRef.current + 1;
    networkRetryRef.current = attempt;
    const delay = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
    console.warn(`[VideoPlayer] ${kind} network blip, retry ${attempt}/${MAX_PLAYBACK_RETRIES} in ${delay}ms`);
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null;
      if (kind === 'hls' && hlsRef.current) {
        try { hlsRef.current.startLoad(); } catch {}
        return;
      }
      const videoEl = videoRef.current;
      if (!videoEl) return;
      const pos = videoEl.currentTime || 0;
      const src = videoEl.currentSrc || videoEl.src || streamUrlRef.current || source;
      videoEl.src = src;
      if (pos > 0) { try { videoEl.currentTime = pos; } catch {} }
      videoEl.play().catch(() => {});
    }, delay);
    return true;
  }, []);

  // Format time
  const formatTime = useCallback((seconds) => {
    if (!seconds || isNaN(seconds)) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }, []);

  // Main stream loading function with timeout
  const loadStream = useCallback(async () => {
    if (!video) return;

    setIsLoading(true);
    setIsExtracting(true);
    setStreamError(null);
    setHasError(false);
    setIsDRM(false);
    setDrmWebUrl(null);
    setQualityLevels([]);
    setExtractQualityLevels([]);
    setSelectedQuality('auto');
    setDirectFormats(Array.isArray(video.formats) && video.formats.length ? video.formats.map((f) => ({ ...f })) : []);
    streamHlsRef.current = false;
    sourceUrlRef.current = video.pageUrl || video.webUrl || video.videoUrl || video.url;
    networkRetryRef.current = 0;
    stallCountRef.current = 0;
    activeHttpHeadersRef.current = video.httpHeaders || null;
    variantAppliedRef.current = null;

    // Remember where to jump once metadata is ready
    const saved = Number(video.lastPosition) || 0;
    pendingSeekRef.current = saved;

    try {
      const api = window.api || window.electronAPI;
      
      // Canonical extraction source: a saved item carries a page URL (pageUrl)
      // that outlives rotating CDN streams; direct media uses the stream itself.
      let streamUrl = video.pageUrl || video.webUrl || video.videoUrl;
      let httpHeaders = video.httpHeaders || null;
      let isHLS = video.isHLS || false;
      originStreamUrlRef.current = streamUrl;

      // Network stream sniffer fallback: when normal extraction fails, drive
      // the source page in the stealth browser and capture the media requests
      // it issues (.m3u8/.mp4/iframe embeds) instead of showing an error.
      const trySniffFallback = async (watchMs = 9000) => {
        if (!api?.sniffStreams) return null;
        let sniff = null;
        try {
          sniff = await withTimeout(
            api.sniffStreams(streamUrl, watchMs),
            watchMs + 4000,
            new Error('Stream sniff timed out')
          );
        } catch (sniffErr) {
          console.warn('[VideoPlayer] Stream sniff failed:', sniffErr.message || sniffErr);
          return null;
        }
        const streams = sniff && Array.isArray(sniff.streams) ? sniff.streams : [];
        if (!streams.length) return null;
        const best = pickBestStream(streams);
        return best || streams[0] || null;
      };
      
      // Check if this is a direct stream (IPTV, direct M3U8, SRT, etc.) that should NOT go through yt-dlp
      const isIPTV = video.sourceSite === 'IPTV' || video.type === 'Web TV';
      const isDirectStream = /\.(mp4|webm|m3u8|ts)(\?|$)/i.test(streamUrl) 
        || streamUrl.startsWith('srt://')
        || streamUrl.startsWith('rtmp://')
        || streamUrl.startsWith('rtsp://')
        || (streamUrl.startsWith('http') && isIPTV);
      
      // If it's a web page URL (not a direct video file/stream), extract stream with timeout
      if (!isDirectStream && api?.extractStream) {
        console.log('[VideoPlayer] Extracting stream for:', streamUrl);
        
        try {
          const extractionTimeLimit = /hanime\.tv/i.test(streamUrl)
            ? STEALTH_EXTRACTION_TIMEOUT_MS
            : EXTRACTION_TIMEOUT_MS;
          const result = await withTimeout(
            api.extractStream(streamUrl),
            extractionTimeLimit,
            new Error('Extraction timed out')
          );
          
          // Normalize the two possible success shapes:
          //  - { success, data: { videoUrl, httpHeaders, isHLS, qualityLevels, ... } }
          //  - { success, streamUrl, isHls }  (main's direct-media fast path)
          const extraction = result && result.success && (result.data?.videoUrl || result.streamUrl)
            ? (result.data?.videoUrl ? result.data : { videoUrl: result.streamUrl, isHLS: !!result.isHls, httpHeaders: result.httpHeaders || null, qualityLevels: [] })
            : null;

          if (extraction && extraction.videoUrl) {
            // Validate the returned stream URL is a direct media stream
            const extractedUrl = extraction.videoUrl;
            const isValidMedia = /\.(mp4|webm|m3u8|ts|m4s|mkv|m4v|mov|avi)(\?|$)/i.test(extractedUrl) 
              || extractedUrl.includes('googlevideo.com') 
              || extractedUrl.includes('videoplayback')
              || /\/hls\//i.test(extractedUrl)
              || extraction.isHLS
              || (extractedUrl.startsWith('http://localhost:') && extractedUrl.includes('/video/proxy/stream'));
            
            if (!isValidMedia) {
              console.warn('[VideoPlayer] Invalid media stream URL returned:', extractedUrl);
              setHasError(true);
              setStreamError('Invalid or unplayable media source');
              return;
            }
            
            streamUrl = extractedUrl;
            httpHeaders = extraction.httpHeaders || null;
            isHLS = extraction.isHLS || false;
            streamHlsRef.current = !!extraction.isHLS;
            activeHttpHeadersRef.current = httpHeaders;
            originStreamUrlRef.current = extractedUrl;

            // yt-dlp direct-URL format list (non-HLS quality switching)
            if (Array.isArray(extraction.formats)) {
              setDirectFormats(extraction.formats.map((f) => ({ ...f })));
            }

            // yt-dlp non-HLS quality options (format switching)
            if (Array.isArray(extraction.qualityLevels)) {
              if (extraction.qualityLevels.length > 0) {
                setQualityLevels(extraction.qualityLevels);
                setSelectedQuality(extraction.selectedQuality || extraction.qualityLevels[0].label);
              }
              // v1.0.61: keep EXTRACTOR-ENUMERATED HLS variants separately —
              // a tokenized hanime master collapses in hls.js to one level,
              // but these URLs back real resolution rows in the dropdown.
              const variants = extraction.qualityLevels
                .filter((q) => q && q.url && /(\.m3u8|\.m3u|\/hls\/)/i.test(q.url) && (q.height || q.label));
              if (variants.length > 0) setExtractQualityLevels(variants);
            }

            // v1.0.63: extractor-provided structured per-quality URLs
            // ({ qualities: [{ label: '1080p', url: '...' }] }). Adult sources
            // hand over direct variant playlists, so populate the dropdown
            // straight from this list — no dependence on hls.js parsing.
            if (Array.isArray(extraction.qualities) && extraction.qualities.length >= 2) {
              // v1.0.65: accept both HLS variant sub-playlists (.m3u8 / /hls/)
              // and direct progressive MP4/WebM tiers — the inline-player
              // parsers (XVideos/XNXX/PH mediaDefinitions) hand over clean mp4
              // ladders that the MP4 path hot-swaps via switchDirectFormat.
              const hlsQualities = extraction.qualities
                .filter((q) => q && q.url && /(\.m3u8|\.m3u|\/hls\/|\.mp4|\.webm)/i.test(q.url) && (q.height || q.label));
              if (hlsQualities.length >= 2) {
                setExtractQualityLevels(hlsQualities);
                setQualityLevels(hlsQualities);
                setSelectedQuality(extraction.selectedQuality || hlsQualities[hlsQualities.length - 1].label);
              }
            }
          } else if (result && result.error === 'DRM_PROTECTED') {
            console.log('[VideoPlayer] DRM protected content detected, using webview fallback');
            setIsDRM(true);
            setDrmWebUrl(result.webUrl || streamUrl);
            setIsLoading(false);
            setIsExtracting(false);
            return;
          } else {
            // Dump the full response so the real cause is visible in the console
            console.warn('[VideoPlayer] Stream extraction failed. Full response:', JSON.stringify(result || null).slice(0, 1000));
            const errDetail = (result && (result.details || result.error || result.message)) || 'extraction returned no playable URL';
            // If the original URL is not a direct media file, don't feed the
            // web page HTML to <video> (that's what produces the misleading
            // "code 4" format error). Surface the real extraction reason instead.
            if (!isDirectStream) {
              // Last resort: drive the page in the stealth browser and sniff
              // the .m3u8/.mp4 network requests it makes.
              const sniffed = await trySniffFallback();
              if (sniffed) {
                streamUrl = sniffed;
                isHLS = /m3u8|hls_variant|\/api\/manifest\//i.test(streamUrl);
                streamHlsRef.current = isHLS;
                httpHeaders = null;
                activeHttpHeadersRef.current = null;
                originStreamUrlRef.current = sniffed;
                console.log('[VideoPlayer] Sniff fallback adopted stream:', streamUrl);
              } else {
                setStreamError(`Stream extraction failed: ${errDetail}`);
                setHasError(true);
                return;
              }
            }
            // Fall through to try original URL (may be a direct media file)
          }
        } catch (extractErr) {
          console.warn('[VideoPlayer] Stream extraction error (timeout/failed):', extractErr);
          if (!isDirectStream) {
            const sniffed = await trySniffFallback();
            if (sniffed) {
              streamUrl = sniffed;
              isHLS = /m3u8|hls_variant|\/api\/manifest\//i.test(streamUrl);
              streamHlsRef.current = isHLS;
              httpHeaders = null;
              activeHttpHeadersRef.current = null;
              originStreamUrlRef.current = sniffed;
              console.log('[VideoPlayer] Sniff fallback adopted stream:', streamUrl);
            } else {
              setStreamError(`Stream extraction failed: ${extractErr.message || 'timed out'}`);
              setHasError(true);
              return;
            }
          }
          // Fall through to try original URL
        }
      }

      // Proxy the stream URL through local video server with httpHeaders
      const proxiedUrl = getProxiedUrl(streamUrl, httpHeaders);
      setStreamUrl(proxiedUrl);
    } catch (err) {
      console.error('[VideoPlayer] Failed to load stream:', err);
      setStreamError(err.message || 'Failed to load video stream');
      setHasError(true);
    } finally {
      setIsLoading(false);
      setIsExtracting(false);
    }
  }, [video, getProxiedUrl, withTimeout]);

  // Load stream on mount/video change
  useEffect(() => {
    loadStream();
  }, [loadStream]);

  // Initialize HLS.js or native video (only for non-DRM content)
  useEffect(() => {
    if (isDRM || !streamUrl) return;

    // Electron IPC bridge for this effect. The YouTube manifest-refusal
    // re-extraction path below calls api.extractStream, but `api` was only ever
    // declared inside loadStream's try block — so that path threw
    // "ReferenceError: api is not defined" whenever YT refused a manifest.
    const api = (typeof window !== 'undefined') ? (window.api || window.electronAPI) : null;

    // v1.0.68: a re-run of this effect (quality-enrichment, level-menu rebuild)
    // with the SAME streamUrl MUST NOT tear down an already-working hls.js
    // instance. Every restart destroys the in-flight manifest XHR and burns
    // YT's burst budget — the exact mechanism behind the freeze-at-0:00.
    streamUrlRef.current = streamUrl;
    const isYtEarly = video.sourceSite === 'YouTube' || /googlevideo\.com|youtube\.com|youtu\.be/i.test(String(streamUrl));
    // v1.0.68: room-scoped timers must live at effect scope — the cleanup below
    // (and only it) touches them, and block-scoped lets throw ReferenceError on
    // unmount, blowing up the ErrorBoundary for the whole app.
    let ytPlayKickTimer = null;
    let hlsKickTimer = null;
    console.warn('[yteffect] run @' + performance.now().toFixed(0) + ' hls?=' + !!hlsRef.current + ' parsed?=' + (ytParsedRef.current ? 1 : 0) + ' kick?=' + !!window.__lastKick + ' src=' + String(streamUrl).slice(0, 42));
    if (isYtEarly && hlsRef.current && ytParsedRef.current && (streamUrlRef.current || '') === streamUrl) {
      return;
    }
    // v1.0.68: an effect re-run within ~2s of the pilot kick is what ABORTS the
    // in-flight manifest XHR (status-0) and freezes the playhead. Once a pilot
    // is running for this URL, leave it alone until it proves dead.
    if (isYtEarly && hlsRef.current && !ytParsedRef.current && window.__lastKick
        && (Number(window.__lastKick) + 2000) > performance.now()
        && (streamUrlRef.current || '') === streamUrl) {
      return;
    }
    if (isYtEarly && hlsRef.current && !ytParsedRef.current) {
      try { hlsRef.current.destroy(); } catch (_e) {}
      hlsRef.current = null;
    }
    
    const videoEl = videoRef.current;
    if (!videoEl) return;

    // Check original video URL for HLS (proxy URL won't have .m3u8)
    const looksHls = streamHlsRef.current || video.isHLS ||
      (typeof video.videoUrl === 'string' && (video.videoUrl.includes('m3u8') || video.videoUrl.includes('hls_variant') || video.videoUrl.includes('/api/manifest/'))) ||
      (typeof streamUrl === 'string' && (streamUrl.includes('m3u8') || streamUrl.includes('hls_variant') || streamUrl.includes('/api/manifest/')));
    // IPTV / Web TV channels are practically always HLS, even when the source
    // URL doesn't advertise .m3u8 — force hls.js, then fall back to native if
    // the manifest turns out to be invalid.
    const forceHls = video.sourceSite === 'IPTV' || video.type === 'Web TV';

    // v1.0.63: quality-switch reloads flag a paused user via pendingPlayRef
    // (applyVariantLevel). On re-inits of an already-loaded <video> (the
    // quality-enrichment reload, retries, etc.) derive it from the CURRENT
    // paused state so mid-session reloads never yank the user back to play.
    if (pendingPlayRef.current === null && videoEl.currentSrc) {
      pendingPlayRef.current = videoEl.paused;
    }
    const autoPlayOnReady = pendingPlayRef.current !== false;
    pendingPlayRef.current = null;

    // Apply persisted volume / playback rate defaults once the stream is ready
    const prefs = readPrefs();
    if (typeof prefs.defaultVolume === 'number') {
      videoEl.volume = Math.max(0, Math.min(1, prefs.defaultVolume));
      setVolume(videoEl.volume);
      setIsMuted(videoEl.volume === 0);
    }
    if (typeof prefs.defaultRate === 'number' && prefs.defaultRate > 0 && prefs.defaultRate <= 3) {
      videoEl.playbackRate = prefs.defaultRate;
    }

    // Network blip watchdog: repeated 'stalled' with no hls.js in charge means
    // the native source froze mid-download - reload it with backoff.
    const handleStalled = () => {
      if (hlsRef.current || videoEl.networkState !== 2) return;
      stallCountRef.current += 1;
      if (stallCountRef.current >= 3) {
        stallCountRef.current = 0;
        scheduleRetry(streamUrlRef.current || streamUrl, 'native');
      }
    };
    const handlePlaying = () => {
      stallCountRef.current = 0;
      networkRetryRef.current = 0;
      clearIptvWatchRef.current();
    };
    videoEl.addEventListener('stalled', handleStalled);
    videoEl.addEventListener('playing', handlePlaying);

    // ---- IPTV/Web TV dead-stream watchdog (v1.0.57) -------------------------
    // Live channels must start actual playback within IPTV_WATCHTIMEOUT_MS of
    // load. Firing means a silent hang (no manifest, dead relay, geo-block);
    // mark the channel dead + skip/close exactly like an explicit error would.
    const isIptvLike = video.sourceSite === 'IPTV' || video.type === 'Web TV';
    if (isIptvLike || isZapping) {
      clearIptvWatchRef.current();
      iptvWatchRef.current = setTimeout(() => {
        iptvWatchRef.current = null;
        handleIptvUnavailableRef.current(true);
      }, IPTV_WATCHTIMEOUT_MS);
    }

    const playNative = (includeFallbackSeek) => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      videoEl.src = streamUrl;
        videoEl.addEventListener('loadedmetadata', () => {
          if (includeFallbackSeek) seekToResume(videoEl);
          else if (pendingSeekRef.current) {
            const pos = pendingSeekRef.current;
            pendingSeekRef.current = null;
            if (shouldResume(pos)) {
              try { videoEl.currentTime = pos; mirrorYt((v)=>{try{v.currentTime=pos;}catch(_e){}}); } catch (e) {}
            }
          }
          if (autoPlayOnReady) { videoEl.play().catch(() => {}); mirrorYt((v)=>v.play().catch(()=>{})); }
          try { syncPlayerWithAppState(); } catch (_e) {}
        }, { once: true });
    };

    if ((looksHls || forceHls) && Hls.isSupported()) {
      // Use HLS.js for HLS streams. v1.0.63: xhrSetup stamps the origin
      // Referer on every manifest/segment request from hls.js (the UA/Origin/
      // Cookie side is applied globally in main via webRequest.onBeforeSendHeaders,
      // and Chromium forbids scripts from setting those headers).
      // v1.0.68 YT freeze: the ONLY code path proven to PLAY in-window is the
      // harness hlsPlay (hls.js dist import, worker:false, ll:false,
      // bufferLength:30, maxBufferLength:60, capLevelToPlayerSize:false,
      // attachMedia FIRST, then loadSource, then play() in MANIFEST_PARSED,
      // on a FRESH element). Replicate it byte-for-byte.
      const hlsIsYt = video.sourceSite === 'YouTube' || /googlevideo\.com|youtube\.com|youtu\.be/i.test(String(streamUrl));
      // v1.0.68: use the LIVE hls.mjs class for the YT pipeline (see boot above).
      const HlsC = (hlsIsYt && LIVE_HLS_CLS) ? LIVE_HLS_CLS : Hls;
      const hlsEvents = HlsC.Events || Hls.Events;
      const hls = new HlsC({
        debug: true,
        enableWorker: hlsIsYt,
        lowLatencyMode: hlsIsYt,
        bufferLength: 30,
        maxBufferLength: 60,
        xhrSetup: (xhr, _url) => {
          try {
            const headers = activeHttpHeadersRef.current;
            if (headers) {
              const ref = headers.Referer || headers.referer;
              if (ref) {
                try { xhr.setRequestHeader('Referer', String(ref)); }
                catch (_e) { console.warn('[xhsetup] setRequestHeader threw: ' + String(_e)); }
              }
            }
          } catch (_e) { console.warn('[xhsetup] headers read threw: ' + String(_e)); }
        }
      });
      
      hlsRef.current = hls;
      // v1.0.68 YT freeze fix: YT HLS masters are separate demuxed audio/video
      // playlists. The v1.0.66 attach-then-play can swallow the first play()
      // before fragment data is buffered and leave the element paused forever
      // (freeze at 0:00). We keep a stall watchdog that re-issues play() only
      // after real no-progress time (slow software decoders must never be
      // pause/play-toggled), plus capLevel so the ABR does not strand a sw-decode
      // 4K/1440p level on small windows.
      const isYt = hlsIsYt;
      let liveEl = videoEl;
      const hlsSrc = isYt ? getProxiedUrl(streamUrl) : streamUrl;
      if (isYt) {
        // v1.0.68: drive a FRESH mirror <video> (this is the one constant that
        // separates every successful run — control hls, overlayReplay, the
        // isolated 4K probe — from every failed one: they all used a brand-new
        // element. The React node's MediaSource stack wedges on first attach.
        let holder = document.querySelector('.video-player-container')
          || (videoEl && videoEl.closest('.video-player-container'))
          || (videoEl && videoEl.parentNode);
        const freshVid = document.createElement('video');
        freshVid.className = 'video-player';
        freshVid.setAttribute('playsinline', '');
        freshVid.setAttribute('webkit-playsinline', '');
        if (holder) holder.appendChild(freshVid);
        ytLiveElRef.current = freshVid;
        liveEl = freshVid;
        if (videoEl && videoEl.style) videoEl.style.display = 'none';
        // v1.0.68: converge on the controlHls recipe (the diagnostic that parses
        // EVERY time, incl. at t=2.5s): loadSource() FIRST, attachMedia()
        // second, RAW proxied URL, worker:true/ll:true config above.
        const kickHls = () => {
          window.__lastKick = performance.now().toFixed(0);
          hls.loadSource(hlsSrc);
          hls.attachMedia(liveEl);
        };
        if (isYt && !LIVE_HLS_CLS) {
          hlsKickTimer = setTimeout(kickHls, 300);
        } else {
          kickHls();
        }
        (function registerKickCleanup() { /* runs with the rest of the effect */ })();
      } else {
        hls.attachMedia(videoEl);
        hls.loadSource(hlsSrc);
      }
      try { document.body.setAttribute('data-app-master', String(streamUrl)); document.body.setAttribute('data-app-proxy', String(hlsSrc)); } catch (_e) {}
      try { document.body.setAttribute('data-app-master', String(streamUrl)); } catch (_e) {}
      if (isYt) {
        let ytStallWatch = { ct: -1, at: Date.now() };
        ytPlayKickTimer = setInterval(() => {
          if (!autoPlayOnReady) { clearInterval(ytPlayKickTimer); ytPlayKickTimer = null; return; }
          const now = Date.now();
          if (liveEl.currentTime > 0.3) {
            clearInterval(ytPlayKickTimer);
            ytPlayKickTimer = null;
            return;
          }
          if (liveEl.currentTime !== ytStallWatch.ct) { ytStallWatch.ct = liveEl.currentTime; ytStallWatch.at = now; return; }
          if (now - ytStallWatch.at <= 1400) return;
          // Mirror the proven diagnostic hls flow: keep issuing play() (never
          // pause and never recoverMediaError — both tear down Chromium's media
          // source mid-parse and abort the in-flight video buffer).
          liveEl.play().catch(() => {});
        }, 900);
      }

      hls.on(hlsEvents.MANIFEST_PARSED, (_event, data) => {
        networkRetryRef.current = 0;
        stallCountRef.current = 0;
        ytReExtractRef.current = 0;
        ytReloadRef.current = 0;
        if (streamUrl) { try { streamUrlRef.current = streamUrl; } catch (_e) {} }
        if (isYt) ytParsedRef.current = true;
        try {
          const lv = (data && Array.isArray(data.levels) ? data.levels : hls.levels || []).map((l) => ({
            h: l.height, w: l.width, c: (l.codecset || l.videoCodec || '').slice(0, 18), b: Math.round((l.bitrate || 0) / 1000)
          }));
          document.body.setAttribute('data-hls-levels', JSON.stringify(lv.slice(0, 12)));
        } catch (_e) {}
        if (isYt && Array.isArray(data.levels) && data.levels.length) {
          // v1.0.68: force a sane starting level. The top tier (usually an
          // oversized HDR/VP9 or 2160p variant) wedges the zero-time start;
          // pick the best DECODABLE h264 tier ≤720p so playback begins fast.
          const pickTarget = (levels) => {
            let exact = -1; let below = -1;
            for (let i = 0; i < levels.length; i++) {
              const l = levels[i] || {};
              const cc = String(l.codecset || l.videoCodec || '').toLowerCase();
              const good = !cc.includes('vp') && !cc.includes('av01') && !cc.includes('265') && !cc.includes('hevc');
              const h = l.height || 0;
              if (!good) continue;
              if (h <= 720 && h > (exact < 0 ? 0 : (levels[exact].height || 0))) exact = i;
              if (h <= 720 && below < 0 && h >= 360) below = i;
            }
            return exact >= 0 ? exact : below;
          };
          const forced = pickTarget(data.levels);
          if (forced >= 0) hls.currentLevel = forced;
          const cap1080 = data.levels.findIndex((lv) => (lv && lv.height || 9999) <= 1080);
          hls.autoLevelCapping = cap1080 >= 0 ? cap1080 : (data.levels.length - 1);
          try {
            const l0 = hls.levels && hls.levels[forced >= 0 ? forced : hls.currentLevel || 0];
            document.body.setAttribute('data-hls-cur', JSON.stringify({
              forced, cur: hls.currentLevel, cap: hls.autoLevelCapping,
              n: hls.levels ? hls.levels.length : -1,
              h: l0 ? l0.height : -1, c: l0 ? String(l0.codecset || l0.videoCodec || '').slice(0, 30) : null
            }));
          } catch (_e) {}
        }
        const api = window.api || window.electronAPI;
        // v1.0.62: bind the quality menu directly to hls.js's parsed level
        // data (the MANIFEST_PARSED payload) so EVERY .m3u8 stream gets a real
        // resolution dropdown, not just the extractor-enriched ones.
        const parsedLevels = (data && Array.isArray(data.levels) && data.levels.length)
          ? data.levels
          : (hls.levels || []);
        const levelMenu = parsedLevels.length
          ? parsedLevels.map((l, i) => {
              const res = parseHlsResolution(l);
              return { index: i, height: res.height, width: res.width, bitrate: l.bitrate, label: qualityLabel(res.height) || `Quality ${i + 1}` };
            })
          : [];
        // v1.0.61: a tokenized HLS master (hanime) frequently yields ONE
        // height-0 level → the old menu showed only "Auto + Quality 1". When
        // the extractor enumerated real variant tiers, prefer those rows and
        // use their per-variant URLs for quality switching.
        const rich = extractQualityLevelsRef.current.length
          ? extractQualityLevelsRef.current.map((q, i) => ({ ...q, index: i }))
          : [];
        const degenerate = !parsedLevels.length || parsedLevels.length <= 1
          || levelMenu.every((l) => !l.height);
        // v1.0.62: when hls.js collapsed the master into a single height-0
        // level (tokenized/CDN masters, pasted playlists, non-enriched
        // sources), ask main to parse the raw #EXT-X-STREAM-INF RESOLUTION
        // rows (CORS-free fetch with per-origin headers + CF recovery) and
        // rebuild the menu off real variants. Guarded to one attempt per origin.
        if (degenerate && rich.length < 2 && api?.parseMasterStream
            && originStreamUrlRef.current
            && masterParseAttemptedRef.current !== originStreamUrlRef.current) {
          masterParseAttemptedRef.current = originStreamUrlRef.current;
          const originMaster = originStreamUrlRef.current;
          api.parseMasterStream(originMaster)
            .then((parsed) => {
              const usable = (parsed && Array.isArray(parsed.variants) ? parsed.variants : [])
                .filter((q) => q && q.url && (q.height || q.label)
                  && (q.url.includes('m3u8') || q.url.includes('.m3u') || q.url.includes('/hls/')));
              if (usable.length >= 2) {
                // Re-entering via extractQualityLevels re-runs this effect (it
                // is an init dep) → the fresh hls.js parse now sees rich rows.
                setExtractQualityLevels(usable);
              }
            })
            .catch(() => {});
        }
        // v1.0.63: whenever the extractor handed us real per-quality URLs
        // (explicit `qualities`, or enriched variant tiers), the dropdown uses
        // those rows directly — no dependence on hls.js manifest parsing.
        // Selecting one points the pipeline at that variant sub-playlist and
        // preserves position + play/pause state (applyVariantLevel).
        const useRich = rich.length >= 2;
        const menu = useRich ? rich : levelMenu;
        if (menu.length) {
          setQualityLevels(menu);
          // Resolve the saved quality preference (auto | max | <num> | height string)
          const savedPref = readPrefs().preferredQuality;
          let lvl = -1;
          if (savedPref === 'max' && menu.length) {
            lvl = menu.length - 1;
          } else if (typeof savedPref === 'number' && savedPref >= 0 && savedPref < menu.length) {
            lvl = savedPref;
          } else {
            const target = typeof savedPref === 'string' && !['auto', 'max'].includes(savedPref)
              ? parseInt(savedPref, 10)
              : NaN;
            if (!isNaN(target)) {
              let exact = -1;
              let below = -1;
              for (let i = 0; i < menu.length; i++) {
                const h = menu[i].height || 0;
                if (h === target && exact === -1) exact = i;
                if (h < target && h > (below === -1 ? 0 : menu[below].height || 0)) below = i;
              }
              lvl = exact !== -1 ? exact : (below !== -1 ? below : -1);
            }
          }
          if (useRich) {
            // One level in hls.js → can't drive hls.currentLevel. Auto-apply
            // the saved pref ONCE per master by pointing the pipeline at the
            // chosen variant sub-playlist (guarded against a switch loop).
            const chosen = lvl >= 0 ? menu[lvl] : null;
            if (chosen && chosen.url && chosen.url !== streamUrl && variantAppliedRef.current !== streamUrl) {
              variantAppliedRef.current = streamUrl;
              applyVariantLevelRef.current(chosen);
              return;
            }
            setSelectedQuality(lvl >= 0 ? menu[lvl].label : 'auto');
          } else {
            hls.currentLevel = lvl;
            setSelectedQuality(lvl === -1 ? 'auto' : lvl);
          }
        }
if (pendingSeekRef.current) {
          const pos = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (shouldResume(pos)) {
            try { liveEl.currentTime = pos; } catch (e) {}
          }
        }
        if (autoPlayOnReady) liveEl.play().catch(() => {});
      });

      hls.on(hlsEvents.ERROR, (event, data) => {
        {
          const nd = data && data.networkDetails;
          console.info('[vhtrace] hlsErr', JSON.stringify({
            type: data && data.type,
            details: data && data.details,
            fatal: !!(data && data.fatal),
            code: data && data.code,
            url: data && data.url ? String(data.url).slice(0, 180) : null,
            responseType: data && data.responseType,
            response: data && data.response ? String(data.response).slice(0, 160) : null,
            xhrStatus: nd && nd.xhr ? nd.xhr.status : null,
            xhrReady: nd && nd.xhr ? nd.xhr.readyState : null,
            loader: nd ? (nd.constructor && nd.constructor.name) : null,
            err: nd && nd.err ? String(nd.err).slice(0, 220) : null
          }).slice(0, 800));
        }
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              // A totally invalid manifest means this isn't HLS at all —
              // bail out to native playback once so the stream still appears.
              if (forceHls && !looksHls && !hlsFallbackUsedRef.current &&
                  (data.details === 'manifestLoadError' || data.details === 'manifestInvalidError')) {
                hlsFallbackUsedRef.current = true;
                console.warn('[VideoPlayer] HLS manifest invalid, falling back to native:', data.details);
                playNative(true);
                return;
              }
              // v1.0.68 YouTube freeze-at-0:00: googlevideo master URLs are
              // single-use, and rapid back-to-back connects in the same tick
              // get refused (status 0) by YT's burst filter. A brand-new Hls
              // instance on the SAME proxied master provably recovers (the
              // diagnostic inject-and-attach flow succeeds every run) — so try
              // fresh-instance retries first, then re-resolve for a cold master.
              if (isYt && data.details === 'manifestLoadError') {
                // v1.0.68 YT freeze: the harness diagnostic proved the SAME proxied master
                // parses via hls.js the moment ≥~2.5s pass since the last failed
                // manifest request (earlyCtrl controlHls at t=2.5s succeeds, and
                // every app retry spaced 900ms failed — all inside YT's burst
                // refusal window). Fix: space the fresh-instance retry to 3.5s,
                // then cold re-resolve. No attempt inside the refusal window.
                if (ytReloadRef.current < 3) {
                  ytReloadRef.current += 1;
                  const attemptN = ytReloadRef.current;
                  console.warn('[VideoPlayer] YT manifest refused, fresh-instance retry ' + attemptN + '…');
                  setTimeout(() => {
                    // v1.0.68: a toastable parse may have succeeded between the
                    // error and this timer — never destroy a working instance.
                    if (ytParsedRef.current && (streamUrlRef.current || '') === streamUrl) return;
                    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch (_e) {} }
                    hlsRef.current = null;
                    setHlsRetryKey((k) => k + 1);
                  }, attemptN === 1 ? 3500 : 5000);
                  break;
                }
                if (ytReExtractRef.current < 3 && video.videoUrl && api?.extractStream) {
                  ytReExtractRef.current += 1;
                  const attemptN = ytReExtractRef.current;
                  setTimeout(() => {
                    console.warn('[VideoPlayer] YT manifest refused, re-resolving fresh (attempt ' + attemptN + ')…');
                    (async () => {
                      let reloaded = false;
                      try {
                        const re = await withTimeout(
                          api.extractStream(String(video.videoUrl)),
                          STEALTH_EXTRACTION_TIMEOUT_MS,
                          new Error('YouTube re-extract timed out')
                        );
                        if (attemptN === 1) await new Promise((r) => setTimeout(r, 1500));
                        const nu = re && re.success ? (re.data?.videoUrl || re.streamUrl) : null;
                        if (nu && nu !== (streamUrlRef.current || streamUrl) && /googlevideo\.com|videoplayback/i.test(String(nu))) {
                          streamUrlRef.current = String(nu);
                          try { liveEl.pause(); } catch (_e) {}
                          hls.stopLoad();
                          hls.loadSource(getProxiedUrl(String(nu)));
                          reloaded = true;
                        }
                      } catch (_e) {}
                      if (!reloaded) {
                        hls.destroy();
                        setStreamError('YouTube stream could not recover — connection refused: ' + (data.details || ''));
                        setHasError(true);
                      }
                    })();
                  }, attemptN === 1 ? 2500 : 6000);
                  break;
                }
                if (isZapping || video.sourceSite === 'IPTV' || video.type === 'Web TV') {
                  handleIptvUnavailableRef.current(false);
                  return;
                }
                hls.destroy();
                setStreamError('YouTube stream could not recover — connection refused: ' + (data.details || ''));
                setHasError(true);
                break;
              }
              // Temporary network blip: recover via startLoad with backoff.
              if (!scheduleRetry(streamUrlRef.current || streamUrl, 'hls')) {
                if (isZapping || video.sourceSite === 'IPTV' || video.type === 'Web TV') {
                  handleIptvUnavailableRef.current(false);
                  return;
                }
                hls.destroy();
                setStreamError('Network error — playback could not recover: ' + (data.details || ''));
                setHasError(true);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              if (isZapping || video.sourceSite === 'IPTV' || video.type === 'Web TV') {
                handleIptvUnavailableRef.current(false);
                return;
              }
              hls.destroy();
              setStreamError('HLS playback error: ' + data.details);
              setHasError(true);
              break;
          }
        }
      });
    } else if (looksHls && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari)
      // Validate streamUrl is a proper media URL before assignment
      if (!/\.(mp4|webm|m3u8|ts|m4s|mkv|m4v|mov|avi)(\?|$)/i.test(streamUrl) && 
          !streamUrl.includes('googlevideo.com') && 
          !streamUrl.includes('videoplayback') &&
          !(streamUrl.startsWith('http://localhost:') && streamUrl.includes('/video/proxy/stream'))) {
        setHasError(true);
        setStreamError('Invalid media stream URL');
        return;
      }
      videoEl.src = streamUrl;
      videoEl.addEventListener('loadedmetadata', () => {
        seekToResume(videoEl);
        videoEl.play().catch(() => {});
      }, { once: true });
    } else {
      // Regular MP4/WebM/YouTube HTTPS
      // Validate streamUrl is a proper media URL before assignment
      if (!/\.(mp4|webm|m3u8|ts|m4s|mkv|m4v|mov|avi)(\?|$)/i.test(streamUrl) && 
          !streamUrl.includes('googlevideo.com') && 
          !streamUrl.includes('videoplayback') &&
          !(streamUrl.startsWith('http://localhost:') && streamUrl.includes('/video/proxy/stream'))) {
        setHasError(true);
        setStreamError('Invalid media stream URL');
        return;
      }
      videoEl.src = streamUrl;
      videoEl.addEventListener('loadedmetadata', () => {
        seekToResume(videoEl);
        videoEl.play().catch(() => {});
        mirrorYt((v)=>v.play().catch(()=>{}));
        syncPlayerWithAppState();
      }, { once: true });
    }

    return () => {
      clearIptvWatchRef.current();
      clearTimeout(hlsKickTimer);
      if (ytPlayKickTimer) { clearInterval(ytPlayKickTimer); ytPlayKickTimer = null; }
      // v1.0.68: an enrichment/level-menu re-run with the SAME streamUrl must
      // NOT destroy the in-flight instance (that is the freeze mechanism).
      if (isYtEarly && (streamUrlRef.current || '') === streamUrl) {
        return;
      }
      if (ytLiveElRef.current) {
        try { ytLiveElRef.current.remove(); } catch (_e) {}
        ytLiveElRef.current = null;
      }
      try { if (videoEl && videoEl.style) videoEl.style.display = ''; } catch (_e) {}
      videoEl.removeEventListener('stalled', handleStalled);
      videoEl.removeEventListener('playing', handlePlaying);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      videoEl.pause();
      videoEl.src = '';
    };
  }, [streamUrl, isDRM, shouldResume, seekToResume, scheduleRetry, hlsRetryKey, extractQualityLevels, applyVariantLevel]);

  // v1.0.61: flush + cancel any pending cloud progress sync on unmount.
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) {
        clearTimeout(syncTimerRef.current);
        syncTimerRef.current = null;
      }
    };
  }, []);

  // v1.0.88: the letterbox backdrop, the player container and the <video>
  // element all share ONE debounced handler (`handleSurfaceClick`, defined
  // above). Each of these three used to have its own independent play/pause
  // toggle, so a single physical click could be counted two or three times and
  // cancel itself out. `handleSurfaceClick` calls stopPropagation(), so exactly
  // one handler ever sees a given click.

  // Video event handlers — bound to the media element so React state tracks the
  // element's real state (previously only onPlay/onPause were wired, which is
  // why the progress bar, timer and elapsed label stayed frozen at 0:00).
  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => {
    setIsPlaying(false);
    const videoEl = videoRef.current;
    const pos = videoEl ? videoEl.currentTime || 0 : 0;
    savePosition(pos);
    // v1.0.61: refresh the continue-watching row on explicit pause (even
    // under 30s) and push progress to the cloud shortly after.
    recordWatchHistory(pos, videoEl ? videoEl.duration : 0);
    scheduleSync();
  }, [savePosition, recordWatchHistory, scheduleSync]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    savePosition(0);
    const videoEl = videoRef.current;
    recordWatchHistory(0, videoEl ? videoEl.duration : 0);
    scheduleSync();
  }, [video, savePosition, recordWatchHistory, scheduleSync]);
  
  const handleTimeUpdate = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    setCurrentTime(videoEl.currentTime);
    const d = videoEl.duration;
    if (typeof d === 'number' && isFinite(d) && d > 0) setDuration(d);

    // Periodically persist position + continue-watching history (throttled to
    // ~5s) so resume AND cloud-progress stay current mid-play (v1.0.61).
    const now = Date.now();
    if (now - lastSaveTimeRef.current >= 5000) {
      lastSaveTimeRef.current = now;
      const pos = videoEl.currentTime || 0;
      const dur = videoEl.duration || 0;
      savePosition(pos >= 5 && (dur <= 0 || pos < dur - 10) ? pos : 0);
      // The watch_history row (and its cloud mirror) only counts a video once
      // it has played for a bit (~30s), matching the shelf's convention.
      if (pos > 30) {
        recordWatchHistory(pos, dur);
        scheduleSync();
      }
    }
  }, [video, savePosition, recordWatchHistory, scheduleSync]);

  const handleDurationChange = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const d = videoEl.duration;
    // Reject the live-stream sentinels (Infinity / NaN / 0) so the progress bar
    // and elapsed/total labels never render as "0:00 / 0:00" on a finite file.
    setDuration(typeof d === 'number' && isFinite(d) && d > 0 ? d : 0);
  }, []);

  // Clears the loading spinner once the element can actually render frames.
  const handleCanPlay = useCallback(() => {
    setIsLoading(false);
    setIsExtracting(false);
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const d = videoEl.duration;
    if (typeof d === 'number' && isFinite(d) && d > 0) setDuration(d);
    // v1.0.88: hls.js re-attaches the media element on quality/segment swaps,
    // which resets per-element state including volume. Re-assert on every
    // canplay so the remembered level survives mid-playback stream swaps.
    forceApplyStoredVolume(videoEl);
  }, [forceApplyStoredVolume]);

  // Live/IPTV watchdog disarm: reaching 'canplay' proves the stream is alive,
  // so the dead-channel timer must be cancelled here.
  useEffect(() => {
    if (!isLoading) clearIptvWatch();
  }, [isLoading, clearIptvWatch]);

  const handleError = useCallback((e) => {
    const error = videoRef.current?.error;
    if (error) {
      const errorDetails = {
        code: error.code,
        message: error.message,
        currentSrc: videoRef.current?.currentSrc,
        networkState: videoRef.current?.networkState,
        readyState: videoRef.current?.readyState
      };
      console.error('[VideoPlayer] MediaError:', errorDetails);

      // Code 2 (MEDIA_ERR_NETWORK): temporary network blip on a native source —
      // reload with backoff a few times before surfacing the error.
      if (error.code === 2 && !hlsRef.current && networkRetryRef.current < MAX_PLAYBACK_RETRIES) {
        if (scheduleRetry(streamUrlRef.current || video.pageUrl || video.videoUrl || video.url, 'native')) {
          setStreamError(null);
          setHasError(false);
          return;
        }
      }

      // Code 4 (MEDIA_ELEMENT_ERROR: Format error) on an IPTV/Web TV stream that
      // fell back to native playback usually means the content is HLS but wasn't
      // detected as such — retry once through hls.js.
      const isIptvLike = video.sourceSite === 'IPTV' || video.type === 'Web TV';
      if (error.code === 4 && isIptvLike && typeof Hls !== 'undefined' && Hls.isSupported() &&
          !hlsRef.current && !hlsSelfHealUsedRef.current) {
        hlsSelfHealUsedRef.current = true;
        console.warn('[VideoPlayer] Native playback failed (format error), retrying via hls.js');
        setStreamError(null);
        setHasError(false);
        setHlsRetryKey(k => k + 1);
        return;
      }

      // IPTV/Web TV live streams: an unrecoverable error means the channel is
      // dead right now. Mark it (isOnline: 0) + toast + zap forward or close,
      // instead of parking on the generic error overlay.
      if (isIptvLike || isZapping) {
        handleIptvUnavailable(false);
        return;
      }

      const msg = `Playback error (code ${error.code}): ${error.message || 'Unknown error'}`;
      setStreamError(msg);
      setHasError(true);
    }
  }, [video, scheduleRetry, isZapping, handleIptvUnavailable]);

  // Handle webview load events for DRM content
  const handleWebviewLoadStart = () => {
    console.log('[VideoPlayer] Webview loading DRM content...');
  };
  const handleWebviewLoadStop = () => {
    console.log('[VideoPlayer] Webview loaded DRM content');
    setIsLoading(false);
  };
  const handleWebviewLoadError = (e) => {
    console.error('[VideoPlayer] Webview load error:', e);
    setStreamError('Failed to load DRM content in webview');
    setHasError(true);
  };

  const osdBanner = osd && isZapping ? (
    <div className="osd-banner">
      <span className="osd-number">{osd.number}</span>
      {osd.logo
        ? <img className="osd-logo" src={osd.logo} alt="" draggable={false} />
        : <span className="osd-logo">{'📺'}</span>}
      <span className="osd-name">{osd.name}</span>
      <span className="osd-group">{osd.group}</span>
    </div>
  ) : null;

  // Render error overlay
  if (hasError) {
    return (
      <div className="video-player-background">
        <div className="error-overlay">
          <div className="error-content">
            <h2>Playback Failed</h2>
            <p className="error-message">{streamError || 'Unknown error occurred'}</p>
            <div className="error-actions">
              <button className="btn btn-primary" onClick={handleRetry}>
                Retry
              </button>
              <button className="btn btn-secondary" onClick={closePlayer}>
                Close & Back to Library
              </button>
            </div>
          </div>
        </div>
        
        {/* Always-visible close button */}
        <button 
          className="absolute-close-btn" 
          onClick={closePlayer}
          aria-label="Close player"
        >
          ×
        </button>
      </div>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="video-player-background">
        {osdBanner}
        <div className="loading-container">
          <div className="loading-spinner"></div>
          <p>{isExtracting ? 'Extracting stream...' : (isDRM ? 'Loading DRM content...' : 'Loading video...')}</p>
        </div>

        {/* Stream-unavailable toast (IPTV dead channel feedback) */}
        {streamUnavailable && <div className="vp-toast">Stream unavailable</div>}

        {/* Always-visible close button */}
        <button 
          className="absolute-close-btn" 
          onClick={closePlayer}
          aria-label="Close player"
        >
          ×
        </button>
      </div>
    );
  }

  return (
    <div
      className={`video-player-background ${!isControlsVisible && isFullscreen ? 'cursor-none' : ''}`}
      onClick={handleSurfaceClick}
      onMouseLeave={() => {
        if (!isPaused) {
          clearControlsTimer();
          setIsControlsVisible(false);
        }
      }}
    >
      <div
        className="video-player-container"
        onClick={handleSurfaceClick}
        onDoubleClick={handleSurfaceDoubleClick}
      >
        {/* Stream-unavailable toast (IPTV dead channel feedback) */}
        {streamUnavailable && <div className="vp-toast">Stream unavailable</div>}

        {/* DRM Protected Content - WebView Fallback */}
        {isDRM && drmWebUrl && (
          <webview
            ref={webviewRef}
            src={drmWebUrl}
            className={`webview-player ${isFullscreen ? 'fullscreen' : ''}`}
            preload
            autosize="on"
            allowpopups
            webpreferences={{
              webSecurity: false,
              allowRunningInsecureContent: true,
              plugins: true,
              sandbox: false
            }}
            onDidStartLoading={handleWebviewLoadStart}
            onDidStopLoading={handleWebviewLoadStop}
            onDidFailLoad={handleWebviewLoadError}
            style={{ width: '100%', height: '100%', minHeight: '400px' }}
          />
        )}

        {/* Regular Video Player (non-DRM) */}
        {!isDRM && (
          <video 
            ref={videoRef}
            className={`video-player ${isFullscreen ? 'fullscreen' : ''}`}
            controls
            autoPlay
            playsInline
            crossOrigin="anonymous"
            referrerPolicy="no-referrer"
            onClick={handleSurfaceClick}
            onLoadedMetadata={(e) => {
              const el = e && e.target;
              const d = el ? el.duration : NaN;
              // Live/unknown-duration streams report Infinity or NaN; guard so
              // the progress bar and the "0:00 / 0:00" label stay sane.
              setDuration(typeof d === 'number' && isFinite(d) && d > 0 ? d : 0);
              // v1.0.88: re-assert the remembered volume the moment a new
              // stream reports metadata, before the user can see or hear the
              // element's default. Without this, a volume set to 10% was
              // audible-correct on the current video but snapped to 100% on the
              // next one.
              forceApplyStoredVolume(el);
              try { syncPlayerWithAppState(); } catch (_e) {}
            }}
            onLoadedData={handleCanPlay}
            onCanPlay={handleCanPlay}
            onPlaying={handlePlay}
            onPlay={handlePlay}
            onPause={handlePause}
            onTimeUpdate={handleTimeUpdate}
            onProgress={handleTimeUpdate}
            onDurationChange={handleDurationChange}
            onEnded={handleEnded}
            onError={handleError}
            muted={isMuted}
          >
            <p className="vjs-no-js">
              To view this video please enable JavaScript, and consider upgrading to a
              web browser that <a href="https://videojs.com/html5-video-support/" target="_blank">
              supports HTML5 video
              </a>
            </p>
          </video>
        )}

        {/* Custom Controls Overlay - hidden on mouse inactivity during playback */}
        <div className={`player-controls-overlay ${isControlsVisible
          ? 'visible opacity-100 pointer-events-auto transition-opacity duration-300'
          : 'hidden opacity-0 pointer-events-none transition-opacity duration-300'}`}>
          {/* Top gradient header */}
          <div className="controls-top-mask">
          </div>

          {/* Top Bar - Title and Close */}
          <div className="controls-top-bar">
            <button 
              className="control-btn back-btn" 
              onClick={closePlayer}
              aria-label="Back to library"
            >
              ←
            </button>
            <div className="top-title-wrap">
              <h2 className="overlay-title">{video?.videoTitle || 'Video Player'}</h2>
              <div className="top-subtitle">
                {video?.videoUrl && (
                  <a 
                    href={video.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="stream-source-link"
                  >
                    {(() => {
                      try {
                        return new URL(video.videoUrl).hostname.replace('www.', '');
                      } catch {
                        return 'Video Source';
                      }
                    })()}
                  </a>
                )}
                {downloadStarted && (
                  <span className="download-started-hint">√ Downloading…</span>
                )}
              </div>
            </div>
            {isDRM && (
              <span className="drm-badge">DRM Protected - WebView Mode</span>
            )}
            <button 
              className="control-btn close-btn" 
              onClick={closePlayer}
              aria-label="Close player"
            >
              ×
            </button>
          </div>

          {/* Bottom Controls */}
          <div className="controls-bottom-bar">
            {/* Quality menu (engine rows | standard tiers | Auto source default) */}
            {menuOpen === 'quality' && (
              <div className="popup-menu quality-menu">
                <button 
                  className={`menu-item ${selectedQuality === 'auto' ? 'active' : ''}`}
                  onClick={() => { handleQualityChange('auto'); setMenuOpen(null); }}
                >
                  Auto
                </button>
                {qualityMenuItems.length > 0 ? qualityMenuItems.map((lvl, i) => (
                  <button 
                    key={lvl.formatId || lvl.index || i} 
                    className={`menu-item ${String(selectedQuality) === String(lvl.index) || selectedQuality === lvl.label ? 'active' : ''}`}
                    onClick={() => { handleQualityChange(lvl._engineIndex !== undefined ? lvl._engineIndex : i); setMenuOpen(null); }}
                  >
                    {lvl.label || (lvl.height ? `${lvl.height}p` : (lvl.width ? `${lvl.width}px` : qualityLabel(lvl.height) || `Quality ${i}`))}
                    {lvl.bitrate ? ` · ${Math.round(lvl.bitrate / 1000)}kbps` : ''}
                    {!lvl.bitrate && lvl.label && lvl.height ? ` · ${lvl.height}p` : ''}
                    {lvl.url && lvl.hasAudio === false ? ' · audio-less' : ''}
                    {!lvl.url && !lvl.formatId && lvl.height ? ' · re-extract' : ''}
                  </button>
                )) : (
                  // v1.0.64: single-tier / unenumerated source — the source's
                  // own default quality; keeps the menu non-empty.
                  <button 
                    className="menu-item"
                    onClick={() => { handleQualityChange('auto'); setMenuOpen(null); }}
                  >
                    Auto (Source Default)
                  </button>
                )}
              </div>
            )}

            {/* Speed menu */}
            {menuOpen === 'speed' && (
              <div className="popup-menu speed-menu">
                {SPEED_OPTIONS.map(rate => (
                  <button 
                    key={rate} 
                    className={`menu-item ${playbackRate === rate ? 'active' : ''}`}
                    onClick={() => { handleRateChange(rate); setMenuOpen(null); }}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            )}



            {/* Main control row */}
            <div className="controls-row">
              <div className="progress-track" 
                ref={progressRef}
                onClick={handleProgressClick}
                role="slider"
                aria-label="Playback progress"
                aria-valuemin={0}
                aria-valuemax={duration || 100}
                aria-valuenow={currentTime}
              >
                <div 
                  className="progress-fill"
                  style={{ width: duration ? `${(currentTime / duration) * 100}%` : '0%' }}
                />
                <div className="progress-handle" style={{ left: duration ? `${(currentTime / duration) * 100}%` : '0%' }} />
              </div>

              <div className="controls-row-inner">
                {/* Play/Pause */}
                <button 
                  className="control-btn" 
                  onClick={togglePlay}
                  aria-label={!isPlaying ? 'Play' : 'Pause'}
                >
                  {!isPlaying ? '▶' : '⏸'}
                </button>

                {/* Time Display */}
                <div className="time-display">
                  <span className="current-time">{formatTime(currentTime)}</span>
                  <span className="time-separator">/</span>
                  <span className="duration-time">{formatTime(duration)}</span>
                </div>

                <div className="controls-spacer" />

                {/* Favorite heart */}
                <button 
                  className={`control-btn fav-btn ${isFav ? 'active' : ''}`}
                  onClick={toggleFavorite}
                  disabled={favToggling || favChecking}
                  aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={isFav}
                  title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                >
                  {isFav ? '♥' : '♡'}
                </button>

                {/* Download */}
                <button 
                  className="control-btn"
                  onClick={handleDownload}
                  aria-label="Download video"
                  title="Download"
                >
                  {isDownloading ? '…' : '⬇'}
                </button>

                {/* Playback speed */}
                <button 
                  className="control-btn rate-btn"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === 'speed' ? null : 'speed'); }}
                  aria-label="Playback speed"
                  title="Playback speed"
                >
                  {playbackRate}x
                </button>

                {/* Quality (v1.0.64: always rendered for a loaded stream — never hidden) */}
                {streamActive && (
                  <button 
                    className="control-btn"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === 'quality' ? null : 'quality'); }}
                    aria-label="Quality settings"
                    title="Quality"
                  >
                    {qualityTriggerLabel()}
                  </button>
                )}

                {/* Volume */}
                <div
                  className={`volume-control ${volumeOpen ? 'volume-open' : ''}`}
                  onPointerEnter={openVolume}
                  onPointerLeave={scheduleCloseVolume}
                >
                  <button 
                    className="control-btn volume-btn"
                    onClick={toggleMute}
                    aria-label={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
                  </button>
                  {/* Vertical popover ABOVE the icon: opens upward so it never
                      covers the adjacent action buttons (Speed/Quality/Float). */}
                  <div
                    className="volume-popover"
                    onPointerEnter={openVolume}
                    onPointerLeave={scheduleCloseVolume}
                  >
                    <input
                      ref={volumeRef}
                      type="range"
                      className="volume-slider"
                      min="0"
                      max="1"
                      step="0.05"
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      aria-label="Volume"
                    />
                  </div>
                </div>

                {/* Float to mini player (PiP) */}
                <button 
                  className="control-btn float-btn"
                  onClick={handleFloatToMini}
                  aria-label="Float in mini player"
                  title="Float in mini player (PiP)"
                >
                  ⁝
                </button>

                {/* Channel zapping (IPTV) */}
                {isZapping && (
                  <>
                    <span
                      className="channel-badge"
                      title="Current channel"
                    >
                      {Number.isInteger(channelIndex) ? channelIndex + 1 : 1}/{channelList ? channelList.length : 0}
                    </span>
                    <button
                      className="control-btn"
                      onClick={() => zap(-1)}
                      aria-label="Channel down"
                      title="Channel down"
                    >
                      Ch −
                    </button>
                    <button
                      className="control-btn"
                      onClick={() => zap(1)}
                      aria-label="Channel up"
                      title="Channel up"
                    >
                      Ch +
                    </button>
                  </>
                )}

                {/* Fullscreen */}
                <button 
                  className="control-btn" 
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? '▶◀' : '⛶'}
                </button>
              </div>
            </div>
          </div>
        </div>

        {osdBanner}

        {/* Always-visible absolute close button (top-right) */}
        <button 
          className="absolute-close-btn" 
          onClick={closePlayer}
          aria-label="Close player"
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default VideoPlayer;