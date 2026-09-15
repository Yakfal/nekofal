import React, { useState, useEffect, useRef, useCallback } from 'react';
import Hls from 'hls.js';
import { bindMediaKey, unbindMediaKey } from '../utils/mediaKeys.js';
import { pickBestStream } from '../services/customScraper.js';
import './VideoPlayer.css';

// ---- Static configuration (hoisted above the component to avoid TDZ) ----
// Declared with `var` so the output has no block-scoped bindings at module
// level, which is what makes Temporal Dead Zone errors impossible at runtime.
var EXTRACTION_TIMEOUT_MS = 30000;
var PREF_KEY = 'pmh-preferences';
var SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// Playback blip recovery: how many times to retry a stream that hiccups on the
// network, with exponential backoff between attempts.
var MAX_PLAYBACK_RETRIES = 5;
var RETRY_BACKOFF_MS = [800, 1600, 3200, 6400, 12800];

// Local video server port (from electron main.js). Defaults to 5001 but can be
// dynamic if the preferred ports were busy — refresh via getVideoServerInfo().
var videoProxyPort = 5001;

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

function VideoPlayer({ video, onClose, channelList, channelIndex, onZapTo }) {
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
    const p = readPrefs();
    return typeof p.defaultVolume === 'number' ? p.defaultVolume : 1;
  });
  const [isMuted, setIsMuted] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(() => {
    const p = readPrefs();
    return typeof p.defaultRate === 'number' ? p.defaultRate : 1;
  });
  const [qualityLevels, setQualityLevels] = useState([]);
  const [selectedQuality, setSelectedQuality] = useState('auto');
  const [menuOpen, setMenuOpen] = useState(null);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const pendingSeekRef = useRef(null);
  const lastSaveTimeRef = useRef(0);
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
        // Already routed through our local file server - return as-is
        if (u.hostname === 'localhost' && u.pathname.includes('/video/proxy')) {
          return url;
        }
        const isLocalFile = url.startsWith('file://') || /^[a-zA-Z]:[\\\/]/.test(url);
        if (isLocalFile) {
          return `http://localhost:${videoProxyPort}/video/proxy/stream?src=${encodeURIComponent(url)}`;
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
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Keep a ref mirror of the active stream URL for retry logic.
  useEffect(() => {
    streamUrlRef.current = streamUrl;
  }, [streamUrl]);

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
  }, [onClose, savePosition]);

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

  // Adjust volume
  const adjustVolume = useCallback((delta) => {
    const videoEl = videoRef.current;
    if (videoEl) {
      const newVol = Math.max(0, Math.min(1, videoEl.volume + delta));
      videoEl.volume = newVol;
      videoEl.muted = newVol === 0;
      setVolume(newVol);
      setIsMuted(newVol === 0);
      writePref('defaultVolume', newVol);
    }
  }, []);

  // Toggle play/pause
  const togglePlayPause = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl) {
      if (videoEl.paused) {
        videoEl.play().catch(() => {});
      } else {
        videoEl.pause();
      }
    }
  }, []);

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
    if (videoEl) {
      videoEl.muted = !videoEl.muted;
      setIsMuted(videoEl.muted);
      if (!videoEl.muted && videoEl.volume === 0) {
        videoEl.volume = 1;
        setVolume(1);
        writePref('defaultVolume', 1);
      }
    }
  }, []);

  // Volume change from slider
  const handleVolumeChange = useCallback((e) => {
    const videoEl = videoRef.current;
    const newVol = parseFloat(e.target.value);
    if (videoEl) {
      videoEl.volume = newVol;
      videoEl.muted = newVol === 0;
      setVolume(newVol);
      setIsMuted(newVol === 0);
    }
    // Persist the level globally so every future video (and the mini player)
    // opens at the same volume across sessions.
    if (!isNaN(newVol)) writePref('defaultVolume', newVol);
  }, []);

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
      videoEl.currentTime = percent * videoEl.duration;
    }
  }, []);

  // Switch the active yt-dlp stream to a specific format (non-HLS videos)
  const switchYtQuality = useCallback(async (level) => {
    if (!level || !level.formatId) return;
    const api = window.api || window.electronAPI;
    const videoEl = videoRef.current;
    const pos = videoEl ? videoEl.currentTime || 0 : 0;
    const wasPlaying = videoEl && !videoEl.paused;

    try {
      setIsLoading(true);
      setIsExtracting(true);
      setStreamError(null);
      setHasError(false);
      const res = await api.extractStream(sourceUrlRef.current || video.videoUrl, level.formatId);
      if (res?.success && res.data?.videoUrl) {
        pendingSeekRef.current = pos;
        const proxied = getProxiedUrl(res.data.videoUrl, res.data.httpHeaders || null);
        setStreamUrl(proxied);
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

  // Quality selection (HLS levels or yt-dlp formats)
  const handleQualityChange = useCallback(async (val) => {
    const hls = hlsRef.current;
    // HLS path
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
    // yt-dlp format path (non-HLS)
    if (typeof val === 'number' && qualityLevels[val]?.formatId) {
      await switchYtQuality(qualityLevels[val]);
      return;
    }
    setSelectedQuality(val);
  }, [qualityLevels, switchYtQuality]);

  // Playback speed selection
  const handleRateChange = useCallback((rate) => {
    setPlaybackRate(rate);
    writePref('defaultRate', rate);
    const videoEl = videoRef.current;
    if (videoEl) videoEl.playbackRate = rate;
  }, []);

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

  // ---------- HLS quality quick presets ----------
  const PRESET_HEIGHTS = [1080, 720, 480, 360];
  const hasHlsLevels = qualityLevels.length > 1 && qualityLevels.some(l => l.height);
  const hasLevelFor = useCallback((targetH) => {
    if (!hasHlsLevels) return false;
    return true; // selectHlsLevelByHeight picks closest-or-exact
  }, [hasHlsLevels]);
  const selectHlsLevelByHeight = useCallback((targetH) => {
    const hls = hlsRef.current;
    if (!hls || !hls.levels || !hls.levels.length) return;
    let exactIdx = -1;
    let bestLowerIdx = -1;
    let bestLowerH = 0;
    for (let i = 0; i < hls.levels.length; i++) {
      const h = hls.levels[i].height || 0;
      if (h === targetH && exactIdx === -1) exactIdx = i;
      if (h < targetH && h > bestLowerH) { bestLowerH = h; bestLowerIdx = i; }
    }
    const idx = exactIdx !== -1 ? exactIdx : (bestLowerIdx !== -1 ? bestLowerIdx : hls.levels.length - 1);
    hls.currentLevel = idx;
    setSelectedQuality(idx);
    writePref('preferredQuality', idx);
  }, []);

  const handlePresetChange = useCallback((preset) => {
    if (preset === 'auto') {
      handleQualityChange('auto');
    } else {
      selectHlsLevelByHeight(preset);
    }
  }, [handleQualityChange, selectHlsLevelByHeight]);

  const currentPresetH = useCallback(() => {
    const hls = hlsRef.current;
    if (!hls || !hls.levels || selectedQuality === 'auto') return null;
    const lvl = hls.levels[selectedQuality];
    return lvl ? lvl.height : null;
  }, [selectedQuality]);

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
    setSelectedQuality('auto');
    streamHlsRef.current = false;
    sourceUrlRef.current = video.videoUrl || video.url;
    networkRetryRef.current = 0;
    stallCountRef.current = 0;

    // Remember where to jump once metadata is ready
    const saved = Number(video.lastPosition) || 0;
    pendingSeekRef.current = saved;

    try {
      const api = window.api || window.electronAPI;
      
      let streamUrl = video.videoUrl;
      let httpHeaders = video.httpHeaders || null;
      let isHLS = video.isHLS || false;

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
          const result = await withTimeout(
            api.extractStream(streamUrl),
            EXTRACTION_TIMEOUT_MS,
            new Error('Extraction timeout (10s)')
          );
          
          // Normalize the two possible success shapes:
          //  - { success, data: { videoUrl, httpHeaders, isHLS, qualityLevels, ... } }
          //  - { success, streamUrl, isHls }  (main's direct-media fast path)
          const extraction = result && result.success && (result.data?.videoUrl || result.streamUrl)
            ? (result.data?.videoUrl ? result.data : { videoUrl: result.streamUrl, isHLS: !!result.isHls, httpHeaders: null, qualityLevels: [] })
            : null;

          if (extraction && extraction.videoUrl) {
            // Validate the returned stream URL is a direct media stream
            const extractedUrl = extraction.videoUrl;
            const isValidMedia = /\.(mp4|webm|m3u8|ts|m4s|mkv|m4v|mov|avi)(\?|$)/i.test(extractedUrl) 
              || extractedUrl.includes('googlevideo.com') 
              || extractedUrl.includes('videoplayback')
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

            // yt-dlp non-HLS quality options (format switching)
            if (Array.isArray(extraction.qualityLevels)) {
              if (extraction.qualityLevels.length > 0) {
                setQualityLevels(extraction.qualityLevels);
                setSelectedQuality(extraction.selectedQuality || extraction.qualityLevels[0].label);
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
                isHLS = /m3u8/i.test(streamUrl);
                streamHlsRef.current = isHLS;
                httpHeaders = null;
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
              isHLS = /m3u8/i.test(streamUrl);
              streamHlsRef.current = isHLS;
              httpHeaders = null;
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
    
    const videoEl = videoRef.current;
    if (!videoEl) return;

    // Check original video URL for HLS (proxy URL won't have .m3u8)
    const looksHls = streamHlsRef.current || video.isHLS ||
      (typeof video.videoUrl === 'string' && (video.videoUrl.includes('.m3u8') || video.videoUrl.includes('m3u8'))) ||
      (typeof streamUrl === 'string' && streamUrl.includes('m3u8'));
    // IPTV / Web TV channels are practically always HLS, even when the source
    // URL doesn't advertise .m3u8 — force hls.js, then fall back to native if
    // the manifest turns out to be invalid.
    const forceHls = video.sourceSite === 'IPTV' || video.type === 'Web TV';

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
    };
    videoEl.addEventListener('stalled', handleStalled);
    videoEl.addEventListener('playing', handlePlaying);

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
            try { videoEl.currentTime = pos; } catch (e) {}
          }
        }
        videoEl.play().catch(() => {});
      }, { once: true });
    };

    if ((looksHls || forceHls) && Hls.isSupported()) {
      // Use HLS.js for HLS streams
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        bufferLength: 30,
        maxBufferLength: 60
      });
      
      hlsRef.current = hls;
      hls.loadSource(streamUrl);
      hls.attachMedia(videoEl);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        networkRetryRef.current = 0;
        stallCountRef.current = 0;
        if (hls.levels && hls.levels.length) {
          setQualityLevels(hls.levels.map((l, i) => ({
            index: i,
            height: l.height,
            width: l.width,
            bitrate: l.bitrate
          })));
          // Resolve the saved quality preference (auto | max | <num> | height string)
          const savedPref = readPrefs().preferredQuality;
          let lvl = -1;
          if (savedPref === 'max' && hls.levels.length) {
            lvl = hls.levels.length - 1;
          } else if (typeof savedPref === 'number' && savedPref >= 0 && savedPref < hls.levels.length) {
            lvl = savedPref;
          } else {
            const target = typeof savedPref === 'string' && !['auto', 'max'].includes(savedPref)
              ? parseInt(savedPref, 10)
              : NaN;
            if (!isNaN(target)) {
              let exact = -1;
              let below = -1;
              for (let i = 0; i < hls.levels.length; i++) {
                const h = hls.levels[i].height || 0;
                if (h === target && exact === -1) exact = i;
                if (h < target && h > (hls.levels[below]?.height || 0)) below = i;
              }
              lvl = exact !== -1 ? exact : (below !== -1 ? below : hls.levels.length - 1);
            }
          }
          hls.currentLevel = lvl;
          setSelectedQuality(lvl === -1 ? 'auto' : lvl);
        }
        if (pendingSeekRef.current) {
          const pos = pendingSeekRef.current;
          pendingSeekRef.current = null;
          if (shouldResume(pos)) {
            try { videoEl.currentTime = pos; } catch (e) {}
          }
        }
        videoEl.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
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
              // Temporary network blip: recover via startLoad with backoff.
              if (!scheduleRetry(streamUrlRef.current || streamUrl, 'hls')) {
                hls.destroy();
                setStreamError('Network error — playback could not recover: ' + (data.details || ''));
                setHasError(true);
              }
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
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
      }, { once: true });
    }

    return () => {
      videoEl.removeEventListener('stalled', handleStalled);
      videoEl.removeEventListener('playing', handlePlaying);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      videoEl.pause();
      videoEl.src = '';
    };
  }, [streamUrl, isDRM, shouldResume, seekToResume, scheduleRetry, hlsRetryKey]);

  // Handle overlay click (but not on controls)
  const handleOverlayClick = useCallback((e) => {
    if (e.target.closest('video')) return;
    if (e.target.closest('button')) return;
    if (e.target.closest('webview')) return;
    if (e.target.closest('.player-controls-overlay')) return;
    if (e.target.closest('.progress-track')) return;
    if (e.target.closest('.volume-slider')) return;
    if (e.target.closest('.popup-menu')) return;
    if (isControlsVisible) {
      setIsControlsVisible(false);
    } else {
      resetControlsTimeout();
    }
    setMenuOpen(null);
  }, [isControlsVisible, resetControlsTimeout]);

  // Video event handlers
  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => {
    setIsPlaying(false);
    const videoEl = videoRef.current;
    if (videoEl) savePosition(videoEl.currentTime || 0);
  }, [savePosition]);

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    savePosition(0);
    const api = window.api || window.electronAPI;
    api?.setWatchHistory?.({
      id: video.id,
      title: video.videoTitle,
      videoUrl: video.videoUrl,
      watchedAt: new Date().toISOString()
    });
  }, [video, savePosition]);
  
  const handleTimeUpdate = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    setCurrentTime(videoEl.currentTime);
    if (videoEl.duration) setDuration(videoEl.duration);

    // Periodically persist position (throttled to ~5s) for resume support
    const now = Date.now();
    if (now - lastSaveTimeRef.current >= 5000) {
      lastSaveTimeRef.current = now;
      const pos = videoEl.currentTime || 0;
      const dur = videoEl.duration || 0;
      savePosition(pos >= 5 && (dur <= 0 || pos < dur - 10) ? pos : 0);
    }

    const api = window.api || window.electronAPI;
    if (videoEl.currentTime > 30 && !videoEl.dataset.progressTracked) {
      videoEl.dataset.progressTracked = 'true';
      api?.setWatchHistory?.({
        id: video.id,
        title: video.videoTitle,
        videoUrl: video.videoUrl,
        watchedAt: new Date().toISOString()
      });
    }
  }, [video, savePosition]);

  const handleDurationChange = useCallback(() => {
    const videoEl = videoRef.current;
    if (videoEl && videoEl.duration) {
      setDuration(videoEl.duration);
    }
  }, []);

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
        if (scheduleRetry(streamUrlRef.current || video.videoUrl || video.url, 'native')) {
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

      const msg = `Playback error (code ${error.code}): ${error.message || 'Unknown error'}`;
      setStreamError(msg);
      setHasError(true);
    }
  }, [video, scheduleRetry]);

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
      onClick={handleOverlayClick}
      onMouseLeave={() => {
        if (!isPaused) {
          clearControlsTimer();
          setIsControlsVisible(false);
        }
      }}
    >
      <div className="video-player-container">
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
            onClick={togglePlayPause}
            onPlay={handlePlay}
            onPause={handlePause}
            onEnded={handleEnded}
            onTimeUpdate={handleTimeUpdate}
            onDurationChange={handleDurationChange}
            onError={handleError}
            volume={isMuted ? 0 : volume}
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
            {/* Quality menu */}
            {menuOpen === 'quality' && qualityLevels.length > 0 && (
              <div className="popup-menu quality-menu">
                <button 
                  className={`menu-item ${selectedQuality === 'auto' ? 'active' : ''}`}
                  onClick={() => { handleQualityChange('auto'); setMenuOpen(null); }}
                >
                  Auto
                </button>
                {qualityLevels.map((lvl, i) => (
                  <button 
                    key={lvl.formatId || lvl.index || i} 
                    className={`menu-item ${String(selectedQuality) === String(lvl.index) || selectedQuality === lvl.label ? 'active' : ''}`}
                    onClick={() => { handleQualityChange(i); setMenuOpen(null); }}
                  >
                    {lvl.label || (lvl.height ? `${lvl.height}p` : (lvl.width ? `${lvl.width}px` : `Quality ${i}`))}
                    {lvl.bitrate ? ` · ${Math.round(lvl.bitrate / 1000)}kbps` : ''}
                    {!lvl.bitrate && lvl.label && lvl.height ? ` · ${lvl.height}p` : ''}
                  </button>
                ))}
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

            {/* Quality quick presets (HLS only) */}
            {hasHlsLevels && (
              <div className="quality-presets">
                <button className={`quality-chip ${selectedQuality === 'auto' ? 'active' : ''}`} onClick={() => handlePresetChange('auto')}>Auto</button>
                {PRESET_HEIGHTS.map(h => (
                  <button key={h} className={`quality-chip ${currentPresetH() === h ? 'active' : ''}`} onClick={() => handlePresetChange(h)}>
                    {h}p
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
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>

                {/* Time Display */}
                <div className="time-display">
                  <span className="current-time">{formatTime(currentTime)}</span>
                  <span className="time-separator">/</span>
                  <span className="duration-time">{formatTime(duration)}</span>
                </div>

                <div className="controls-spacer" />

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

                {/* Quality */}
                {qualityLevels.length > 0 && (
                  <button 
                    className="control-btn"
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === 'quality' ? null : 'quality'); }}
                    aria-label="Quality settings"
                    title="Quality"
                  >
                    {selectedQuality === 'auto'
                      ? 'Auto'
                      : typeof selectedQuality === 'number'
                        ? `${qualityLevels[selectedQuality]?.height || selectedQuality}p`
                        : selectedQuality}
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