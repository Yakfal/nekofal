import React, { useState, useEffect, useCallback, useRef } from 'react';
import Hls from 'hls.js';
import { autoSync, favoritePayloadFor, getMediaId } from '../services/dbAdapter.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { usePlayback, usePersistentPauseOnLeave } from '../contexts/PlaybackContext.jsx';
import './Cinema.css';

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata';

// The 1952ish+ formula used by the spec: the three public-domain collections,
// queried in one grouped expression so the default home page lists everything.
const COLLECTIONS = {
  'All Classic': null,
  'Classic Films': 'feature_films',
  'Silent Films': 'silent_films',
  'Classic TV': 'classic_tv_mimetypes'
};

const ALL_COLLECTIONS_QUERY =
  'collection:(classic_tv_mimetypes OR feature_films OR silent_films)';

// Display labels for the collection chips, keyed by the stable identifier so
// the state/logic always works on the English bucket names.
const COLLECTION_LABELS = {
  'All Classic': 'freeMovies.collectionAll',
  'Classic Films': 'freeMovies.collectionFilms',
  'Silent Films': 'freeMovies.collectionSilent',
  'Classic TV': 'freeMovies.collectionTv'
};

const toVideo = (doc) => ({
  id: doc.identifier,
  videoTitle: doc.title && String(doc.title).length > 140 ? String(doc.title).slice(0, 140) + '…' : (doc.title || doc.identifier),
  title: doc.title || doc.identifier,
  category: (doc.collection && doc.collection[0]) || 'Classic Cinema',
  thumbnailUrl: `https://archive.org/services/img/${doc.identifier}`,
  videoUrl: '',
  sourceSite: 'Classic Cinema',
  isAdult: 0,
  _identifier: doc.identifier,
  _year: doc.year || ''
});

// Mount HLS playback (hls.js) for classic items that expose a manifest. The
// modal participates in the global media coordinator: it announces its own play
// (playerId-tagged) and detaches the moment any other keep-alive surface starts
// a stream, so two sources are never decoding audio at once.
let cinemaInstanceSeq = 0;

function Cinema() {
  const { t } = useLanguage();
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const cinemaIdRef = useRef(`cinema-${++cinemaInstanceSeq}`);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef(null);
  const wasPlayingRef = useRef(false);
  const { notifyMediaPlaying } = usePlayback();

  // Tab-switch auto-pause (v1.0.36): leaving /cinema pauses the in-page modal
  // player WITHOUT tearing down hls.js, so the title, timestamp and quality
  // tier survive; returning resumes it only if it was playing when left.
  usePersistentPauseOnLeave(
    '/cinema',
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
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [input, setInput] = useState('');
  const [collection, setCollection] = useState('All Classic');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [activeVideo, setActiveVideo] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());
  const [togglingId, setTogglingId] = useState(null);

  // Load favorite ids once so archive.org cards reflect real DB state and the
  // star toggles immediately (shared db:toggleFavorite + cloud sync path).
  useEffect(() => {
    const api = window.api || window.electronAPI;
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

  const toggleFavoriteC = async (v) => {
    const key = getMediaId(v);
    if (!key) return;
    setTogglingId(key);
    try {
      const api = window.api || window.electronAPI;
      // Always store a playable archive.org URL so the favorite opens.
      const payload = favoritePayloadFor(v);
      if (!payload.url && key) {
        payload.url = `https://archive.org/download/${key}/${key}_512kb.mp4`;
      }
      const res = await api.toggleFavorite(payload);
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
      console.warn('[Cinema] favorite toggle failed:', err.message);
    } finally {
      setTogglingId(null);
    }
  };

  const buildQuery = useCallback((q, coll) => {
    // Collection scope: a single collection, or the grouped Classic trio.
    const collPart = coll && COLLECTIONS[coll]
      ? `collection:(${COLLECTIONS[coll].replace(/\s+/g, '_')})`
      : ALL_COLLECTIONS_QUERY;
    const trimmed = (q || '').trim();
    const titlePart = trimmed ? ` AND title:${trimmed.replace(/[()\[\]{}\\\"]/g, ' ')}` : '';
    return `${collPart} AND mediatype:movies${titlePart}`;
  }, []);

  const runSearch = useCallback(async (opts = {}) => {
    const q = opts.query != null ? opts.query : query;
    const coll = opts.collection != null ? opts.collection : collection;
    const pg = opts.page != null ? opts.page : 1;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('q', buildQuery(q, coll));
      params.set('fl[]', 'identifier,title,description,year');
      params.set('sort[]', 'downloads desc');
      params.set('rows', '30');
      params.set('page', String(pg));
      params.set('output', 'json');
      const res = await fetch(SEARCH_URL + '?' + params.toString(), { headers: { 'User-Agent': 'Nekofal/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const docs = (data?.response?.docs) || [];
      const list = docs.map(toVideo);
      if (pg === 1) setResults(list);
      else setResults(prev => [...prev, ...list]);
      if (pg === 1) setPage(1);
      setHasMore(list.length === 30);
    } catch (err) {
      console.error('[Cinema] search failed:', err);
      setError('Archive.org search failed: ' + err.message);
    } finally {
      setLoading(false);
      setSearching(false);
    }
  }, [buildQuery, query, collection]);

  useEffect(() => {
    runSearch({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickCollection = (key) => {
    setCollection(key);
    setInput('');
    setQuery('');
    setSearching(true);
    runSearch({ query: '', collection: key, page: 1 });
  };

  const submitSearch = (e) => {
    e.preventDefault();
    setQuery(input);
    setSearching(true);
    runSearch({ query: input, page: 1 });
  };

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    runSearch({ page: next });
  };

  const openVideo = async (video) => {
    setDetailLoading(true);
    setError('');
    try {
      const id = String(video._identifier || '');
      let finalUrl = '';

      // Resolve a playable source. Prefer an HLS manifest when the item ships
      // one (common for classic_tv_mimetypes), otherwise the spec's standard
      // `_512kb.mp4` derivative, otherwise any playable container.
      try {
        const metaRes = await fetch(`${METADATA_URL}/${id}`, { headers: { 'User-Agent': 'Nekofal/1.0' } });
        if (metaRes.ok) {
          const meta = await metaRes.json();
          const files = (Array.isArray(meta.files) ? meta.files : []).filter(f => f && f.name);
          const base = (meta.d1 && meta.dir)
            ? `https://${meta.d1}${meta.dir}`
            : `https://archive.org/download/${id}`;
          const hls = files.find(f => /\.m3u8$/i.test(f.name));
          if (hls) {
            finalUrl = `${base}/${encodeURIComponent(hls.name)}`;
          } else {
            const mp4 = files.find(f => f.name === `${id}_512kb.mp4`)
              || files.find(f => /_512kb\.mp4$/i.test(f.name))
              || files.find(f => /\.(mp4|webm|ogv)$/i.test(f.name));
            if (mp4) finalUrl = `${base}/${encodeURIComponent(mp4.name)}`;
          }
        }
      } catch (metaErr) {
        console.warn('[Cinema] metadata fetch failed, using direct URL:', metaErr.message);
      }

      // Spec fallback: the item's standard 512kb MP4 derivative, served directly
      // from archive.org/download — no extra title-page scraping required.
      if (!finalUrl) finalUrl = `https://archive.org/download/${id}/${id}_512kb.mp4`;

      setActiveVideo({ ...video, videoUrl: finalUrl, sourceSite: 'Classic Cinema' });
    } catch (err) {
      console.error('[Cinema] resolve failed:', err);
      setError('Could not load details for this title.');
    } finally {
      setDetailLoading(false);
    }
  };

  // Mount HLS playback (hls.js) for classic items that expose a manifest.
  useEffect(() => {
    const el = videoRef.current;
    if (!activeVideo || !el || !activeVideo.videoUrl) return undefined;
    const url = activeVideo.videoUrl;
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch (err) {}
      hlsRef.current = null;
    }
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    let hls = null;
    retryAttemptRef.current = 0;

    // Recover from temporary archive.org blips (server-side flakiness) with a
    // short backoff before showing a hard failure.
    const scheduleRetry = () => {
      if (retryAttemptRef.current >= 5) return;
      const attempt = retryAttemptRef.current + 1;
      retryAttemptRef.current = attempt;
      const delay = [800, 1600, 3200, 6400, 12800][Math.min(attempt - 1, 4)];
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        const cur = videoRef.current;
        if (!cur || !activeVideo) return;
        const pos = cur.currentTime || 0;
        if (hlsRef.current) hlsRef.current.startLoad();
        else {
          cur.src = activeVideo.videoUrl;
          if (pos > 0) { try { cur.currentTime = pos; } catch {} }
          cur.play().catch(() => {});
        }
      }, delay);
    };

    if (/\.m3u8([?#]|$)/i.test(url)) {
      if (Hls.isSupported()) {
        hls = new Hls();
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, () => { retryAttemptRef.current = 0; });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) scheduleRetry();
        });
        hls.loadSource(url);
        hls.attachMedia(el);
      } else {
        el.src = url;
      }
    } else {
      el.src = url;
    }
    el.onerror = () => scheduleRetry();
    el.onplaying = () => { retryAttemptRef.current = 0; };
    // Claim the global media slot so keep-alive panes (IPTV etc.) release
    // their own streams the moment this modal starts.
    notifyMediaPlaying('free', { playerId: cinemaIdRef.current });

    return () => {
      if (hlsRef.current === hls) hlsRef.current = null;
      if (hls) hls.destroy();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      el.onerror = null;
      el.onplaying = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVideo, videoRef]);

  // Another surface (IPTV pane, overlay full player, Adult/Flexible video)
  // started playback — release this modal's stream immediately. Events this
  // very player emitted (matched by playerId) are ignored.
  useEffect(() => {
    const onSourceActive = (e) => {
      const detail = (e && e.detail) || {};
      if (!detail.source) return;
      if (detail.playerId && detail.playerId === cinemaIdRef.current) return;
      const el = videoRef.current;
      if (hlsRef.current) {
        try { hlsRef.current.destroy(); } catch (err) {}
        hlsRef.current = null;
      }
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
      if (el) {
        try { el.pause(); } catch (err) {}
        el.onerror = null;
        el.onplaying = null;
      }
      // Another source owns the media slot now — cancel any pending
      // auto-resume so returning to /cinema never double-plays with it.
      wasPlayingRef.current = false;
    };
    window.addEventListener('nek-media-source-active', onSourceActive);
    return () => window.removeEventListener('nek-media-source-active', onSourceActive);
  }, []);

  return (
    <div className="cinema-page">
      <div className="cinema-header">
        <h1 className="page-title">{t('nav.freeMovies')}</h1>
        <p className="cinema-subtitle">{t('freeMovies.subtitle')}</p>
      </div>

      <div className="cinema-toolbar">
        <form className="cinema-searchform" onSubmit={submitSearch}>
          <input
            className="cinema-search"
            placeholder={t('freeMovies.searchPlaceholder')}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="cinema-btn primary" type="submit" disabled={loading}>{t('common.search')}</button>
        </form>
        <div className="cinema-cols">
          {Object.keys(COLLECTIONS).map(key => (
            <button
              key={key}
              className={`cinema-btn ${collection === key && !query ? 'active' : ''}`}
              onClick={() => pickCollection(key)}
            >
              {t(COLLECTION_LABELS[key] || key)}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="cinema-error">{error}</div>}

      {loading ? (
        <div className="cinema-loading">{t('freeMovies.loading')}</div>
      ) : results.length === 0 ? (
        <div className="cinema-empty"><p>{t('freeMovies.empty')}</p></div>
      ) : (
        <>
          <div className="cinema-grid">
            {results.map(v => {
              const favKey = getMediaId(v);
              const isFav = favoriteSet.has(favKey);
              return (
                <div key={v.id} className="cinema-card" onClick={() => openVideo(v)} role="button" tabIndex={0} aria-label={v.videoTitle}>
                  <div className="cinema-thumb">
                    <img src={v.thumbnailUrl} alt="" loading="lazy"
                      onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                    <span className="cinema-play">▶</span>
                    {v._year ? <span className="cinema-year">{v._year}</span> : null}
                  </div>
                  <div className="cinema-card-body">
                    <div className="cinema-title">{v.videoTitle}</div>
                    <div className="cinema-fav">
                      <button
                        className={`cinema-fav-btn ${isFav ? 'active' : ''}`}
                        title={isFav ? t('common.removeFromFavorites') : t('common.addToFavorites')}
                        aria-pressed={isFav}
                        disabled={togglingId === favKey}
                        onClick={(e) => { e.stopPropagation(); toggleFavoriteC(v); }}
                      >
                        {isFav ? '★' : '☆'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="cinema-more">
              <button className="cinema-btn primary" onClick={loadMore} disabled={loading || searching}>
                {t('common.loadMore')}
              </button>
            </div>
          )}
        </>
      )}

      {detailLoading && (
        <div className="cinema-modal-backdrop">
          <div className="cinema-modal">
            <p>{t('freeMovies.resolving')}</p>
            <div className="cinema-spinner"></div>
          </div>
        </div>
      )}

      {activeVideo && (
        <div className="cinema-modal-backdrop" onClick={() => setActiveVideo(null)}>
          <div className="cinema-modal large" onClick={(e) => e.stopPropagation()}>
            <button className="cinema-modal-close" onClick={() => setActiveVideo(null)}>✕</button>
            <div className="cinema-modal-title">{activeVideo.videoTitle}</div>
            {activeVideo.videoUrl ? (
              <video ref={videoRef} className="cinema-player" controls autoPlay />
            ) : (
              <p className="cinema-error">{t('freeMovies.noStream')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default Cinema;