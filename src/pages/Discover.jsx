import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import VideoSearchSection from '../components/VideoSearchSection.jsx';
import MediaShelf from '../components/MediaShelf.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import './Discover.css';

const getApi = () => window.api || window.electronAPI;

// Quick-start tiles: each either fires a pre-filtered search or opens a channel
// list, so a brand-new user reaches content in one click without typing.
const TOPIC_TILES = [
  { key: 'news', emoji: '📰', query: 'live news', accent: '#ef4444' },
  { key: 'music', emoji: '🎵', query: 'lofi hip hop live radio', accent: '#8b5cf6' },
  { key: 'movies', emoji: '🎬', route: '/cinema', accent: '#f59e0b' },
  { key: 'radio', emoji: '📻', route: '/radio', accent: '#10b981' },
  { key: 'popular', emoji: '⭐', query: 'popular music videos this week', accent: '#3b82f6' }
];

// Pre-curated fallback shelves: if trending comes back empty (blocked region,
// yt-dlp offline) these still fill the page with real, reachable media. Keys
// drive the localized titles via home.fallback*.
const FALLBACK_SHELVES = [
  { key: 'popular', query: 'popular live streams', accent: '#3b82f6', titleKey: 'home.fallbackPopularTitle' },
  { key: 'news', query: 'live news', accent: '#ef4444', titleKey: 'home.fallbackNewsTitle' }
];

// (v1.0.53) Premium brand priority for the Home Live TV feed. Channels whose
// names contain a recognized global brand surface first on the Home screen
// (featured LIVE pill + strip), in the priority order listed here — higher
// brands win over lower ones. Regional/numeric channels sink to the bottom.
const FAMOUS_BRANDS = [
  'hbo', 'disney', 'telemundo', 'nickelodeon', 'nick', 'cartoon network',
  'discovery', 'animal planet', 'cnn', 'bbc', 'espn', 'fox', 'mtv',
  'univision', 'paramount', 'national geographic', 'nat geo', 'history'
];

const channelName = (ch) => String((ch && (ch.videoTitle || ch.title)) || '').toLowerCase();

// Index of the first FAMOUS_BRANDS entry matched by the channel name, or -1
// when the channel is not a recognized brand.
const brandRank = (ch) => {
  const name = channelName(ch);
  for (let i = 0; i < FAMOUS_BRANDS.length; i++) {
    if (name.includes(FAMOUS_BRANDS[i])) return i;
  }
  return -1;
};

// Obscure regional/numeric channels (e.g. "101tv Cadiz", "10 Bold") start with
// digits; they should not crowd out recognized brands or plain-named channels.
const isRegionalNumeric = (ch) => /^\s*\d/i.test(channelName(ch).trim());

// (v1.0.54) Language-aware Home feed. Given the active app language, return the
// keywords that flag a channel as being in that language (include) and the
// keywords that flag it as a regional/cross-language channel to reject.
// English: broad positive set (en/eng/english/us/uk/ca); reject obvious
// non-English region codes. Spanish: native key + Latin-American country codes.
const getLocaleLangKeys = (appLang) => {
  let lang;
  try { lang = String(appLang || 'en').toLowerCase().split('-')[0]; } catch { lang = 'en'; }
  if (lang === 'es') {
    return { include: ['es', 'spa', 'spanish', 'mx', 'ar', 'co', 'cl', 'español'], exclude: [] };
  }
  if (lang === 'en') {
    return {
      include: ['en', 'eng', 'english', 'us', 'uk', 'ca'],
      exclude: ['bg', 'in', 'ru', 'ar', 'ro', 'gr', 'cl', 'bulgaria', 'india']
    };
  }
  return { include: [lang], exclude: [] };
};

// Does the channel read as being in the current app language? Long keys (e.g.
// "english", "español") match by prefix; short country keys (en/us/uk/ca/es/mx
// ...) match as whole words so "ca" doesn't grab every "canal/cadiz" channel.
const langMatches = (ch, langKeys) => {
  const words = (channelName(ch).match(/[\p{L}]+/gu) || []);
  const hits = (keys) => keys.some((k) =>
    k.length >= 3
      ? words.some((w) => w.startsWith(k))
      : words.includes(k)
  );
  return hits(langKeys.include) && !hits(langKeys.exclude);
};

const historyToCard = (h) => ({
  id: h.id,
  videoTitle: h.title || h.videoTitle || 'Untitled',
  category: h.category || h.sourceSite || 'History',
  thumbnailUrl: h.thumbnailUrl || '',
  videoUrl: h.videoUrl || h.pageUrl || '',
  pageUrl: h.pageUrl || '',
  duration: h.duration || 0,
  isHLS: !!h.isHLS,
  sourceSite: h.sourceSite || '',
  type: 'History',
  isAdult: h.isAdult || 0
});

const toIptvCard = (item) => ({
  id: item.id,
  videoTitle: item.title,
  title: item.title,
  category: item.category || 'Uncategorized',
  thumbnailUrl: item.thumbnailUrl || '',
  videoUrl: item.videoUrl,
  duration: item.duration || 0,
  isHLS: !!item.httpHeaders || /(\.m3u8|m3u8)/i.test(item.videoUrl || ''),
  sourceSite: 'IPTV',
  type: 'Web TV',
  httpHeaders: item.httpHeaders,
  lastPosition: item.lastPosition || 0,
  isAdult: item.isAdult || 0,
  isOnline: item.is_online !== undefined ? (Number(item.is_online) === 1) : true,
  lastChecked: item.last_checked || 0
});

const favToCard = (f) => ({
  id: f.media_id || f.id,
  videoTitle: f.title || f.videoTitle || 'Untitled',
  category: f.sourceSite || f.category || f.type || 'Favorite',
  thumbnailUrl: f.thumbnailUrl || '',
  videoUrl: f.videoUrl || f.pageUrl || '',
  pageUrl: f.pageUrl || '',
  duration: f.duration || 0,
  isHLS: !!f.isHLS,
  sourceSite: f.sourceSite || f.provider || '',
  type: f.type || 'Favorite',
  artist: f.artist || f.provider || '',
  isAdult: f.isAdult || 0
});

// Live TV spotlight (v1.0.36): the user's own IPTV channels surfaced at the top
// of the Home feed. Highlights the most recently watched channel with a LIVE
// pill, then a strip of sibling channels — one click drops straight into a
// stream without opening the Live TV tab. Hidden entirely when no sources are
// imported (the caller passes an empty array).
const LiveTvSpotlight = ({ channels, onPlay, onOpenAll }) => {
  const { t } = useLanguage();
  if (!channels || channels.length === 0) return null;
  const featured = channels[0] || null;
  const strip = channels.slice(1, 9);
  return (
    <section className="home-tv">
      <div className="home-tv-head">
        <div>
          <h3 className="home-tv-head-title">{t('home.liveTv')}</h3>
          <p className="home-tv-head-sub">{t('home.liveTvSubtitle')}</p>
        </div>
        <button type="button" className="home-tv-open" onClick={onOpenAll}>
          {t('nav.liveChannels')} →
        </button>
      </div>

      {featured && (
        <button type="button" className="home-tv-featured" onClick={() => onPlay(featured)} title={featured.videoTitle}>
          <span className="home-tv-live-pill">● LIVE</span>
          <span className="home-tv-featured-name" title={featured.videoTitle}>
            {featured.videoTitle}
          </span>
          <span className="home-tv-featured-meta">{featured.category}</span>
          {featured.thumbnailUrl && (
            <img
              className="home-tv-featured-logo"
              src={featured.thumbnailUrl}
              alt=""
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          )}
        </button>
      )}

      {strip.length > 0 && (
        <div className="home-tv-strip">
          {strip.map((ch) => (
            <button key={ch.id} type="button" className="home-tv-chip" onClick={() => onPlay(ch)} title={ch.videoTitle}>
              {ch.thumbnailUrl && (
                <img
                  className="home-tv-chip-logo"
                  src={ch.thumbnailUrl}
                  alt=""
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <span className="home-tv-chip-name" title={ch.videoTitle}>{ch.videoTitle}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
};

const formatDuration = (seconds) => {
  if (!seconds || seconds <= 0) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
};

// Full-width spotlight banner above the shelves. The thumbnail is a plain
// <img> so we can gracefully degrade to a gradient when it 404s.
const HeroBanner = ({ item, loading, onPlay }) => {
  const { t } = useLanguage();
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => { setImageFailed(false); }, [item && (item.id || item.videoUrl)]);

  if (loading && !item) {
    return <div className="home-hero home-hero-skeleton skeleton" aria-hidden="true" />;
  }
  if (!item) return null;

  const title = item.videoTitle || item.title || t('home.featured');
  const badge = item.category || item.sourceSite || t('home.featured');
  const duration = formatDuration(item.duration);
  const showImage = item.thumbnailUrl && !imageFailed;

  return (
    <section className="home-hero">
      {showImage ? (
        <img
          className="home-hero-img"
          src={item.thumbnailUrl}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="home-hero-img home-hero-img-fallback" />
      )}
      <div className="home-hero-scrim" />
      <div className="home-hero-body">
        <span className="home-hero-badge">{badge}</span>
        <h2 className="home-hero-title" title={title}>{title}</h2>
        <p className="home-hero-meta">
          {item.sourceSite || t('home.web')}
          {duration ? ` · ${duration}` : ''}
        </p>
        <div className="home-hero-actions">
          <button type="button" className="home-hero-play" onClick={() => onPlay(item)}>
            ▶ {t('common.playNow')}
          </button>
        </div>
      </div>
    </section>
  );
};

const Discover = () => {
  const searchRef = useRef(null);
  const navigate = useNavigate();
  const { playVideo } = usePlayback();
  const { settings } = useAppSettings();
  const { t, language } = useLanguage();
  const familyMode = settings.familyMode;

  const [trending, setTrending] = useState([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [fallbacks, setFallbacks] = useState({ popular: [], news: [] });
  const [fallbacksLoading, setFallbacksLoading] = useState(false);
  const [iptvChannels, setIptvChannels] = useState([]);
  const [iptvStatus, setIptvStatus] = useState({});
  const [favorites, setFavorites] = useState([]);
  const [weights, setWeights] = useState({ genre: [], artist: [], tag: [] });
  const [recLoading, setRecLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const api = getApi();

    // Loaded only when trending comes back empty, so normal launches never pay
    // for these extra searches.
    const loadFallbacks = async () => {
      if (!api?.webSearch) return;
      if (alive) setFallbacksLoading(true);
      const [pop, news] = await Promise.all([
        api.webSearch({ mode: 'yt', query: FALLBACK_SHELVES[0].query, count: 14 }).catch(() => null),
        api.webSearch({ mode: 'yt', query: FALLBACK_SHELVES[1].query, count: 14 }).catch(() => null)
      ]);
      if (!alive) return;
      setFallbacks({
        popular: pop?.success ? (pop.videos || []) : [],
        news: news?.success ? (news.videos || []) : []
      });
      setFallbacksLoading(false);
    };

    const loadTrending = async () => {
      if (!api?.getTrending) {
        if (alive) setTrendingLoading(false);
        loadFallbacks();
        return;
      }
      try {
        const res = await api.getTrending(14);
        if (!alive) return;
        const videos = res?.success ? (res.videos || []) : [];
        setTrending(videos);
        if (videos.length === 0) loadFallbacks();
      } catch (err) {
        console.warn('[Home] Trending load failed:', err.message);
        if (alive) loadFallbacks();
      } finally {
        if (alive) setTrendingLoading(false);
      }
    };

    const loadHistory = async () => {
      if (!api?.getWatchHistory) { if (alive) setHistoryLoading(false); return; }
      try {
        const res = await api.getWatchHistory();
        if (alive && res?.success && Array.isArray(res.data)) setHistory(res.data);
      } catch (err) {
        console.warn('[Home] History load failed:', err.message);
      } finally {
        if (alive) setHistoryLoading(false);
      }
    };

    const loadIptv = async () => {
      if (!api?.getVideosBySource) return;
      try {
        const res = await api.getVideosBySource('IPTV');
        if (alive && res?.success && Array.isArray(res.data)) {
          const cards = res.data.map(toIptvCard).filter((v) => v.videoUrl);
          setIptvChannels(cards);
          // v1.0.54 stream availability sweep: probe the top branded/recent
          // channels in the background (main caches results for 24h) and mark
          // dead streams so the Home feed can steer clear of them.
          if (alive && api?.validateIptvStreams && cards.length > 0) {
            const brandedFirst = [...cards].sort((a, b) => {
              const ra = brandRank(a) < 0 ? Number.MAX_SAFE_INTEGER : brandRank(a);
              const rb = brandRank(b) < 0 ? Number.MAX_SAFE_INTEGER : brandRank(b);
              if (ra !== rb) return ra - rb;
              return (b.lastPosition || 0) - (a.lastPosition || 0);
            });
            api.validateIptvStreams(brandedFirst.slice(0, 24).map((c) => ({ id: c.id, videoUrl: c.videoUrl })))
              .then((vr) => {
                if (!alive || !vr?.success || !Array.isArray(vr.results)) return;
                setIptvStatus((prev) => {
                  const next = { ...prev };
                  for (const r of vr.results) {
                    if (!r || typeof r.online !== 'boolean') continue;
                    if (r.id) next[r.id] = r.online;
                    if (r.url) next[r.url] = r.online;
                  }
                  return next;
                });
              })
              .catch((err) => console.warn('[Home] IPTV availability sweep failed:', err.message));
          }
        }
      } catch (err) {
        console.warn('[Home] IPTV channels load failed:', err.message);
      }
    };

    const loadFavorites = async () => {
      if (!api?.getFavorites) return;
      try {
        const res = await api.getFavorites();
        if (alive && res?.success && Array.isArray(res.data)) setFavorites(res.data);
      } catch (err) {
        console.warn('[Home] Favorites load failed:', err.message);
      }
    };

    const baseWeights = { genre: [], artist: [], tag: [] };
    const loadWeights = async () => {
      if (!api?.getTopMediaWeights) { if (alive) setRecLoading(false); return; }
      try {
        const [g, a, t] = await Promise.all([
          api.getTopMediaWeights({ scope: 'genre', limit: 8 }),
          api.getTopMediaWeights({ scope: 'artist', limit: 6 }),
          api.getTopMediaWeights({ scope: 'tag', limit: 12 })
        ]);
        if (alive) {
          setWeights({
            genre: g?.success ? (g.data || []) : [],
            artist: a?.success ? (a.data || []) : [],
            tag: t?.success ? (t.data || []) : []
          });
        }
      } catch (err) {
        console.warn('[Home] Media weights load failed:', err.message);
        if (alive) setWeights(baseWeights);
      } finally {
        if (alive) setRecLoading(false);
      }
    };

    loadTrending();
    loadHistory();
    loadIptv();
    loadFavorites();
    loadWeights();
    const onSync = () => loadHistory();
    window.addEventListener('scrapers-synced', onSync);
    window.addEventListener('history-synced', onSync);
    return () => {
      alive = false;
      window.removeEventListener('scrapers-synced', onSync);
      window.removeEventListener('history-synced', onSync);
    };
  }, []);

  const filterFamily = useCallback(
    (list) => (familyMode ? list.filter((v) => !isAdultMedia(v)) : list),
    [familyMode]
  );

  const visibleHistory = useMemo(
    () => filterFamily(history.map(historyToCard).filter((v) => v.videoUrl || v.pageUrl)),
    [history, filterFamily]
  );

  const visibleTrending = useMemo(() => filterFamily(trending), [trending, filterFamily]);

  const visibleFallbackPopular = useMemo(() => filterFamily(fallbacks.popular), [fallbacks.popular, filterFamily]);
  const visibleFallbackNews = useMemo(() => filterFamily(fallbacks.news), [fallbacks.news, filterFamily]);

  const trendingEmpty = !trendingLoading && visibleTrending.length === 0;

  // Spotlight = top trending item, else the first curated fallback stream.
  const spotlight = visibleTrending[0] || visibleFallbackPopular[0] || null;

  // Live TV spotlight ordering (v1.0.54): dead streams (is_online=0, from the
  // availability sweep above or the cached DB flag) are dropped entirely, then
  // channels matching the active app language are prioritized, and within that
  // the FAMOUS_BRANDS ranking still leads. When fewer than 10 famous brands
  // match the app language, the feed falls back to the broader language-matched
  // list so the spotlight never goes empty. Winning ties break on most recent.
  const liveTvSorted = useMemo(() => {
    const langKeys = getLocaleLangKeys(language);
    const online = (ch) => {
      if (iptvStatus[ch.id] !== undefined) return iptvStatus[ch.id];
      if (iptvStatus[ch.videoUrl] !== undefined) return iptvStatus[ch.videoUrl];
      return ch.isOnline !== false;
    };
    const channels = filterFamily(iptvChannels).filter(online);
    const match = (ch) => langMatches(ch, langKeys);
    const inLang = channels.filter(match);
    const brandInLang = inLang.filter((ch) => brandRank(ch) >= 0).length;
    // With enough famous brands in the app language the feed stays themed to
    // that language; when fewer than 10 brands match it falls back to the full
    // online pool so neutral global channels (e.g. "HBO 2") never vanish.
    const pool = brandInLang >= 10 ? inLang : channels;
    const rankOf = (ch) => {
      const r = brandRank(ch);
      return r < 0 ? Number.MAX_SAFE_INTEGER : r;
    };
    return [...pool]
      .map((ch) => ({ ch, lang: match(ch) ? 0 : 1, brand: rankOf(ch), numeric: isRegionalNumeric(ch) ? 1 : 0 }))
      .sort((a, b) => {
        if (a.lang !== b.lang) return a.lang - b.lang;
        if (a.brand !== b.brand) return a.brand - b.brand;
        if (a.numeric !== b.numeric) return a.numeric - b.numeric;
        return (b.ch.lastPosition || 0) - (a.ch.lastPosition || 0);
      })
      .map((x) => x.ch);
  }, [iptvChannels, filterFamily, language, iptvStatus]);

  // "Recommended For You" (v1.0.36): rank watch history + favorites against the
  // genre/artist/tag media weights, so continuing playback feeds the shelf with
  // real signal. No weights stored yet → empty list → shelf shows the hint.
  const recommended = useMemo(() => {
    const genre = new Map();
    (weights.genre || []).forEach((w) => {
      const k = String(w.genre || '').toLowerCase();
      if (k) genre.set(k, Math.max(genre.get(k) || 0, Number(w.score) || 0));
    });
    const artist = new Map();
    (weights.artist || []).forEach((w) => {
      const k = String(w.artist || '').toLowerCase();
      if (k) artist.set(k, Math.max(artist.get(k) || 0, Number(w.score) || 0));
    });
    const tags = (weights.tag || []).map((w) => String(w.tag || '').toLowerCase()).filter(Boolean);
    if (!genre.size && !artist.size && tags.length === 0) return [];

    const candidates = [...visibleHistory, ...favorites.map(favToCard)];
    const seen = new Set();
    const scored = [];

    for (const c of candidates) {
      if (familyMode && isAdultMedia(c)) continue;
      const key = c.videoUrl || c.pageUrl || c.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);

      let s = 0;
      const hay = [c.category, c.sourceSite, c.type, c.artist]
        .filter(Boolean)
        .map((x) => String(x).toLowerCase());
      for (const h of hay) {
        if (genre.has(h)) s += genre.get(h);
        if (artist.has(h)) s += artist.get(h);
      }
      const title = String(c.videoTitle || '').toLowerCase();
      for (const tg of tags) {
        if (tg && title.includes(tg)) s += 2;
      }
      if (s > 0) scored.push({ c, s });
    }

    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 14).map((x) => x.c);
  }, [visibleHistory, favorites, weights, familyMode]);

  const handleTile = useCallback((tile) => {
    if (tile.route) { navigate(tile.route); return; }
    if (searchRef.current?.runSearch) searchRef.current.runSearch(tile.query);
  }, [navigate]);

  const tiles = (
    <div className="home-tiles">
      {TOPIC_TILES.map((tile) => (
        <button
          key={tile.key}
          type="button"
          className="home-tile"
          style={{ '--tile-accent': tile.accent }}
          onClick={() => handleTile(tile)}
        >
          <span className="home-tile-emoji">{tile.emoji}</span>
          <span className="home-tile-label">{t('home.tile.' + tile.key)}</span>
        </button>
      ))}
    </div>
  );

  const shelves = (
    <>
      <LiveTvSpotlight channels={liveTvSorted} onPlay={playVideo} onOpenAll={() => navigate('/iptv')} />

      <HeroBanner item={spotlight} loading={trendingLoading} onPlay={playVideo} />

      <MediaShelf
        title={t('home.watchAgain')}
        subtitle={t('home.watchAgainSubtitle')}
        items={visibleHistory}
        loading={historyLoading}
        onSelectVideo={playVideo}
      />

      <MediaShelf
        title={t('home.recommended')}
        subtitle={t('home.recommendedSubtitle')}
        items={recommended}
        loading={recLoading}
        onSelectVideo={playVideo}
        emptyHint={t('home.recommendedEmptyHint')}
      />

      <MediaShelf
        title={t('home.trending')}
        subtitle={t('home.trendingSubtitle')}
        items={visibleTrending}
        loading={trendingLoading}
        onSelectVideo={playVideo}
      />

      {trendingEmpty && (
        <>
          <MediaShelf
            title={t(FALLBACK_SHELVES[0].titleKey)}
            subtitle={t('home.fallbackPopularSubtitle')}
            items={visibleFallbackPopular}
            loading={fallbacksLoading}
            onSelectVideo={playVideo}
            emptyHint={t('home.fallbackEmptyHint')}
          />
          <MediaShelf
            title={t(FALLBACK_SHELVES[1].titleKey)}
            subtitle={t('home.fallbackNewsSubtitle')}
            items={visibleFallbackNews}
            loading={fallbacksLoading}
            onSelectVideo={playVideo}
            emptyHint={t('home.fallbackEmptyHint')}
          />
        </>
      )}
    </>
  );

  return (
    <VideoSearchSection
      ref={searchRef}
      title={t('nav.home')}
      subtitle={t('page.home.subtitle')}
      placeholder={t('home.searchPlaceholder')}
      hint={t('home.searchHint')}
      tags={{ category: 'YouTube', sourceSite: 'YouTube', type: 'Web Video' }}
      accent="#3b82f6"
      belowSearch={tiles}
      shelves={shelves}
    />
  );
};

export default Discover;
