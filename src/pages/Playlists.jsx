import React, { useState, useEffect, useCallback } from 'react';
import MediaCard from '../components/MediaCard.jsx';
import { usePlaylists } from '../contexts/PlaylistsContext.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import './Playlists.css';

const getApi = () => window.api || window.electronAPI;

const toCard = (item) => ({
  id: item.video_id || item.id,
  videoTitle: item.videoTitle || item.title || 'Untitled',
  category: item.category || item.sourceSite || 'Playlist',
  thumbnailUrl: item.thumbnailUrl,
  videoUrl: item.videoUrl,
  duration: item.duration || 0,
  isHLS: false,
  sourceSite: item.sourceSite || '',
  type: 'Playlist',
  isAdult: item.isAdult || 0,
  _playlistItemId: item.id
});

const Playlists = () => {
  const { playlists, loading, create, remove, removeItem } = usePlaylists();
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;

  const [newName, setNewName] = useState('');
  const [activePlaylist, setActivePlaylist] = useState(null);
  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const { open: openPlayback } = usePlayback();
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const loadItems = useCallback(async (playlistId) => {
    const api = getApi();
    if (!api?.getPlaylistItems) return;
    setItemsLoading(true);
    try {
      const res = await api.getPlaylistItems(playlistId);
      if (res?.success) setItems((res.data || []).map(toCard));
    } catch (err) {
      console.error('[Playlists] load items failed:', err);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activePlaylist) loadItems(activePlaylist.id);
  }, [activePlaylist, loadItems]);

  const handleCreate = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const res = await create(name, '');
    if (res?.success) {
      setNewName('');
      showToast('Playlist created');
    } else {
      showToast(res?.error || 'Could not create playlist', 'err');
    }
  };

  const handleDeletePlaylist = async (pl, e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete playlist "${pl.name}"? Its items are removed.`)) return;
    await remove(pl.id);
    if (activePlaylist?.id === pl.id) setActivePlaylist(null);
    showToast('Playlist deleted');
  };

  const handleRemoveItem = async (card, e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!card._playlistItemId) return;
    await removeItem(card._playlistItemId);
    setItems(prev => prev.filter(i => i.id !== card.id));
  };

  const visibleItems = familyMode ? items.filter(i => !isAdultMedia(i)) : items;
  const visiblePlaylists = playlists;

  return (
    <div className="playlists-page">
      <div className="playlists-header">
        <h1 className="page-title">Playlists</h1>
        <p className="playlists-subtitle">Group videos into custom collections. Add items from any card's ⊕ menu.</p>
      </div>

      {/* Create form */}
      <form className="playlists-create" onSubmit={handleCreate}>
        <input
          className="playlists-input"
          placeholder="New playlist name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button className="playlists-btn primary" type="submit" disabled={!newName.trim()}>Create</button>
      </form>

      {/* Playlist grid */}
      {!activePlaylist ? (
        loading ? (
          <div className="playlists-loading">Loading playlists…</div>
        ) : visiblePlaylists.length === 0 ? (
          <div className="playlists-empty">
            <p>No playlists yet.</p>
            <p className="playlists-hint">Create one above, then hover any video card and use ⊕ to add it.</p>
          </div>
        ) : (
          <div className="playlists-grid">
            {visiblePlaylists.map(pl => (
              <div key={pl.id} className="playlist-card" onClick={() => setActivePlaylist(pl)}>
                <div className="playlist-card-icon">🎵</div>
                <div className="playlist-card-info">
                  <div className="playlist-card-name">{pl.name}</div>
                  <div className="playlist-card-meta">
                    {pl.itemCount} items · {pl.description || 'Custom playlist'}
                  </div>
                </div>
                <button className="playlist-card-delete" onClick={(e) => handleDeletePlaylist(pl, e)} title="Delete playlist">×</button>
              </div>
            ))}
          </div>
        )
      ) : (
        <>
          <div className="playlists-crumb">
            <button className="playlists-btn" onClick={() => setActivePlaylist(null)}>← All playlists</button>
            <h2 className="playlists-title">{activePlaylist.name} <span className="playlists-count">{visibleItems.length} items</span></h2>
          </div>

          {itemsLoading ? (
            <div className="playlists-loading">Loading items…</div>
          ) : visibleItems.length === 0 ? (
            <div className="playlists-empty">
              <p>No items in this playlist.</p>
              <p className="playlists-hint">Use ⊕ on any video card to add it here.</p>
            </div>
          ) : (
            <div className="playlists-folder-grid">
              {visibleItems.map(card => (
                <div key={card.id + card._playlistItemId} className="playlist-item-wrap">
                  <button
                    className="playlist-remove"
                    onClick={(e) => handleRemoveItem(card, e)}
                    title="Remove from playlist"
                  >✕</button>
                  <MediaCard
                    video={card}
                    onSelectVideo={openPlayback}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {toast && <div className={`playlists-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
};

export default Playlists;