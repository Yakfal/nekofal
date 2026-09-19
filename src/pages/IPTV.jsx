import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Hls from 'hls.js';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { autoSync, favoritePayloadFor, getMediaId } from '../services/dbAdapter.js';
import { IPTV_LANGUAGE_FEEDS, importLanguageFeed } from '../services/iptvService.js';
import isAdultMedia from '../utils/contentSafety.js';
import './IPTV.css';

function getApi() { return window.api || window.electronAPI; }

// The catalog comes in with every group-title imaginable, often semicolon or
// comma delimited ("Movies;Series"). Reduce the raw tags to one clean primary
// category so every channel lands in a predictable bucket and the tab bar
// above the guide stays small and human readable.
const PRIMARY_CATEGORIES = ['All', 'General', 'News', 'Movies', 'Series', 'Sports', 'Entertainment', 'Kids'];

const CATEGORY_SYNONYMS = {
  general: 'General', mixed: 'General', misc: 'General', other: 'General',
  unknown: 'General', uncategorized: 'General', undefined: 'General',
  news: 'News', 'news 24': 'News', world: 'News', business: 'News',
  politics: 'News', weather: 'News', 'breaking news': 'News',
  movie: 'Movies', movies: 'Movies', film: 'Movies', films: 'Movies',
  cinema: 'Movies', hollywood: 'Movies', blockbuster: 'Movies', 'movie classics': 'Movies',
  series: 'Series', tv: 'Series', 'tv shows': 'Series', shows: 'Series',
  show: 'Series', drama: 'Series', sitcom: 'Series', 'tv series': 'Series',
  sport: 'Sports', sports: 'Sports', football: 'Sports', soccer: 'Sports',
  basketball: 'Sports', baseball: 'Sports', hockey: 'Sports', tennis: 'Sports',
  golf: 'Sports', f1: 'Sports', 'formula 1': 'Sports', mma: 'Sports',
  boxing: 'Sports', cricket: 'Sports', rugby: 'Sports', nfl: 'Sports',
  nba: 'Sports', mlb: 'Sports', nhl: 'Sports', esports: 'Sports',
  entertainment: 'Entertainment', ent: 'Entertainment', music: 'Entertainment',
  'music videos': 'Entertainment', reality: 'Entertainment', 'reality tv': 'Entertainment',
  documentary: 'Entertainment', documentaries: 'Entertainment', lifestyle: 'Entertainment',
  culture: 'Entertainment', comedy: 'Entertainment', 'talk show': 'Entertainment',
  'talk shows': 'Entertainment', celebrity: 'Entertainment',
  kid: 'Kids', kids: 'Kids', children: 'Kids', cartoon: 'Kids', cartoons: 'Kids',
  animation: 'Kids', family: 'Kids', 'kids & family': 'Kids', disney: 'Kids',
  'kids movies': 'Kids', 'kids shows': 'Kids'
};

function normalizeCategory(raw) {
  const value = String(raw || '').trim();
  if (!value || value.toLowerCase() === 'undefined') return 'General';
  // Multi-tag groups ("Movies;Series", "Sports,News") -> take the first tag.
  const first = value.split(/[,;|]/)[0].trim();
  const key = first.toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
  if (CATEGORY_SYNONYMS[key]) return CATEGORY_SYNONYMS[key];
  // "Movies (VOD)", "Kids Cartoons" -> the leading word usually decides.
  const head = key.split(' ')[0];
  return CATEGORY_SYNONYMS[head] || 'General';
}

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

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) { /* clipboard blocked */ }
  return false;
}

// Embedded pane player: IPTV channels are HLS streams masquerading as random
// extensions, so hls.js is always given first crack, with a native fallback in
// case a manifest is really not an m3u8 at all.
function EmbeddedPlayer({ channel }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (err) {}
      hlsRef.current = null;
    }
    const src = channel && channel.videoUrl;
    el.poster = (channel && channel.thumbnailUrl) || '';
    if (!src) {
      el.removeAttribute('src');
      el.load();
      return undefined;
    }
    const stopNative = () => { el.removeAttribute('src'); try { el.load(); } catch (err) {} };
    if (/m3u8/i.test(src) && Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(el);
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        // Fatal manifest/network errors on a disguised stream -> drop to native.
        if (data && data.fatal && hlsRef.current === hls) {
          try { hls.destroy(); } catch (err) {}
          if (hlsRef.current === hls) hlsRef.current = null;
          el.src = src;
          el.play().catch(() => {});
        }
      });
      const play = () => el.play().catch(() => {});
      play();
      return () => {
        if (hlsRef.current === hls) hlsRef.current = null;
        try { hls.destroy(); } catch (err) {}
        stopNative();
      };
    }
    el.src = src;
    el.play().catch(() => {});
    return stopNative;
  }, [channel && channel.videoUrl]);

  return (
    <div className="iptv-player">
      <video ref={videoRef} className="iptv-video" controls autoPlay playsInline />
    </div>
  );
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
  const [tab, setTab] = useState('All');
  const [langBusy, setLangBusy] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [copied, setCopied] = useState(false);
  const [favBusy, setFavBusy] = useState(null);

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

  // Every channel gets one clean primary category derived from its raw group.
  const categorized = useMemo(
    () => familyChannels.map(c => ({ ...c, cleanCategory: normalizeCategory(c.category || c.groupTitle) })),
    [familyChannels]
  );

  const byCategory = useMemo(() => {
    const m = {};
    categorized.forEach(c => {
      const k = c.cleanCategory || 'General';
      (m[k] = m[k] || []).push(c);
    });
    return m;
  }, [categorized]);

  const tabChannels = useMemo(() => {
    if (!tab || tab === 'All') return categorized;
    return byCategory[tab] || [];
  }, [tab, categorized, byCategory]);

  // Channels shown in the list: tab filter + live search (name OR group) +
  // sort (by category, then name A-Z — or pure alphabetical).
  const visibleChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = tabChannels;
    if (q) {
      list = list.filter(c =>
        String(c.title || '').toLowerCase().includes(q) ||
        String(c.groupTitle || '').toLowerCase().includes(q) ||
        String(c.cleanCategory || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sortBy === 'alpha') {
      sorted.sort((a, b) =>
        String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
    } else {
      sorted.sort((a, b) =>
        String(a.cleanCategory || '').localeCompare(String(b.cleanCategory || ''), undefined, { sensitivity: 'base' }) ||
        String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }));
    }
    return sorted;
  }, [tabChannels, query, sortBy]);

  // Auto-tune the first visible channel once, and drop a deleted/out-of-view
  // selection so the right pane never points at a stale stream.
  useEffect(() => {
    if (!selectedChannel && visibleChannels.length) setSelectedChannel(visibleChannels[0]);
  }, [selectedChannel, visibleChannels]);

  useEffect(() => {
    if (selectedChannel && !categorized.some(c => c.id === selectedChannel.id)) {
      setSelectedChannel(null);
    }
  }, [categorized, selectedChannel]);

  const handleSelectChannel = useCallback((ch) => {
    if (ch) setSelectedChannel(ch);
  }, []);

  const handleOpenFullPlayer = useCallback((ch) => {
    // Full-screen player keeps zapping through the exact list order the user sees.
    const idx = visibleChannels.findIndex(c => c.id === ch.id);
    openPlayback(ch, { channels: visibleChannels, channelIndex: idx >= 0 ? idx : 0 });
  }, [visibleChannels, openPlayback]);

  const togglePaneFavorite = useCallback(async (ch) => {
    const key = getMediaId(ch);
    if (!key) return;
    setFavBusy(key);
    try {
      const api = getApi();
      const res = await api.toggleFavorite(favoritePayloadFor(ch));
      if (res?.success) {
        const favorited = res.data ? res.data.favorited : res.favorited;
        setFavoriteSet((prev) => {
          const next = new Set(prev);
          if (favorited) next.add(key);
          else next.delete(key);
          return next;
        });
        autoSync();
      }
    } catch (err) {
      showToast('Favorite toggle failed', 'err');
    } finally {
      setFavBusy(null);
    }
  }, [showToast]);

  const handleCopyStream = useCallback(async (ch) => {
    const ok = await copyText(ch.videoUrl || '');
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      showToast('Copy failed — no clipboard access', 'err');
    }
  }, [showToast]);

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

  const handleLanguageChip = async (feed) => {
    if (langBusy) return;
    setLangBusy(feed.key);
    try {
      const res = await importLanguageFeed(feed);
      const ok = !!res?.success;
      showToast(ok ? `Imported ${res.inserted ?? 0} channels (${feed.label})` : (res?.error || 'Import failed'), ok ? 'ok' : 'err');
      if (ok) {
        autoSync();
        window.dispatchEvent(new Event('scrapers-synced'));
      }
    } catch (err) {
      showToast('Import failed: ' + err.message, 'err');
    } finally {
      setLangBusy(false);
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

  const selectedFav = selectedChannel ? favoriteSet.has(getMediaId(selectedChannel)) : false;

  return (
    <div className="iptv-page">
      <div className="iptv-header">
        <h1>Live Channels</h1>
        <p>Import any M3U playlist — every channel is saved and organized by category automatically.</p>
      </div>

      {/* Quick-start language feeds: one tap imports that iptv-org playlist
          through the exact same import engine as the form below, then the grid
          re-syncs. Feeds are curated in services/iptvService.js. */}
      <div className="iptv-langs" aria-label="Quick-start language playlists">
        {IPTV_LANGUAGE_FEEDS.map(feed => (
          <button
            key={feed.key}
            className="iptv-lang-chip"
            onClick={() => handleLanguageChip(feed)}
            disabled={langBusy === feed.key}
          >
            {langBusy === feed.key && '…'} {feed.label}
          </button>
        ))}
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

      {/* Channel guide: 8-category tab bar + Xuper two-pane layout */}
      {!loading && categorized.length > 0 && (
        <div className="iptv-guide">
          <div className="iptv-tabs" role="tablist" aria-label="Channel categories">
            {PRIMARY_CATEGORIES.map(cat => {
              const count = cat === 'All' ? categorized.length : (byCategory[cat] || []).length;
              return (
                <button
                  key={cat}
                  role="tab"
                  aria-selected={tab === cat}
                  className={`iptv-tab ${tab === cat ? 'active' : ''}`}
                  onClick={() => setTab(cat)}
                >
                  {cat}
                  <span className="iptv-tab-count">{count}</span>
                </button>
              );
            })}
          </div>

          <div className="iptv-split">
            {/* Left: channel list */}
            <div className="iptv-pane-list">
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

              <div className="iptv-channel-list">
                {visibleChannels.map(c => (
                  <button
                    key={c.id}
                    className={`iptv-channel-row ${selectedChannel && selectedChannel.id === c.id ? 'active' : ''}`}
                    onClick={() => handleSelectChannel(c)}
                  >
                    <img
                      className="iptv-channel-logo"
                      src={c.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }}
                    />
                    <span className="iptv-channel-meta">
                      <span className="iptv-channel-name">{c.title}</span>
                      <span className="iptv-channel-pill">{c.cleanCategory}</span>
                    </span>
                  </button>
                ))}
                {visibleChannels.length === 0 && (
                  <div className="iptv-empty">
                    <p>{query ? `No channels match "${query}".` : 'No channels in this category.'}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Right: embedded player + details */}
            <div className="iptv-pane-player">
              {selectedChannel ? (
                <>
                  <EmbeddedPlayer channel={selectedChannel} />

                  <div className="iptv-details">
                    <div className="iptv-details-head">
                      <div className="iptv-details-title">
                        <h2>{selectedChannel.title}</h2>
                        <span className="iptv-channel-pill big">{selectedChannel.cleanCategory}</span>
                      </div>
                      <div className="iptv-details-actions">
                        <button
                          className={`iptv-fav-btn ${selectedFav ? 'active' : ''}`}
                          onClick={() => togglePaneFavorite(selectedChannel)}
                          disabled={favBusy === getMediaId(selectedChannel)}
                          aria-pressed={selectedFav}
                        >
                          {selectedFav ? '★ Favorited' : '☆ Favorite'}
                        </button>
                        <button className="iptv-mini" onClick={() => handleOpenFullPlayer(selectedChannel)}>
                          ⛶ Full player
                        </button>
                      </div>
                    </div>

                    <div className="iptv-stream-row">
                      <code className="iptv-stream-url" title={selectedChannel.videoUrl}>
                        {selectedChannel.videoUrl}
                      </code>
                      <button className="iptv-mini" onClick={() => handleCopyStream(selectedChannel)}>
                        {copied ? 'Copied!' : 'Copy URL'}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="iptv-player-empty">
                  <p>Select a channel to start watching</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && channels.length === 0 && (
        <div className="iptv-empty">
          <p>No channels imported yet.</p>
          <p className="iptv-empty-hint">Paste an M3U playlist URL above. Works with iptv-org lists, free TV lists, etc.</p>
        </div>
      )}

      {!loading && familyMode && channels.length > 0 && categorized.length === 0 && (
        <div className="iptv-empty">
          <p>All imported channels are hidden by Family Mode.</p>
        </div>
      )}

      {loading && <div className="iptv-loading">Loading playlists…</div>}

      {toast && <div className={`iptv-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

export default IPTV;