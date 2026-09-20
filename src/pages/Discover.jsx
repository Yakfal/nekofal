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
  const { t } = useLanguage();
  const familyMode = settings.familyMode;

  const [trending, setTrending] = useState([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [fallbacks, setFallbacks] = useState({ popular: [], news: [] });
  const [fallbacksLoading, setFallbacksLoading] = useState(false);

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

    loadTrending();
    loadHistory();
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
      <HeroBanner item={spotlight} loading={trendingLoading} onPlay={playVideo} />

      <MediaShelf
        title={t('home.watchAgain')}
        subtitle={t('home.watchAgainSubtitle')}
        items={visibleHistory}
        loading={historyLoading}
        onSelectVideo={playVideo}
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
