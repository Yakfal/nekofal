import React, { useState, useEffect, useCallback, useMemo } from 'react';
import MediaCard from '../components/MediaCard.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { autoSync, getMediaId } from '../services/dbAdapter.js';
import isAdultMedia from '../utils/contentSafety.js';
import './IPTV.css';

const getApi = () => window.api || window.electronAPI;

const toCard = (item) => ({
  id: item.id,
  videoTitle: item.title,
  title: item.title,
  category: item.category || 'Uncategorized',
  thumbnailUrl: item.thumbnailUrl,
  videoUrl: item.videoUrl,
  duration: item.duration || 0,
  isHLS: !!item.httpHeaders || /(\.m3u8|m3u8)/i.test(item.videoUrl || ''),
  sourceSite: 'IPTV',
  type: 'Web TV',
  groupTitle: item.category,
  httpHeaders: item.httpHeaders,
  lastPosition: item.lastPosition || 0,
  isAdult: item.isAdult || 0
});

// Channels are HLS streams masquerading as random extensions; always treat as direct/stream
const IPTV = () => {
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;
  const [sources, setSources] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeFolder, setActiveFolder] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const { open: openPlayback } = usePlayback();
  const [toast, setToast] = useState(null);
  const [refreshId, setRefreshId] = useState(null);
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());

  // Load favorite ids once so each channel card shows the real DB state and
  // toggles update the grid immediately (same IPC path as every other surface).
  useEffect(() => {
    const api = getApi();
    if (!api?.getFavorites) return undefined;
    let alive = true;
    api.getFavorites()
      .then((res) => {
        if (alive && res?.success && Array.isArray(res.data)) {
          setFavoriteSet(new Set(res.data.map(r => getMediaId(r)).filter(Boolean)));
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const handleToggleFavorite = (mediaKey, isFav) => {
    setFavoriteSet((prev) => {
      const next = new Set(prev);
      if (isFav === true) next.add(mediaKey);
      else if (isFav === false) next.delete(mediaKey);
      return next;
    });
  };

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApi();
      if (!api?.getIptvSources) { setLoading(false); return; }
      const src = await api.getIptvSources();
      if (src?.success) setSources(src.data || []);
      const ch = await api.getVideosBySource('IPTV');
      if (ch?.success) setChannels((ch.data || []).map(toCard));
    } catch (err) {
      console.error('[IPTV] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const onSynced = () => loadAll();
    window.addEventListener('scrapers-synced', onSynced);
    return () => window.removeEventListener('scrapers-synced', onSynced);
  }, [loadAll]);

  const groups = useMemo(() => {
    const g = {};
    channels
      .filter(c => familyMode ? !isAdultMedia(c) : true)
      .forEach(c => {
        const key = c.groupTitle || 'Uncategorized';
        if (!g[key]) g[key] = [];
        g[key].push(c);
      });
    return g;
  }, [channels, familyMode]);

  const folderList = useMemo(() =>
    Object.entries(groups).sort((a, b) => b[1].length - a[1].length),
  [groups]);

  const activeChannels = activeFolder ? groups[activeFolder] || [] : [];

  const handleAdd = async (e) => {
    e.preventDefault();
    const u = url.trim();
    if (!u || !/^https?:\/\//i.test(u)) { showToast('Enter a valid http(s) playlist URL', 'err'); return; }
    setAdding(true);
    try {
      const api = getApi();
      const res = await api.addIptvSource(name.trim() || 'IPTV Playlist', u);
      if (res?.success) {
        showToast(`Imported ${res.inserted} channels`);
        setName(''); setUrl(''); setAddOpen(false);
        autoSync();
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        showToast(res?.error || 'Import failed', 'err');
      }
    } catch (err) {
      showToast('Import failed: ' + err.message, 'err');
    } finally {
      setAdding(false);
    }
  };

  const handleRefresh = async (src) => {
    setRefreshId(src.id);
    try {
      const api = getApi();
      const res = await api.addIptvSource(src.name, src.url);
      showToast(res?.success ? `Refreshed (${res.inserted} channels)` : (res?.error || 'Refresh failed'), res?.success ? 'ok' : 'err');
      if (res?.success) {
        autoSync();
        window.dispatchEvent(new Event('scrapers-synced'));
      }
    } catch (err) {
      showToast('Refresh failed: ' + err.message, 'err');
    } finally {
      setRefreshId(null);
    }
  };

  const handleRemove = async (src) => {
    try {
      const api = getApi();
      await api.removeIptvSource(src.id);
      showToast(`Removed ${src.name}`);
      window.dispatchEvent(new Event('scrapers-synced'));
    } catch (err) {
      showToast('Remove failed', 'err');
    }
  };

  return (
    <div className="iptv-page">
      <div className="iptv-header">
        <h1>IPTV / Live TV</h1>
        <p>Import any M3U playlist — every channel is saved and organized by category automatically.</p>
      </div>

      {/* Source bar */}
      <div className="iptv-sources">
        {sources.length === 0 && !loading && (
          <span className="iptv-empty-hint">No playlists yet — add your first M3U/M3U8 below.</span>
        )}
        {sources.map(s => (
          <div key={s.id} className="iptv-source">
            <div className="iptv-source-info">
              <strong>{s.name}</strong>
              <span className="iptv-source-url">{s.channelCount} channels · {s.url}</span>
            </div>
            <button className="iptv-mini" onClick={() => handleRefresh(s)} disabled={refreshId === s.id}>
              {refreshId === s.id ? 'Refreshing…' : '⟳ Refresh'}
            </button>
            <button className="iptv-mini danger" onClick={() => handleRemove(s)}>×</button>
          </div>
        ))}
        <button className="iptv-addsource" onClick={() => setAddOpen(o => !o)}>
          {addOpen ? '− Hide' : '+ Add Playlist'}
        </button>
      </div>

      {addOpen && (
        <form className="iptv-addform" onSubmit={handleAdd}>
          <input className="iptv-input" placeholder="Name (optional)" value={name} onChange={e => setName(e.target.value)} />
          <input className="iptv-input" placeholder="https://example.com/playlist.m3u" value={url} onChange={e => setUrl(e.target.value)} />
          <button className="iptv-btn primary" disabled={adding}>{adding ? 'Loading…' : 'Import channels'}</button>
        </form>
      )}

      {/* Category folders */}
      {!loading && !activeFolder && folderList.length > 0 && (
        <div className="iptv-folders">
          <h2 className="iptv-h2">
            Categories <span className="iptv-count">{channels.length} channels</span>
          </h2>
          <div className="iptv-folder-grid">
            {folderList.map(([name, list]) => (
              <button key={name} className="iptv-folder" onClick={() => setActiveFolder(name)}>
                <span className="iptv-folder-icon">📺</span>
                <span className="iptv-folder-name">{name}</span>
                <span className="iptv-folder-count">{list.length} channels</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Channels in folder */}
      {activeFolder && (
        <div className="iptv-folder-view">
          <div className="iptv-crumb">
            <button className="iptv-mini" onClick={() => setActiveFolder(null)}>← All categories</button>
            <h2 className="iptv-h2">{activeFolder} <span className="iptv-count">{activeChannels.length} channels</span></h2>
          </div>
          <div className="iptv-channel-grid">
            {activeChannels.map(c => (
              <MediaCard
              key={c.id}
              video={c}
              initialIsFavorite={favoriteSet.has(getMediaId(c))}
              onToggleFavorite={handleToggleFavorite}
              onSelectVideo={openPlayback}
            />
            ))}
          </div>
        </div>
      )}

      {!loading && channels.length === 0 && !activeFolder && (
        <div className="iptv-empty">
          <p>No channels imported yet.</p>
          <p className="iptv-empty-hint">Paste an M3U playlist URL above. Works with iptv-org lists, free TV lists, etc.</p>
        </div>
      )}

      {loading && <div className="iptv-loading">Loading playlists…</div>}

      {toast && <div className={`iptv-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
};

export default IPTV;