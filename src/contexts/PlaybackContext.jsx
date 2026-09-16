import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaylists } from './PlaylistsContext.jsx';
import { installMediaKeyBridge } from '../utils/mediaKeys.js';
import { isPageUrl, isDirectMediaUrl } from '../services/dbAdapter.js';
import { isYouTubeUrl, getYouTubeVideoId, canonicalYouTubePageUrl, recoveredYouTubeWatchUrl } from '../services/customScraper.js';
import './Playback.css';

const SUPPORTED_EXT = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.m3u8'];

// ---- Canonical media normalization ------------------------------------------
// YouTube watch URLs rotate between /watch?v=, youtu.be/ID and googlevideo CDN
// streams. Favorites/history persist a canonical page URL so the item stays
// re-extractable forever. Every video that reaches the player guarantees
// { title, thumbnail, provider, pageUrl }.
const YT_WATCH_RE = /youtube\.com\/watch\?/i;

function isYouTubeMedia(media) {
  if (!media) return false;
  return isYouTubeUrl(
    String(media.pageUrl || media.webUrl || media.videoUrl || media.url || media.streamUrl || '')
  );
}

function normalizePlaybackMedia(media) {
  if (!media) return null;
  const raw = String(media.videoUrl || media.url || media.streamUrl || '').trim();
  let pageUrl = String(media.pageUrl || media.webUrl || '').trim();
  // Legacy CDN recovery: old versions stored googlevideo CDN links as the page
  // or the stream. Rebuild the canonical watch page from docid/id so the item
  // re-extracts cleanly instead of throwing a media format error at the dead
  // signed URL.
  const recovered = recoveredYouTubeWatchUrl(pageUrl) || recoveredYouTubeWatchUrl(raw);
  if (recovered) pageUrl = recovered;
  const isYT = isYouTubeMedia(media) || !!recovered;
  if (isYT && pageUrl && !YT_WATCH_RE.test(pageUrl)) {
    const id = getYouTubeVideoId(pageUrl) || getYouTubeVideoId(raw);
    if (id) pageUrl = canonicalYouTubePageUrl(`https://www.youtube.com/watch?v=${id}`);
  } else if (isYT && !pageUrl) {
    const id = getYouTubeVideoId(raw);
    pageUrl = id ? `https://www.youtube.com/watch?v=${id}` : raw;
  }
  const title = media.videoTitle || media.title || 'Unknown Video';
  const thumbnail = media.thumbnailUrl || media.poster || media.thumbnail || '';
  const provider = isYT
    ? 'youtube'
    : (media.provider
        ? String(media.provider)
        : (media.sourceSite ? String(media.sourceSite).split('.')[0].toLowerCase() : ''));
  return {
    ...media,
    title,
    videoTitle: media.videoTitle || media.title || 'Unknown Video',
    thumbnail,
    thumbnailUrl: thumbnail || media.thumbnailUrl || '',
    provider,
    pageUrl
  };
}

const PlaybackContext = createContext({
  activeVideo: null,
  activeChannels: null,
  activeChannelIndex: null,
  open: () => {},
  playVideo: () => {},
  close: () => {},
  zapTo: () => {},
  resolving: null,
  setMediaSession: () => {}
});

export function PlaybackProvider({ children }) {
  const [activeVideo, setActiveVideo] = useState(null);
  const [activeChannels, setActiveChannels] = useState(null);
  const [activeChannelIndex, setActiveChannelIndex] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [saveMenuVideo, setSaveMenuVideo] = useState(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [resolving, setResolving] = useState(null);
  const dragDepthRef = useRef(0);
  const mediaPayloadRef = useRef(null);
  const { playlists, addItem, create } = usePlaylists();

  // ---- Native OS media controls (Web MediaSession) + auto-mini state -------
  // Windows 10/11 surfaces Chromium's MediaSession as system media flyouts when
  // the window is backgrounded/minimized. This context owns the session: the
  // mounted player just reports the current metadata/playback state through
  // setMediaSession(). Window minimize is handled in the main process, which
  // forwards the latest payload to float to the MiniPlayer.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return undefined;
    const ms = navigator.mediaSession;
    const cmd = (detail, seekTime) => {
      window.dispatchEvent(new CustomEvent('nek-media-command', {
        detail: seekTime != null ? { command: detail, seekTime } : { command: detail }
      }));
    };
    const trySet = (name, handler) => {
      try { ms.setActionHandler(name, handler); } catch (err) { /* unsupported action */ }
    };
    trySet('play', () => cmd('play'));
    trySet('pause', () => cmd('pause'));
    trySet('seekto', (d) => cmd('seekto', d && typeof d.seekTime === 'number' ? d.seekTime : null));
    trySet('previoustrack', () => cmd('previous'));
    trySet('nexttrack', () => cmd('next'));
    trySet('seekbackward', () => cmd('previous'));
    trySet('seekforward', () => cmd('next'));
    return () => {
      trySet('play', null);
      trySet('pause', null);
      trySet('seekto', null);
      trySet('previoustrack', null);
      trySet('nexttrack', null);
      trySet('seekbackward', null);
      trySet('seekforward', null);
    };
  }, []);

  // Publish playback state to navigator.mediaSession (OS media flyout) AND keep
  // the main process topped-up with the latest mini-player payload so it can
  // auto-float on window minimize. info === null clears everything.
  const setMediaSession = useCallback((info) => {
    const api = window.api || window.electronAPI;
    const active = !!(info && info.active);
    if (active) {
      const payload = {
        mode: info.mode === 'audio' ? 'audio' : 'video',
        title: String(info.title || 'Nekofal'),
        streamUrl: String(info.streamUrl || ''),
        streamHls: !!info.streamHls,
        poster: String(info.poster || ''),
        currentTime: Math.max(0, Number(info.position) || 0),
        volume: Number.isFinite(Number(info.volume)) ? Number(info.volume) : 1,
        muted: !!info.muted,
        videoId: info.videoId != null ? info.videoId : null,
        isLocal: !!info.isLocal
      };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== mediaPayloadRef.current) {
        mediaPayloadRef.current = fingerprint;
        api?.mediaActive?.({ active: true, payload });
      }
    } else {
      if (mediaPayloadRef.current) {
        mediaPayloadRef.current = null;
        api?.mediaActive?.({ active: false });
      }
    }

    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      if (!active) {
        ms.metadata = null;
        ms.playbackState = 'none';
        try { ms.setPositionState && ms.setPositionState({ duration: 0, playbackRate: 1, position: 0 }); } catch (err) {}
        return;
      }
      const artwork = Array.isArray(info.artwork)
        ? info.artwork.filter((a) => a && a.src)
        : ([{ src: '', sizes: '512x512', type: 'image/jpeg' }].filter((a) => a.src));
      try {
        ms.metadata = new MediaMetadata({
          title: String(info.title || 'Nekofal'),
          artist: String(info.artist || ''),
          album: String(info.album || 'Nekofal'),
          artwork
        });
      } catch (err) { /* some metadata fields unsupported */ }
      ms.playbackState = info.playing ? 'playing' : 'paused';
      const dur = Number(info.duration) || 0;
      if (dur > 0 && typeof ms.setPositionState === 'function') {
        try {
          ms.setPositionState({
            duration: dur,
            playbackRate: Number(info.rate) || 1,
            position: Math.min(Math.max(Number(info.position) || 0, 0), dur)
          });
        } catch (err) { /* position out of range */ }
      }
    } catch (err) {
      console.warn('[Playback] MediaSession update failed:', err.message);
    }
  }, []);

  // Forward global media keys to whichever player is currently mounted
  useEffect(() => {
    const unsub = installMediaKeyBridge();
    return () => { if (unsub) unsub(); };
  }, []);

  const close = useCallback(() => {
    setActiveVideo(null);
    setActiveChannels(null);
    setActiveChannelIndex(null);
    setSaveMenuVideo(null);
    setNewPlaylistName('');
  }, []);

  // Zap to an adjacent channel: swap the active video (VideoPlayer reloads on
  // the prop change) while keeping the zapping list/index in sync.
  const zapTo = useCallback((video, index) => {
    if (!video) return;
    setActiveVideo(video);
    if (Number.isInteger(index)) setActiveChannelIndex(index);
  }, []);

  const open = useCallback((video, opts = {}) => {
    const normed = normalizePlaybackMedia(video);
    if (!normed) return;
    setActiveVideo(normed);
    if (Array.isArray(opts.channels) && opts.channels.length > 0) {
      setActiveChannels(opts.channels);
      const fromIndex = Number.isInteger(opts.channelIndex)
        ? opts.channelIndex
        : opts.channels.findIndex(
            (c) => c && (c.id === normed.id || (c.videoUrl && c.videoUrl === normed.videoUrl))
          );
      setActiveChannelIndex(fromIndex >= 0 ? fromIndex : 0);
    } else {
      setActiveChannels(null);
      setActiveChannelIndex(null);
    }
    if (opts.viaDrop) {
      setSaveMenuVideo(normed);
      setNewPlaylistName('');
    } else {
      setSaveMenuVideo(null);
    }
  }, []);

  // ----- Dynamic stream re-extraction pipeline ------------------------------
  // Favorites/history now persist canonical metadata (id/title/pageUrl) — NOT
  // ephemeral CDN stream URLs. When a saved item is missing its stream or its
  // stored stream is just a page to re-extract, resolve a fresh stream BEFORE
  // mounting the player and surface a "Fetching stream…" indicator. Direct
  // media (files, IPTV, radio) and page-URL items play exactly as before —
  // VideoPlayer does its own extraction for plain web pages.
  const playVideo = useCallback(async (video, opts = {}) => {
    const media = normalizePlaybackMedia(video);
    if (!media) return;
    const api = window.api || window.electronAPI;
    const raw = String(media.videoUrl || media.url || media.streamUrl || '').trim();
    const explicitPage = String(media.pageUrl || media.webUrl || '').trim();
    const pageUrl = explicitPage || ((raw && isPageUrl(raw)) ? raw : '');
    // Re-extract only when a page is known AND the stream is absent, when an
    // explicit page is paired with a (possibly stale) direct stream URL, or
    // when the stored stream is a legacy googlevideo CDN link that was just
    // rebuilt into a canonical watch page (stale signed URLs must never be
    // played as-is — they reject with a media format error).
    const legacyCdnStream = /googlevideo\.com/i.test(raw);
    const needsReextract = !!pageUrl && (legacyCdnStream || !raw || (isDirectMediaUrl(raw) && explicitPage));

    if (!needsReextract) {
      setResolving(null);
      open(media, opts);
      return;
    }

    setResolving({ title: media.videoTitle || media.title || 'video' });
    try {
      const result = await api.extractStream(String(pageUrl));
      const extraction = result && result.success && (result.data?.videoUrl || result.streamUrl)
        ? (result.data?.videoUrl ? result.data : { videoUrl: result.streamUrl, isHLS: !!result.isHls, httpHeaders: null })
        : null;
      if (extraction && extraction.videoUrl) {
        open({
          ...media,
          videoUrl: extraction.videoUrl,
          isHLS: extraction.isHLS || media.isHLS || false,
          httpHeaders: extraction.httpHeaders || media.httpHeaders || null,
          formats: (Array.isArray(extraction.formats) && extraction.formats.length) ? extraction.formats : media.formats,
          qualityLevels: (Array.isArray(extraction.qualityLevels) && extraction.qualityLevels.length) ? extraction.qualityLevels : media.qualityLevels
        }, opts);
        return;
      }
      // Extraction yielded nothing usable — open anyway so VideoPlayer can
      // surface the precise error (or sniff) instead of a silent dead-end.
    } catch (err) {
      console.warn('[Playback] Fresh-stream extraction failed:', err);
    } finally {
      setResolving(null);
    }
    open(media, opts);
  }, [open]);

  // Restore from the floating mini player: resume full playback in the main
  // window with the exact state (position, volume, mute) the mini window had.
  useEffect(() => {
    const api = window.api || window.electronAPI;
    if (!api?.onMainOpenFromMini) return undefined;
    const unsub = api.onMainOpenFromMini((data) => {
      if (!data || !data.streamUrl) return;
      const restored = {
        id: data.videoId != null ? data.videoId : `mini-restore-${Date.now()}`,
        videoTitle: data.title || 'Video',
        title: data.title || 'Video',
        videoUrl: data.streamUrl,
        thumbnailUrl: data.poster || '',
        isHLS: !!data.streamHls,
        isLocal: !!data.isLocal,
        sourceSite: data.isLocal ? 'Local File' : 'Mini Player',
        lastPosition: Number(data.currentTime) || 0,
        startVolume: Number.isFinite(Number(data.volume)) ? Number(data.volume) : 1,
        startMuted: !!data.muted
      };
      open(restored, {});
    });
    return () => { if (unsub) unsub(); };
  }, [open]);

  // Main process requested an auto-Float (window minimized during playback):
  // forward to the mounted player, which reports its live stream payload,
  // opens the MiniPlayer and closes itself (no double audio).
  useEffect(() => {
    const api = window.api || window.electronAPI;
    if (!api?.onRequestMini) return undefined;
    const unsub = api.onRequestMini(() => {
      window.dispatchEvent(new CustomEvent('nek-float-to-mini'));
    });
    return () => { if (unsub) unsub(); };
  }, []);

  const isSupportedFile = useCallback((file) => {
    const name = (file && file.name) || '';
    const lower = name.toLowerCase();
    return SUPPORTED_EXT.some(ext => lower.endsWith(ext));
  }, []);

  const handleDrop = useCallback((e) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const media = files.filter(isSupportedFile);
    if (!media.length) return;

    // Take the first supported file as the primary item
    const file = media[0];
    const path = file.path || '';
    const name = file.name || 'Local file';
    const key = `local-${Date.now()}-${encodeURIComponent(name)}`;

    const videoPayload = {
      id: key,
      videoTitle: name.replace(/\.[^.]+$/, ''),
      title: name.replace(/\.[^.]+$/, ''),
      videoUrl: path,
      thumbnailUrl: '',
      duration: 0,
      isHLS: name.toLowerCase().endsWith('.m3u8'),
      sourceSite: 'Local File',
      category: 'Local Media',
      type: 'Local File',
      isAdult: 0,
      isLocal: true
    };

    open(videoPayload, { viaDrop: true });
  }, [isSupportedFile, open]);

  useEffect(() => {
    const onDragOver = (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setDragActive(true);
    };
    const onDragEnter = (e) => {
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onDragLeave = (e) => {
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (e) => { e.preventDefault(); handleDrop(e); };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleDrop]);

  const handleSaveToPlaylist = async (playlistId) => {
    if (!saveMenuVideo) return;
    const v = {
      id: saveMenuVideo.id,
      title: saveMenuVideo.videoTitle || saveMenuVideo.title,
      videoUrl: saveMenuVideo.videoUrl,
      thumbnailUrl: saveMenuVideo.thumbnailUrl || '',
      duration: saveMenuVideo.duration || 0,
      sourceSite: saveMenuVideo.sourceSite || 'Local File',
      category: saveMenuVideo.category || 'Local Media'
    };
    await addItem(playlistId, v);
    setSaveMenuVideo(null);
  };

  const handleCreateAndSave = async () => {
    const name = newPlaylistName.trim();
    if (!name || !saveMenuVideo) return;
    const res = await create(name, '');
    if (res?.success && res.playlist?.id) {
      await handleSaveToPlaylist(res.playlist.id);
    }
  };

  const value = useMemo(
    () => ({ activeVideo, activeChannels, activeChannelIndex, open, playVideo, close, zapTo, resolving, setMediaSession }),
    [activeVideo, activeChannels, activeChannelIndex, open, playVideo, close, zapTo, resolving, setMediaSession]
  );

  return (
    <PlaybackContext.Provider value={value}>
      {children}

      {dragActive && (
        <div className="drop-overlay">
          <div className="drop-overlay-box">
            <div className="drop-overlay-icon">↧</div>
            <div className="drop-overlay-title">Drop to play</div>
            <div className="drop-overlay-hint">mp4 · mkv · webm · mov · avi · mp3 · flac · m3u8</div>
          </div>
        </div>
      )}

      {saveMenuVideo && (
        <div className="save-panel">
          <div className="save-panel-title">Save to playlist? “{saveMenuVideo.videoTitle || saveMenuVideo.title}”</div>
          {playlists.length === 0 && <div className="playlist-menu-empty">No playlists yet.</div>}
          {playlists.map(p => (
            <button key={p.id} className="playlist-menu-item" onClick={() => handleSaveToPlaylist(p.id)}>
              {p.name}
              <span className="playlist-menu-count">{p.itemCount}</span>
            </button>
          ))}
          <div className="playlist-menu-new">
            <input
              className="playlist-menu-input"
              placeholder="New playlist…"
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAndSave(); }}
            />
            <button className="playlist-menu-create" onClick={handleCreateAndSave}>+</button>
          </div>
          <button className="save-panel-dismiss" onClick={() => setSaveMenuVideo(null)}>Dismiss</button>
        </div>
      )}
    </PlaybackContext.Provider>
  );
}

export function usePlayback() { return useContext(PlaybackContext); }

export default PlaybackContext;