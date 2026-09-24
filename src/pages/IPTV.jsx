import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Hls from 'hls.js';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { usePlayback, usePersistentPauseOnLeave } from '../contexts/PlaybackContext.jsx';
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

// Localized labels for the primary category tab bar (labels are keyed by the
// stable English bucket; the per-row pills below stay as raw catalog data).
const CATEGORY_TAB_LABELS = {
  'All': 'liveTv.tabAll',
  'General': 'liveTv.tabGeneral',
  'News': 'liveTv.tabNews',
  'Movies': 'liveTv.tabMovies',
  'Series': 'liveTv.tabSeries',
  'Sports': 'liveTv.tabSports',
  'Entertainment': 'liveTv.tabEntertainment',
  'Kids': 'liveTv.tabKids'
};

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
// case a manifest is really not an m3u8 at all. The pane participates in the
// global media coordinator: it announces itself on play (playerId-tagged) and
// detaches the instant ANY other player (another keep-alive pane, the overlay
// full player, an Adult/FreeMovies/Youtube video) starts a stream, so two
// sources never decode/emit audio at the same time.
let paneInstanceSeq = 0;

function EmbeddedPlayer({ channel }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const paneIdRef = useRef(`iptv-pane-${++paneInstanceSeq}`);
  const wasPlayingRef = useRef(false);
  const { notifyMediaPlaying } = usePlayback();

  // Tab-switch auto-pause (v1.0.36): leaving /iptv pauses the pane WITHOUT
  // destroying its hls.js handle, so the channel, timestamp and quality tier
  // survive; returning resumes it exactly where it left off (only if it was
  // actually playing when the tab was left). This is deliberately gentler than
  // detach() — which is reserved for other-source playback below.
  usePersistentPauseOnLeave(
    '/iptv',
    () => {
      const el = videoRef.current;
      if (!el) return;
      try { if (!el.paused) wasPlayingRef.current = true; el.pause(); } catch (err) {}
      if (hlsRef.current) { try { hlsRef.current.stopLoad(); } catch (err) {} }
    },
    () => {
      const el = videoRef.current;
      if (!el) return;
      if (hlsRef.current) { try { hlsRef.current.startLoad(); } catch (err) {} }
      if (wasPlayingRef.current && (hlsRef.current || el.currentSrc)) {
        try { el.play(); } catch (err) {}
      }
      wasPlayingRef.current = false;
    }
  );

  // Release the pane handle: pause the element and destroy hls.js + clear the
  // source so no background audio/video leaks from a hidden tab.
  const detach = useCallback(() => {
    const el = videoRef.current;
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (err) {}
      hlsRef.current = null;
    }
    if (el) {
      try { el.pause(); } catch (err) {}
      el.removeAttribute('src');
      try { el.load(); } catch (err) {}
    }
    // Another source owns the media slot now — a later tab return must NOT
    // auto-resume a stream that no longer exists.
    wasPlayingRef.current = false;
  }, []);

  // Any playback that started elsewhere claims the media slot: release this
  // pane's stream immediately. Events this very player emitted (matched by
  // playerId) are ignored so announcing our own play never self-destructs.
  useEffect(() => {
    const onSourceActive = (e) => {
      const detail = (e && e.detail) || {};
      if (!detail.source) return;
      if (detail.playerId && detail.playerId === paneIdRef.current) return;
      detach();
    };
    window.addEventListener('nek-media-source-active', onSourceActive);
    return () => window.removeEventListener('nek-media-source-active', onSourceActive);
  }, [detach]);

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
    const stopNative = () => {
      const v = el;
      try { if (!v.paused) v.pause(); } catch (err) {}
      v.removeAttribute('src');
      try { v.load(); } catch (err) {}
    };
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
      notifyMediaPlaying('iptv', { playerId: paneIdRef.current });
      return () => {
        // Teardown on channel switch / tab unmount: detach + destroy hls.js and
        // blank the element so no background audio/video leaks from a hidden pane.
        if (hlsRef.current === hls) {
          try { hls.detachMedia(); } catch (err) {}
          try { hls.destroy(); } catch (err) {}
          hlsRef.current = null;
        }
        stopNative();
      };
    }
    el.src = src;
    el.play().catch(() => {});
    notifyMediaPlaying('iptv', { playerId: paneIdRef.current });
    return stopNative;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel && channel.videoUrl, notifyMediaPlaying]);

  return (
    <div className="iptv-player">
      <video ref={videoRef} className="iptv-video" controls autoPlay playsInline />
    </div>
  );
}

// Channels are HLS streams masquerading as random extensions; always treat as direct/stream
function IPTV() {
  const { settings } = useAppSettings();
  const { t, language } = useLanguage();
  const familyMode = settings.familyMode;
  const [sources, setSources] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const { open: openPlayback } = usePlayback();
  const [toast, setToast] = useState(null);
  const [refreshId, setRefreshId] = useState(null);
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState('category');
  // Active tab defaults to the focused app language when it is one of the
  // primary buckets, otherwise everything ("All") so the grid pops open on
  // first load without a manual click.
  const [tab, setTab] = useState(() => (PRIMARY_CATEGORIES.includes(language) ? language : 'All'));
  const [langBusy, setLangBusy] = useState(false);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [copied, setCopied] = useState(false);
  const [favBusy, setFavBusy] = useState(null);

  // Pre-flight stream health (session-scoped): urls proven reachable stay in
  // okRef, urls that failed go to deadRef and their channels are filtered out
  // of the list before the user browses. Dead urls can be re-checked anytime
  // via the chip that appears when anything was hidden.
  const okRef = useRef(new Set());
  const deadRef = useRef(new Set());
  const probeSeqRef = useRef(0);
  const [probeInfo, setProbeInfo] = useState({ running: false, hidden: 0, checking: 0, newlyDead: 0 });

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

  // Probe every channel url that is neither known-good nor known-dead this
  // session; merge results back incrementally and hide freshly-discovered dead
  // channels. Runs concurrently main-process-side, so only one round-trip per
  // url happens and the list keeps browsing instantly.
  // NOTE: must be defined BEFORE loadAll — hook dependency arrays read their
  // members eagerly, so referencing probeUntested before it initializes would
  // throw a TDZ ReferenceError at render time.
  const probeUntested = useCallback(async (cards) => {
    const api = getApi();
    if (!api?.probeIptvChannels || !Array.isArray(cards) || cards.length === 0) return;
    const untested = cards.filter(c => c.videoUrl && !okRef.current.has(c.videoUrl) && !deadRef.current.has(c.videoUrl));
    if (untested.length === 0) return;
    const seq = ++probeSeqRef.current;
    setProbeInfo(prev => ({ ...prev, running: true, checking: untested.length }));
    try {
      const res = await api.probeIptvChannels(untested.map(c => ({ title: c.title, videoUrl: c.videoUrl })));
      if (seq !== probeSeqRef.current) return; // superseded by a newer probe
      const report = (res?.results || []).reduce((m, r) => { if (r && r.url) m[r.url] = !!r.ok; return m; }, {});
      let newlyDead = 0;
      for (const c of untested) {
        if (report[c.videoUrl] === true) okRef.current.add(c.videoUrl);
        else if (report[c.videoUrl] === false) { deadRef.current.add(c.videoUrl); newlyDead++; }
      }
      if (newlyDead > 0) {
        setChannels(prev => prev.filter(c => !deadRef.current.has(c.videoUrl)));
        showToast(`Hidden ${newlyDead} unavailable channel${newlyDead === 1 ? '' : 's'} (offline or geo-blocked)`, 'ok');
      }
      setProbeInfo({ running: false, hidden: deadRef.current.size, checking: 0, newlyDead });
    } catch (err) {
      console.error('[IPTV] probe failed:', err);
      setProbeInfo(prev => ({ ...prev, running: false, checking: 0 }));
    }
  }, [showToast]);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApi();
      if (!api?.getIptvSources) { setLoading(false); return; }
      const src = await api.getIptvSources();
      if (src?.success) setSources(src.data || []);
      const ch = await api.getVideosBySource('IPTV');
      if (ch?.success) {
        const cards = (ch.data || []).map(toCard);
        // Forget ok-markers for urls that no longer exist, keep dead-marks
        // (a vanished channel's url is gone anyway — harmless to keep).
        okRef.current = new Set(cards.filter(c => okRef.current.has(c.videoUrl)).map(c => c.videoUrl));
        setChannels(cards.filter(c => !deadRef.current.has(c.videoUrl)));
        probeUntested(cards);
      }
    } catch (err) {
      console.error('[IPTV] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [probeUntested]);

  // Retest previously-dead channels (their server may be back, or the viewer
  // switched networks/VPNs).
  const recheckDead = useCallback(() => {
    deadRef.current = new Set();
    setProbeInfo({ running: false, hidden: 0, checking: 0, newlyDead: 0 });
    loadAll();
  }, [loadAll]);

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

  // TV remote zapping: ArrowUp / ArrowDown hop the active channel through the
  // visible list the user is browsing. The inline search input keeps its arrow
  // keys (typing must not be hijacked), and the highlighted rail row is kept
  // in view so zapping never loses the cursor.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // The page stays mounted (keep-alive) while another tab is visible;
      // a display:none ancestor makes offsetParent null, so ignore keys when
      // the IPTV view is hidden — don't zap channels the user can't see.
      const pageEl = document.querySelector('.iptv-page');
      if (!pageEl || pageEl.offsetParent === null) return;
      if (!visibleChannels || visibleChannels.length === 0) return;
      const idx = visibleChannels.findIndex(c => selectedChannel && c.id === selectedChannel.id);
      let next;
      if (e.key === 'ArrowDown') {
        next = idx < 0 ? 0 : (idx + 1) % visibleChannels.length;
      } else {
        next = idx <= 0 ? visibleChannels.length - 1 : idx - 1;
      }
      e.preventDefault();
      setSelectedChannel(visibleChannels[next]);
      const rows = document.querySelectorAll('.iptv-channel-row');
      if (rows[next]) rows[next].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleChannels, selectedChannel]);

  const handleSelectChannel = useCallback((ch) => {
    // A fresh spread forces re-attach on repeat clicks of the SAME channel
    // after another source detached this pane's stream.
    if (ch) setSelectedChannel((prev) => (prev && prev.id === ch.id && prev === ch ? { ...ch } : ch));
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
        <h1>{t('nav.liveChannels')}</h1>
        <p>{t('page.liveChannels.subtitle')}</p>
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
        {sources.map(s => (
          <div key={s.id} className="iptv-source">
            <div className="iptv-source-info">
              <strong>{s.name}</strong>
              <span className="iptv-source-url">{s.channelCount} {t('common.channels')} · {s.url}</span>
            </div>
            <button className="iptv-mini" onClick={() => handleRefresh(s)} disabled={refreshId === s.id}>
              {refreshId === s.id ? t('liveTv.refreshing') : t('liveTv.refresh')}
            </button>
            <button className="iptv-mini danger" onClick={() => handleRemove(s)}>×</button>
          </div>
        ))}
      </div>

      {/* Stream health status: checking on load, or hidden-channel count with a re-check action */}
      {(probeInfo.running || probeInfo.hidden > 0) && (
        <div className={`iptv-probe ${probeInfo.hidden > 0 && !probeInfo.running ? 'has-hidden' : ''}`}>
          {probeInfo.running ? (
            <span className="iptv-probe-run">
              <span className="iptv-probe-spinner" aria-hidden="true" />
              {t('liveTv.probing')} {probeInfo.checking}
            </span>
          ) : (
            <span className="iptv-probe-done">
              {probeInfo.hidden} {t('liveTv.hiddenChannels')}
              <button className="iptv-probe-recheck" onClick={recheckDead}>{t('liveTv.recheck')}</button>
            </span>
          )}
        </div>
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
                  {t(CATEGORY_TAB_LABELS[cat] || cat)}
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
                  placeholder={t('liveTv.searchPlaceholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="iptv-sort"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  aria-label="Sort channels"
                >
                  <option value="category">{t('liveTv.sortCategory')}</option>
                  <option value="alpha">{t('liveTv.sortAlpha')}</option>
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
                    <p>{query ? `${t('liveTv.noMatchQuery')} "${query}".` : t('liveTv.noChannelsInCategory')}</p>
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
                          {selectedFav ? t('liveTv.favorited') : t('liveTv.favorite')}
                        </button>
                        <button className="iptv-mini" onClick={() => handleOpenFullPlayer(selectedChannel)}>
                          {t('liveTv.fullPlayer')}
                        </button>
                      </div>
                    </div>

                    <div className="iptv-stream-row">
                      <code className="iptv-stream-url" title={selectedChannel.videoUrl}>
                        {selectedChannel.videoUrl}
                      </code>
                      <button className="iptv-mini" onClick={() => handleCopyStream(selectedChannel)}>
                        {copied ? t('liveTv.copied') : t('liveTv.copyUrl')}
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="iptv-player-empty">
                  <p>{t('liveTv.selectChannel')}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {!loading && channels.length === 0 && (
        <div className="iptv-empty">
          <p>{t('liveTv.noChannelsImported')}</p>
        </div>
      )}

      {!loading && familyMode && channels.length > 0 && categorized.length === 0 && (
        <div className="iptv-empty">
          <p>{t('liveTv.familyHidden')}</p>
        </div>
      )}

      {loading && <div className="iptv-loading">{t('liveTv.loadingPlaylists')}</div>}

      {toast && <div className={`iptv-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>}
    </div>
  );
}

export default IPTV;