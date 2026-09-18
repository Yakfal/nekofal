import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import VideoSearchSection from '../components/VideoSearchSection.jsx';
import MediaShelf from '../components/MediaShelf.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import './Discover.css';

const getApi = () => window.api || window.electronAPI;

// Quick-start tiles: each either fires a pre-filtered search or opens a channel
// list, so a brand-new user reaches content in one click without typing.
const TOPIC_TILES = [
  { key: 'news', label: 'Live News', emoji: '📰', query: 'live news', accent: '#ef4444' },
  { key: 'music', label: 'Music 24/7', emoji: '🎵', query: 'lofi hip hop live radio', accent: '#8b5cf6' },
  { key: 'movies', label: 'Free Movies', emoji: '🎬', route: '/cinema', accent: '#f59e0b' },
  { key: 'radio', label: 'Live Radio', emoji: '📻', route: '/radio', accent: '#10b981' },
  { key: 'popular', label: 'Popular Today', emoji: '⭐', query: 'popular music videos this week', accent: '#3b82f6' }
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

const Discover = () => {
  const searchRef = useRef(null);
  const navigate = useNavigate();
  const { playVideo } = usePlayback();
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;

  const [trending, setTrending] = useState([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    let alive = true;
    const api = getApi();

    const loadTrending = async () => {
      if (!api?.getTrending) { setTrendingLoading(false); return; }
      try {
        const res = await api.getTrending(14);
        if (alive && res?.success) setTrending(res.videos || []);
      } catch (err) {
        console.warn('[Home] Trending load failed:', err.message);
      } finally {
        if (alive) setTrendingLoading(false);
      }
    };

    const loadHistory = async () => {
      if (!api?.getWatchHistory) return;
      try {
        const res = await api.getWatchHistory();
        if (alive && res?.success && Array.isArray(res.data)) setHistory(res.data);
      } catch (err) {
        console.warn('[Home] History load failed:', err.message);
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

  const visibleHistory = useMemo(() => {
    const list = history.map(historyToCard).filter((v) => v.videoUrl || v.pageUrl);
    return familyMode ? list.filter((v) => !isAdultMedia(v)) : list;
  }, [history, familyMode]);

  const visibleTrending = useMemo(
    () => (familyMode ? trending.filter((v) => !isAdultMedia(v)) : trending),
    [trending, familyMode]
  );

  const handleTile = useCallback((tile) => {
    if (tile.route) { navigate(tile.route); return; }
    if (searchRef.current?.runSearch) searchRef.current.runSearch(tile.query);
  }, [navigate]);

  const tiles = (
    <div className="home-tiles">
      {TOPIC_TILES.map((t) => (
        <button
          key={t.key}
          type="button"
          className="home-tile"
          style={{ '--tile-accent': t.accent }}
          onClick={() => handleTile(t)}
        >
          <span className="home-tile-emoji">{t.emoji}</span>
          <span className="home-tile-label">{t.label}</span>
        </button>
      ))}
    </div>
  );

  const shelves = (
    <>
      <MediaShelf
        title="Watch Again"
        subtitle="Pick up where you left off"
        items={visibleHistory}
        onSelectVideo={playVideo}
      />
      <MediaShelf
        title="Trending Videos"
        subtitle="What's hot on YouTube right now"
        items={visibleTrending}
        loading={trendingLoading}
        onSelectVideo={playVideo}
      />
    </>
  );

  return (
    <VideoSearchSection
      ref={searchRef}
      title="Home"
      subtitle="Search the web like YouTube — or jump straight into something popular."
      placeholder="Search any video, or paste a YouTube / video page URL…"
      hint="Names search YouTube (and anything yt-dlp can reach). Pasting a URL pulls every video on that page, playlist or channel."
      tags={{ category: 'YouTube', sourceSite: 'YouTube', type: 'Web Video' }}
      accent="#3b82f6"
      belowSearch={tiles}
      shelves={shelves}
    />
  );
};

export default Discover;
