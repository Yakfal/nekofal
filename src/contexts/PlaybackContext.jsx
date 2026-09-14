import React, { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoPlayer from '../components/VideoPlayer.jsx';
import { usePlaylists } from './PlaylistsContext.jsx';
import { installMediaKeyBridge } from '../utils/mediaKeys.js';
import './Playback.css';

const SUPPORTED_EXT = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.flac', '.wav', '.ogg', '.aac', '.m3u8'];

const PlaybackContext = createContext({
  activeVideo: null,
  open: () => {},
  close: () => {}
});

export const PlaybackProvider = ({ children }) => {
  const [activeVideo, setActiveVideo] = useState(null);
  const [activeChannels, setActiveChannels] = useState(null);
  const [activeChannelIndex, setActiveChannelIndex] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [saveMenuVideo, setSaveMenuVideo] = useState(null);
  const [newPlaylistName, setNewPlaylistName] = useState('');
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

  const value = useMemo(() => ({ activeVideo, open, close }), [activeVideo, open, close]);

  return (
    <PlaybackContext.Provider value={value}>
      {children}

      {activeVideo && (
        <VideoPlayer
          video={activeVideo}
          onClose={close}
          channelList={activeChannels}
          channelIndex={activeChannelIndex}
          onZapTo={zapTo}
        />
      )}

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
};

export const usePlayback = () => useContext(PlaybackContext);

export default PlaybackContext;