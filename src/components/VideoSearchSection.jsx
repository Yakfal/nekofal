import React, { useState, useCallback, useRef, useEffect } from 'react';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { autoSync, getCloudState, getMediaId, favoritePayloadFor, isPageUrl } from '../services/dbAdapter.js';
import PlaylistMenu from './PlaylistMenu.jsx';
import './VideoSearchSection.css';

const getApi = () => window.api || window.electronAPI;

// The gateway (Express backend) sits next to PocketBase on the same host, port
// 3000. Deduce it from the cloud URL the user configured in Settings so video
// search can fall back to the server when yt-dlp is unavailable locally.
const getGatewayUrl = () => {
  try {
    const cloudUrl = (getCloudState() || {}).url;
    if (!cloudUrl) return '';
    const u = new URL(cloudUrl);
    u.port = '3000';
    u.pathname = '/';
    u.search = '';
    u.hash = '';
    return String(u).replace(/\/+$/, '');
  } catch {
    return '';
  }
};

const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const VideoSearchSection = ({
  title,
  subtitle,
  placeholder = 'Enter a name or paste a link...',
  tags,
  siteUrl = null,
  hint = '',
  accent = '#3b82f6'
}) => {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [searchInfo, setSearchInfo] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [addedIds, setAddedIds] = useState(() => new Set());
  // Favorite ids as a Set so the star reflects the REAL local DB state instead
  // of defaulting to "filled" — one IPC load per grid, O(1) membership checks.
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());
  const [togglingId, setTogglingId] = useState(null);
  const { playVideo } = usePlayback();
  const [toast, setToast] = useState(null);
  const inputRef = useRef(null);

  const toPlayerPayload = useCallback((v) => ({
    id: v.id,
    videoTitle: v.title,
    title: v.title,
    videoUrl: v.videoUrl,
    pageUrl: v.pageUrl || (v.videoUrl && isPageUrl(v.videoUrl) ? v.videoUrl : ''),
    thumbnailUrl: v.thumbnailUrl,
    duration: v.duration,
    isHLS: !!v.isHLS,
    sourceSite: v.sourceSite,
    type: (tags && tags.type) || 'Web Video',
    category: v.category || (tags && tags.category) || 'Video',
    httpHeaders: v.httpHeaders
  }), [tags]);

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Seed the star state from the real favorites table once; also re-sync after
  // a cloud pull or another page favorites/unfavorites something.
  useEffect(() => {
    const api = getApi();
    if (!api?.getFavorites) return undefined;
    let alive = true;
    const reload = () => {
      api.getFavorites()
        .then((res) => {
          if (!alive) return;
          if (res?.success && Array.isArray(res.data)) {
            setFavoriteSet(new Set(res.data.map(r => getMediaId(r)).filter(Boolean)));
          }
        })
        .catch(() => {});
    };
    reload();
    window.addEventListener('favorites-synced', reload);
    window.addEventListener('scrapers-synced', reload);
    return () => {
      alive = false;
      window.removeEventListener('favorites-synced', reload);
      window.removeEventListener('scrapers-synced', reload);
    };
  }, []);

  const handleSearch = async (e) => {
    e?.preventDefault();
    const q = (query || '').trim();
    if (!q) { showToast('Type a name or paste a link', 'err'); return; }

    // Detect: full URL -> enumerate that page
    const isUrl = /^https?:\/\//i.test(q);
    let mode = 'enum';
    let targetTemplate = null;
    if (!isUrl && siteUrl) mode = 'site';
    else if (!isUrl) mode = 'yt';

    setSearching(true);
    setSearchError(null);
    setResults([]);
    setSearchInfo(null);
    try {
      const api = getApi();
      if (!api?.webSearch) {
        setSearchError('Web search is only available inside the app (window.api is missing in a browser).');
        setSearching(false);
        return;
      }
      const res = await api.webSearch({
        mode,
        query: q,
        siteUrl: targetTemplate || siteUrl || undefined,
        count: 30,
        gatewayUrl: getGatewayUrl()
      });
      if (res?.success) {
        setResults(res.videos || []);
        setSearchInfo({
          count: (res.videos || []).length,
          source: res.source === 'yt-dlp' ? 'yt-dlp' : res.source === 'gateway' || (res.source || '').includes('gateway') ? 'server gateway' : 'HTML',
          mode: mode === 'site' ? 'site' : isUrl ? 'url' : 'search'
        });
        if (!res.videos || res.videos.length === 0) {
          setSearchError('Found nothing. Try another name/link.');
        }
      } else {
        setSearchError(res?.error || res?.details || 'Search failed');
        setResults([]);
      }
    } catch (err) {
      console.error('[Search] failed:', err);
      setSearchError('Search failed: ' + err.message);
    } finally {
      setSearching(false);
    }
  };

  const handleAddOne = async (v) => {
    try {
      const api = getApi();
      const res = await api.addVideos([{ ...v, category: (tags?.category || v.category || 'Video') }], tags);
      if (res?.success && res.inserted > 0) {
        setAddedIds(prev => new Set(prev).add(v.id));
        showToast(`Saved "${v.title}" to your library`);
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        setAddedIds(prev => new Set(prev).add(v.id));
        showToast(`"${v.title}" was already in the library`);
      }
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'err');
    }
  };

  const handleSaveAll = async () => {
    const fresh = results.filter(v => !addedIds.has(v.id));
    if (fresh.length === 0) { showToast('Everything here is already saved'); return; }
    try {
      const api = getApi();
      const res = await api.addVideos(fresh, tags);
      if (res?.success) {
        setAddedIds(prev => new Set([...prev, ...fresh.map(v => v.id)]));
        showToast(`Saved ${res.inserted || fresh.length} videos to your library`);
        window.dispatchEvent(new Event('scrapers-synced'));
      }
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'err');
    }
  };

  const handleToggleFavorite = async (v) => {
    const key = getMediaId(v);
    if (!key) { showToast('Cannot favorite this item', 'err'); return; }
    setTogglingId(key);
    try {
      const api = getApi();
      const payload = favoritePayloadFor(v);
      if (tags && tags.type && !v.type) payload.type = tags.type;
      if (tags && tags.isAdult) payload.isAdult = true;
      const res = await api.toggleFavorite(payload);
      if (res?.success) {
        const favorited = res.data ? res.data.favorited : res.favorited;
        setFavoriteSet((prev) => {
          const next = new Set(prev);
          if (favorited) next.add(key);
          else next.delete(key);
          return next;
        });
        showToast(favorited ? 'Added to favorites' : 'Removed from favorites');
        autoSync();
      } else {
        showToast('Favorite toggle failed', 'err');
      }
    } catch (err) {
      showToast('Favorite toggle failed', 'err');
    } finally {
      setTogglingId(null);
    }
  };

  const urlHost = (u) => {
    try { return new URL(u).hostname.replace('www.', ''); } catch { return ''; }
  };

  return (
    <div className="vss-root" style={{ '--vss-accent': accent }}>
      <div className="vss-header">
        <h1 className="vss-title">{title}</h1>
        {subtitle && <p className="vss-subtitle">{subtitle}</p>}
      </div>

      <form className="vss-searchbar" onSubmit={handleSearch}>
        <input
          ref={inputRef}
          type="text"
          className="vss-input"
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search"
        />
        <button type="submit" className="vss-go" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {hint && <p className="vss-hint">{hint}</p>}

      {searchInfo && (
        <div className="vss-meta">
          {searchInfo.count} results · via {searchInfo.source}
          {results.length > 0 && (
            <>
              {' · '}
              <button className="vss-linkish" onClick={handleSaveAll}>Save all to library</button>
            </>
          )}
        </div>
      )}

      {searchError && (
        <div className="vss-error">
          <strong>No results:</strong> {searchError}
        </div>
      )}

      {results.length > 0 && (
        <div className="vss-grid">
          {results.map((v) => {
            const added = addedIds.has(v.id);
            const favKey = getMediaId(v);
            const isFav = favoriteSet.has(favKey);
            return (
              <div key={v.id} className="vss-card" data-id={v.id}>
                <div className="vss-thumb" onClick={() => playVideo(toPlayerPayload(v))}>
                  {v.thumbnailUrl ? (
                    <img src={v.thumbnailUrl} alt={v.title} loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : (
                    <div className="vss-thumb-fallback">▶</div>
                  )}
                  <div className="vss-play">▶</div>
                  {v.duration > 0 && <span className="vss-duration">{formatDuration(v.duration)}</span>}
                </div>
                <div className="vss-body">
                  <h3 className="vss-vtitle" title={v.title}>{v.title}</h3>
                  <p className="vss-vsub">{v.sourceSite || (v.extractor ? v.extractor : urlHost(v.videoUrl))}</p>
                  <div className="vss-actions">
                    <button className="vss-btn play" onClick={() => playVideo(toPlayerPayload(v))}>Play</button>
                    <button className="vss-btn add" onClick={() => handleAddOne(v)} disabled={added}>
                      {added ? '✔ Saved' : '+ Save'}
                    </button>
                    <PlaylistMenu
                      video={{
                        id: v.id,
                        videoTitle: v.title,
                        videoUrl: v.videoUrl,
                        thumbnailUrl: v.thumbnailUrl,
                        duration: v.duration,
                        sourceSite: v.sourceSite
                      }}
                      buttonClassName="vss-btn pl"
                      buttonContent="⊕"
                      buttonTitle="Add to playlist"
                    />
                    <button
                      className={`vss-btn fav ${isFav ? 'active' : ''}`}
                      title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                      aria-pressed={isFav}
                      disabled={togglingId === favKey}
                      onClick={() => handleToggleFavorite(v)}
                    >
                      {isFav ? '★' : '☆'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div className={`vss-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>
      )}
    </div>
  );
};

export default VideoSearchSection;