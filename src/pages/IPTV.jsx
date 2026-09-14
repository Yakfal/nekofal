import React, { useState, useEffect, useCallback, useMemo } from 'react';
import MediaCard from '../components/MediaCard.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { autoSync, getMediaId } from '../services/dbAdapter.js';
import isAdultMedia from '../utils/contentSafety.js';
import './IPTV.css';

function getApi() { return window.api || window.electronAPI; }

function toCard(item) {
  return {
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
  };
}

// Channels are HLS streams masquerading as random extensions; always treat as direct/stream
function IPTV() {
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;
  const [sources, setSources] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const { open: openPlayback } = usePlayback();
  const [toast, setToast] = useState(null);
  const [refreshId, setRefreshId] = useState(null);
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState('category');
  const [tab, setTab] = useState('all');

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

  const familyChannels = useMemo(
    () => channels.filter(c => familyMode ? !isAdultMedia(c) : true),
    [channels, familyMode]
  );

  const groups = useMemo(() => {
    const g = {};
    familyChannels.forEach(c => {
      const key = c.groupTitle || 'Uncategorized';
      if (!g[key]) g[key] = [];
      g[key].push(c);
    });
    return g;
  }, [familyChannels]);

  const folderList = useMemo(() =>
    Object.entries(groups).sort((a, b) => b[1].length - a[1].length),
  [groups]);

  const tabChannels = useMemo(() => {
    if (!tab || tab === 'all' || tab === 'categories') return familyChannels;
    return groups[tab] || familyChannels;
  }, [tab, groups, familyChannels]);

  // Channels shown in the guide: tab filter + live search (name OR group) +
  // sort (by category, then name A-Z — or pure alphabetical).
  const visibleChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = tabChannels;
    if (q) {
      list = list.filter(c =>
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.groupTitle || '').toLowerCase().includes(q) ||
        String(c.category || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sortBy === 'alpha') {
      sorted.sort((a, b) =>
        String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
    } else {
      sorted.sort((a, b) =>
        String(a.groupTitle || '').localeCompare(String(b.groupTitle || ''), undefined, { sensitivity: 'base' }) ||
        String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
    }
    return sorted;
  }, [tabChannels, query, sortBy]);

  const handleSelectChannel = useCallback((ch) => {
    // Zapping needs the exact list order the user sees + the index of the
    // tuned channel, so ArrowUp/ArrowDown and Ch+/Ch- advance through it.
    const idx = visibleChannels.findIndex((c) => c === ch || (c.id && c.id === ch.id));
    openPlayback(ch, { channels: visibleChannels, channelIndex: idx >= 0 ? idx : 0 });
  }, [visibleChannels, openPlayback]);

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

      {/* Channel guide: category tabs + live search + sort */}
      {!loading && folderList.length > 0 && (
        <div className="iptv-guide">
          <div className="iptv-tabs">
            <button
              className={`iptv-tab ${tab === 'all' ? 'active' : ''}`}
              onClick={() => setTab('all')}
            >
              All Channels
            </button>
            <button
              className={`iptv-tab ${tab === 'categories' ? 'active' : ''}`}
              onClick={() => setTab('categories')}
            >
              Categories
            </button>
            {folderList.map(([name]) => (
              <button
                key={name}
                className={`iptv-tab ${tab === name ? 'active' : ''}`}
                onClick={() => setTab(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {tab !== 'categories' && (
            <>
              <div className="iptv-toolbar">
                <input
                  className="iptv-input iptv-search"
                  placeholder="Search channels by name or group…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="iptv-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  aria-label="Sort channels"
                >
                  <option value="category">Sort: Category</option>
                  <option value="alpha">Sort: Name (A–Z)</option>
                </select>
              </div>

              <div className="iptv-channel-grid">
                {visibleChannels.map(c => (
                  <MediaCard
                    key={c.id}
                    video={c}
                    initialIsFavorite={favoriteSet.has(getMediaId(c))}
                    onToggleFavorite={handleToggleFavorite}
                    onSelectVideo={handleSelectChannel}
                  />
                ))}
                {visibleChannels.length === 0 && (
                  <div className="iptv-empty">
                    <p>{query ? `No channels match "${query}".` : 'No channels in this category.'}</p>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'categories' && (
            <div className="iptv-folders">
              <h2 className="iptv-h2">
                Categories <span className="iptv-count">{familyChannels.length} channels</span>
              </h2>
              <div className="iptv-folder-grid">
                {folderList.map(([name, list]) => (
                  <button key={name} className="iptv-folder" onClick={() => setTab(name)}>
                    <span className="iptv-folder-icon">📺</span>
                    <span className="iptv-folder-name">{name}</span>
                    <span className="iptv-folder-count">{list.length} channels</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && channels.length === 0 && (
        <div className="iptv-empty">
          <p>No channels imported yet.</p>
          <p className="iptv-empty-hint">Paste an M3U playlist URL above. Works with iptv-org lists, free TV lists, etc.</p>
        </div>
      )}

      {loading && <div className="iptv-loading">Loading playlists…</div>}

      {toast && <div className={`iptv-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

export default IPTV;