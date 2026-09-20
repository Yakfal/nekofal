import React, { useState, useEffect, useCallback, useMemo } from 'react';
import MediaCard from '../components/MediaCard.jsx';
import { usePlaylists } from '../contexts/PlaylistsContext.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import './Playlists.css';

const getApi = () => window.api || window.electronAPI;

const toCard = (item) => ({
  id: item.video_id || item.id,
  videoTitle: item.videoTitle || item.title || 'Untitled',
  category: item.category || item.sourceSite || 'Playlist',
  thumbnailUrl: item.thumbnailUrl,
  videoUrl: item.videoUrl,
  pageUrl: item.pageUrl || '',
  duration: item.duration || 0,
  isHLS: false,
  sourceSite: item.sourceSite || '',
  type: 'Playlist',
  isAdult: item.isAdult || 0,
  _playlistItemId: item.id
});

const videoToCard = (v) => ({
  id: v.id,
  videoTitle: v.title || v.videoTitle || 'Untitled',
  category: v.category || v.sourceSite || 'Mix',
  thumbnailUrl: v.thumbnailUrl,
  videoUrl: v.videoUrl,
  pageUrl: v.pageUrl || '',
  duration: v.duration || 0,
  isHLS: !!v.isHLS,
  sourceSite: v.sourceSite || '',
  type: 'Mix',
  isAdult: v.isAdult || 0
});

const favoriteToCard = (f) => ({
  id: f.id,
  videoTitle: f.title || f.videoTitle || 'Untitled',
  category: f.sourceSite || 'Favorites',
  thumbnailUrl: f.thumbnailUrl,
  videoUrl: f.videoUrl || f.pageUrl || '',
  pageUrl: f.pageUrl || '',
  duration: f.duration || 0,
  isHLS: false,
  sourceSite: f.sourceSite || '',
  type: 'Favorite',
  isAdult: f.isAdult || 0
});

const shuffle = (list) => {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

const Playlists = () => {
  const { playlists, loading, create, remove, removeItem } = usePlaylists();
  const { settings } = useAppSettings();
  const { t } = useLanguage();
  const familyMode = settings.familyMode;

  const [newName, setNewName] = useState('');
  const [activePlaylist, setActivePlaylist] = useState(null);
  const [activeSmart, setActiveSmart] = useState(null);
  const [items, setItems] = useState([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const { playVideo } = usePlayback();
  const [toast, setToast] = useState(null);
  const [smart, setSmart] = useState({ dailyMix: [], favorites: [], loading: true });

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  // Build the auto-generated dynamic playlists from local history + favorites +
  // library. Daily Mix seeds off the genres of recently watched items; when
  // there is no history yet it falls back to the most populated library genres.
  useEffect(() => {
    let alive = true;
    const build = async () => {
      const api = getApi();
      const [historyRes, favRes, videosRes] = await Promise.all([
        api?.getWatchHistory ? api.getWatchHistory().catch(() => null) : null,
        api?.getFavorites ? api.getFavorites().catch(() => null) : null,
        api?.getVideos ? api.getVideos(400, 0).catch(() => null) : null
      ]);
      if (!alive) return;

      const history = (historyRes?.success && Array.isArray(historyRes.data)) ? historyRes.data : [];
      const favorites = (favRes?.success && Array.isArray(favRes.data)) ? favRes.data : [];
      const videos = (videosRes?.success && Array.isArray(videosRes.data)) ? videosRes.data : [];

      const byUrl = new Map();
      const byId = new Map();
      videos.forEach((v) => {
        if (v.videoUrl) byUrl.set(v.videoUrl, v);
        if (v.id) byId.set(v.id, v);
      });

      const catCount = {};
      history.forEach((h) => {
        const match = byUrl.get(h.videoUrl) || byId.get(h.id) || videos.find((v) => v.videoUrl === h.videoUrl || v.id === h.id);
        if (match?.category) catCount[match.category] = (catCount[match.category] || 0) + 1;
      });

      let cats = Object.entries(catCount).sort((a, b) => b[1] - a[1]).map(([c]) => c);
      if (cats.length === 0) {
        const overall = {};
        videos.forEach((v) => { if (v.category) overall[v.category] = (overall[v.category] || 0) + 1; });
        cats = Object.entries(overall).sort((a, b) => b[1] - a[1]).map(([c]) => c);
      }

      const topCats = new Set(cats.slice(0, 4));
      let picks = videos.filter((v) => v.category && topCats.has(v.category));
      if (picks.length < 8) picks = videos;
      const dailyMix = shuffle(picks).slice(0, 30).map(videoToCard);

      setSmart({
        dailyMix,
        favorites: favorites.map(favoriteToCard).filter((f) => f.videoUrl || f.pageUrl),
        loading: false
      });
    };
    build();
    const onSync = () => build();
    window.addEventListener('scrapers-synced', onSync);
    window.addEventListener('favorites-synced', onSync);
    return () => {
      alive = false;
      window.removeEventListener('scrapers-synced', onSync);
      window.removeEventListener('favorites-synced', onSync);
    };
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

  const openSmart = useCallback((id) => {
    const isDaily = id === 'daily-mix';
    const list = isDaily ? [...smart.dailyMix] : shuffle(smart.favorites);
    setActivePlaylist(null);
    setItems(list);
    setItemsLoading(false);
    setActiveSmart({ id, name: isDaily ? 'Daily Mix' : 'Favorites Shuffle', items: list });
  }, [smart.dailyMix, smart.favorites]);

  const openCustom = (pl) => {
    setActiveSmart(null);
    setActivePlaylist(pl);
  };

  const backToAll = () => {
    setActivePlaylist(null);
    setActiveSmart(null);
  };

  const playAll = () => {
    const queue = visibleItems.filter((v) => v.videoUrl || v.pageUrl);
    if (queue.length === 0) { showToast('Nothing to play yet', 'err'); return; }
    playVideo(queue[0], { channels: queue, channelIndex: 0 });
  };

  const visibleItems = familyMode ? items.filter(i => !isAdultMedia(i)) : items;
  const visiblePlaylists = playlists;

  return (
    <div className="playlists-page">
      <div className="playlists-header">
        <h1 className="page-title">{t('nav.mixes')}</h1>
        <p className="playlists-subtitle">Auto-generated mixes plus your own collections. Add items from any card's ⊕ menu.</p>
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
      {!activePlaylist && !activeSmart ? (
        loading ? (
          <div className="playlists-loading">Loading playlists…</div>
        ) : (
          <div className="playlists-grid">
            <div
              className="playlist-card smart daily"
              onClick={() => openSmart('daily-mix')}
              title="Auto-mixed from your most-played genres"
            >
              <div className="playlist-card-icon">☀️</div>
              <div className="playlist-card-info">
                <div className="playlist-card-name">Daily Mix</div>
                <div className="playlist-card-meta">
                  {smart.loading ? 'Building…' : `${smart.dailyMix.length} items`} · Auto from your most-played genres
                </div>
              </div>
            </div>

            <div
              className="playlist-card smart favorites"
              onClick={() => openSmart('favorites-shuffle')}
              title="Continuous play of all saved items"
            >
              <div className="playlist-card-icon">🔀</div>
              <div className="playlist-card-info">
                <div className="playlist-card-name">Favorites Shuffle</div>
                <div className="playlist-card-meta">
                  {smart.loading ? 'Building…' : `${smart.favorites.length} items`} · Continuous play of saved items
                </div>
              </div>
            </div>

            {visiblePlaylists.map(pl => (
              <div key={pl.id} className="playlist-card" onClick={() => openCustom(pl)}>
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

            {visiblePlaylists.length === 0 && (
              <div className="playlists-hint-card">
                <p>No custom playlists yet.</p>
                <p className="playlists-hint">Create one above, then hover any video card and use ⊕ to add it.</p>
              </div>
            )}
          </div>
        )
      ) : (
        <>
          <div className="playlists-crumb">
            <button className="playlists-btn" onClick={backToAll}>← All mixes</button>
            <h2 className="playlists-title">
              {(activeSmart?.name || activePlaylist?.name)}
              <span className="playlists-count">{visibleItems.length} items</span>
            </h2>
            <button className="playlists-btn primary" onClick={playAll} disabled={visibleItems.length === 0}>
              ▶ Play all
            </button>
          </div>

          {itemsLoading ? (
            <div className="playlists-loading">Loading items…</div>
          ) : visibleItems.length === 0 ? (
            <div className="playlists-empty">
              <p>No items here yet.</p>
              <p className="playlists-hint">
                {activeSmart ? 'Save some favorites or watch a few videos and this mix fills itself.' : 'Use ⊕ on any video card to add it here.'}
              </p>
            </div>
          ) : (
            <div className="playlists-folder-grid">
              {visibleItems.map(card => (
                <div key={card.id + (card._playlistItemId || '')} className="playlist-item-wrap">
                  {!activeSmart && (
                    <button
                      className="playlist-remove"
                      onClick={(e) => handleRemoveItem(card, e)}
                      title="Remove from playlist"
                    >✕</button>
                  )}
                  <MediaCard
                    video={card}
                    onSelectVideo={playVideo}
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
