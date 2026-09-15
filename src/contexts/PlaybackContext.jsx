import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlaylists } from './PlaylistsContext.jsx';
import { installMediaKeyBridge } from '../utils/mediaKeys.js';
import { isPageUrl, isDirectMediaUrl } from '../services/dbAdapter.js';
import './Playback.css';

const SUPPORTED_EXT = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.m3u8'];

const PlaybackContext = createContext({
  activeVideo: null,
  activeChannels: null,
  activeChannelIndex: null,
  open: () => {},
  playVideo: () => {},
  close: () => {},
  zapTo: () => {},
  resolving: null
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
  const { playlists, addItem, create } = usePlaylists();

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
    if (!video) return;
    setActiveVideo(video);
    if (Array.isArray(opts.channels) && opts.channels.length > 0) {
      setActiveChannels(opts.channels);
      const fromIndex = Number.isInteger(opts.channelIndex)
        ? opts.channelIndex
        : opts.channels.findIndex(
            (c) => c && (c.id === video.id || (c.videoUrl && c.videoUrl === video.videoUrl))
          );
      setActiveChannelIndex(fromIndex >= 0 ? fromIndex : 0);
    } else {
      setActiveChannels(null);
      setActiveChannelIndex(null);
    }
    if (opts.viaDrop) {
      setSaveMenuVideo(video);
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
    if (!video) return;
    const api = window.api || window.electronAPI;
    const raw = String(video.videoUrl || video.url || video.streamUrl || '').trim();
    const explicitPage = String(video.pageUrl || video.webUrl || '').trim();
    const pageUrl = explicitPage || ((raw && isPageUrl(raw)) ? raw : '');
    // Re-extract only when a page is known AND the stream is absent, or when an
    // explicit page is paired with a (possibly stale) direct stream URL.
    const needsReextract = !!pageUrl && (!raw || (isDirectMediaUrl(raw) && explicitPage));

    if (!needsReextract) {
      setResolving(null);
      open(video, opts);
      return;
    }

    setResolving({ title: video.videoTitle || video.title || 'video' });
    try {
      const result = await api.extractStream(String(pageUrl));
      const extraction = result && result.success && (result.data?.videoUrl || result.streamUrl)
        ? (result.data?.videoUrl ? result.data : { videoUrl: result.streamUrl, isHLS: !!result.isHls, httpHeaders: null })
        : null;
      if (extraction && extraction.videoUrl) {
        open({
          ...video,
          videoUrl: extraction.videoUrl,
          isHLS: extraction.isHLS || video.isHLS || false,
          httpHeaders: extraction.httpHeaders || video.httpHeaders || null
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
    open(video, opts);
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

  // ---- Local file drag & drop ----
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
    () => ({ activeVideo, activeChannels, activeChannelIndex, open, playVideo, close, zapTo, resolving }),
    [activeVideo, activeChannels, activeChannelIndex, open, playVideo, close, zapTo, resolving]
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