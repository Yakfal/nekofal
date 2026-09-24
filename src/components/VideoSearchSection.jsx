import React, { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { autoSync, getCloudState, getMediaId, favoritePayloadFor, isPageUrl } from '../services/dbAdapter.js';
import PlaylistMenu from './PlaylistMenu.jsx';
import './VideoSearchSection.css';

// Universal-mode mirror of the server-side junk gate. Even though every
// engine above already rejected bookmarks/login/premium/upgrade cards via the
// shared hardened arrays, the fan-out merge re-checks titles once more so a
// merged card can never be a bookmark / log-in / sign-in / premium tile.
const JUNK_UNIVERSAL_TITLE = /^(?:sign[- ]?in|log[- ]?in|logs*in|signs*in|signs*up|sign[- ]?up|register|creates+an?s+account|bookmarks?|watchs*[- ]?later|premiums*(?:account)?|upgrade(?:s+tos+(?:premium|gold|vip))?|gos+premium|joins+(?:now|today)?|joins+fors+free|joins*free|frees+account|frees+s+account|creates+s+an?s+frees+account|welcomes*back|mys+(?:favorites|liked)|videoss+is+like|settings|account|home|clear|favorites|next|tops+creatorss+live|news+channel|xnxxs+gold|uncensoreds+hentai|ais+hentai|ais+hentai|latests+releases|mosts+(?:popular|liked|recent)|bests+videos?|bests+video|bests+of|bests*|bests+amateurs?|amateurs+videos?|amateur|amateur+porn|animes?|animated|animations?|animateds+videos?|cartoons?(?:s+videos?|s+porn)?|cartoony|uncensor(?:ed|s+uncensored)?|hentais+porn|new+s+videos?|latests+porn|populars+videos?|trendings+videos?|mores+videos?|nexts+page|views+all|browses+channels|channels?|videos+like)??$/i;
function isJunkUniversalTitle(t) {
  const s = String(t || '').trim().replace(/[.!?…]+$/g, '').trim();
  if (!s || s.length < 5) return true;
  return JUNK_UNIVERSAL_TITLE.test(s);
}

// Safe/All-source toggle: when safeOnly is on, only well-known, hardened
// adult hostnames participate in the universal fan-out.
const SAFE_ADULT_HOST_RE = /(^|.)(hanime.tv|xvideos.com|xnxx.com|xhamster(2)?.com|xhamster.com|pornhub.com|spankbang.com)$/i;
function isSafeAdultHost(u) {
  try {
    const host = new URL(String(u || '')).hostname.replace(/^www\./i, '');
    return SAFE_ADULT_HOST_RE.test(host);
  } catch {
    return false;
  }
}

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

const VideoSearchSection = forwardRef(({
  title,
  subtitle,
  placeholder = null,
  tags,
  siteUrl = null,
  allSites = null,
  safeOnly = false,
  hint = '',
  accent = '#3b82f6',
  belowSearch = null,
  shelves = null
}, ref) => {
  const { t } = useLanguage();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [results, setResults] = useState([]);
  const [searchInfo, setSearchInfo] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const countRef = useRef(0);
  // Mirror of `results` used for synchronous dedupe when appending pages.
  const resultsRef = useRef([]);
  const [addedIds, setAddedIds] = useState(() => new Set());
  // Favorite ROWS from the DB (not a shared id Set). Each card verifies its OWN
  // canonical pageUrl/id against this list, so a single card's star can never
  // bleed into the rest of the grid.
  const [favorites, setFavorites] = useState([]);
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
  const reloadFavorites = useCallback(() => {
    const api = getApi();
    if (!api?.getFavorites) return Promise.resolve();
    return api.getFavorites()
      .then((res) => {
        if (res?.success && Array.isArray(res.data)) setFavorites(res.data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    reloadFavorites();
    window.addEventListener('favorites-synced', reloadFavorites);
    window.addEventListener('scrapers-synced', reloadFavorites);
    return () => {
      window.removeEventListener('favorites-synced', reloadFavorites);
      window.removeEventListener('scrapers-synced', reloadFavorites);
    };
  }, [reloadFavorites]);

  // Strict per-card match: a card is favorited only when a stored row shares
  // THIS card's canonical pageUrl or its own unique id.
  const isCardFavorited = useCallback((v) => {
    return favorites.some((f) => {
      if (v.pageUrl && f.pageUrl && String(f.pageUrl) === String(v.pageUrl)) return true;
      if (v.id && f.id && String(f.id) === String(v.id)) return true;
      return false;
    });
  }, [favorites]);

  // Runs a search from either the form or an external trigger (Home topic
  // tiles). Kept imperative so callers can pre-fill the box and fire at once.
  // Universal (one box → ALL adult engines at once). When `allSites` is
  // given, the single keyword fans out to every site's searchTemplate in
  // parallel, then merges + de-dupes. Each engine's results were ALREADY
  // junk-gated server-side (bookmarks/login/premium cards rejected through the
  // shared SCRAPE arrays), so the merge can only ever hold real playable
  // videos. A final title mirror re-checks the merged list so a merge can
  // never reintroduce a bookmark/login/premium tile.
  const JUNK_TITLE_RE = /^(?:sign|log)[- ]?in$|^sign[- ]?up$|^register$|^bookmarks?$|^premium\s*account?$|^upgrade$|^vip$|^join now$|^welcome back$/i;

  const PAGE_SIZE = 30;

  // Resets the search box to pristine "Home lobby" state: empty query, no
  // results/meta/error, page back to 1. Used by the clear ✕ button and by the
  // sidebar Home-link interceptor below.
  const clearSearch = useCallback(() => {
    setQuery('');
    setResults([]);
    resultsRef.current = [];
    setSearchInfo(null);
    setSearchError(null);
    setPage(1);
    setHasMore(false);
    countRef.current = 0;
    if (inputRef.current) inputRef.current.focus();
  }, []);

  // Sidebar "Home" interceptor: when the user is ALREADY on the Home page and
  // clicks Home again, the click clears the active search (returning the Home
  // lobby) instead of being a no-op navigation. Adult's search box ignores this
  // event key (only fires on /discover), so it can never clear that page.
  useEffect(() => {
    const onClearHomeSearch = () => clearSearch();
    window.addEventListener('nek-clear-home-search', onClearHomeSearch);
    return () => window.removeEventListener('nek-clear-home-search', onClearHomeSearch);
  }, [clearSearch]);

  // Executes one search page. `append=false` (fresh search) replaces results,
  // `append=true` (Load More) pushes page+1 results onto the grid, de-duping
  // against what is already shown so pagination never double-shows a card.
  const performSearch = useCallback(async (q, { pageArg = 1, append = false } = {}) => {
    if (append) setLoadingMore(true);
    else setSearching(true);
    setSearchError(null);
    if (!append) { setResults([]); setSearchInfo(null); }
    try {
      const api = getApi();
      if (!api?.webSearch) {
        setSearchError(t('search.browserUnavailable'));
        setSearching(false);
        setLoadingMore(false);
        return;
      }
      const count = PAGE_SIZE;
      // Universal mode: fan out the SAME query to ALL adult engines in
      // parallel, then merge + dedupe. Every per-engine result was already
      // junk-gated server-side (shared SCRAPE_FILTER_PATH /
      // SCRAPER_TITLE_BLACKLIST reject bookmarks, log-in, sign-in, premium,
      // upgrade cards on every engine), so this merged list can only contain
      // REAL playable videos.
      if (Array.isArray(allSites) && allSites.length > 0) {
        const fanOut = allSites
          .filter((s) => !safeOnly || isSafeAdultHost(s?.homepage || s?.searchTemplate || ''))
          .map((s) => {
            const siteSrc = String(s?.searchTemplate || '').trim() || String(s?.homepage || '').trim() || undefined;
            return api.webSearch({
              mode: 'site',
              query: q,
              siteUrl: siteSrc,
              count,
              page: pageArg,
              gatewayUrl: getGatewayUrl()
            }).then((r) => ({ site: s, r })).catch((e) => ({ site: s, r: null, err: e }));
          });
        const settled = await Promise.all(fanOut);
        const merged = [];
        const seen = new Set();
        for (const { site, r, err } of settled) {
          const videos = (r && r.success && Array.isArray(r.videos)) ? r.videos : [];
          for (const v of videos) {
            const key = String(v.id || v.pageUrl || v.videoUrl || '');
            if (!key || seen.has(key)) continue;
            if (!v.title || isJunkUniversalTitle(v.title)) continue;
            seen.add(key);
            merged.push({ ...v, sourceSite: v.sourceSite || site?.name || v.sourceSite });
          }
        }
const mode = 'site';
        if (append) {
          const prev = resultsRef.current;
          const known = new Set(prev.map((v) => String(v.id || v.pageUrl || v.videoUrl || '')));
          const fresh = merged.filter((v) => !known.has(String(v.id || v.pageUrl || v.videoUrl || '')));
          resultsRef.current = [...prev, ...fresh];
          setResults(resultsRef.current);
          setHasMore(fresh.length > 0);
          countRef.current += fresh.length;
          setSearchInfo({ count: countRef.current, source: 'universal', mode });
        } else if (merged.length > 0) {
          countRef.current = merged.length;
          resultsRef.current = merged;
          setResults(merged);
          setHasMore(merged.length >= count);
          setSearchInfo({ count: countRef.current, source: 'universal', mode });
        } else {
          countRef.current = 0;
          resultsRef.current = [];
          setHasMore(false);
          setSearchInfo({ count: 0, source: 'universal', mode });
        }
        return;
      }

      // Detect: full URL -> enumerate that page
      const isUrl = /^https?:\/\//i.test(q);
      let mode = 'enum';
      let targetTemplate = null;
      if (!isUrl && siteUrl) mode = 'site';
      else if (!isUrl) mode = 'yt';

      const res = await api.webSearch({
        mode,
        query: q,
        siteUrl: targetTemplate || siteUrl || undefined,
        count,
        page: pageArg,
        gatewayUrl: getGatewayUrl()
      });
      if (res?.success) {
        const incoming = res.videos || [];
        const source = res.source === 'yt-dlp' ? 'yt-dlp' : res.source === 'gateway' || (res.source || '').includes('gateway') ? 'server gateway' : 'HTML';
        const metaMode = mode === 'site' ? 'site' : isUrl ? 'url' : 'search';
        if (append) {
          const prev = resultsRef.current;
          const known = new Set(prev.map((v) => String(v.id || v.pageUrl || v.videoUrl || '')));
          const fresh = incoming.filter((v) => !known.has(String(v.id || v.pageUrl || v.videoUrl || '')));
          resultsRef.current = [...prev, ...fresh];
          setResults(resultsRef.current);
          setHasMore(fresh.length > 0);
          countRef.current += fresh.length;
          setSearchInfo({ count: countRef.current, source, mode: metaMode });
        } else {
          countRef.current = incoming.length;
          resultsRef.current = incoming;
          setResults(incoming);
          setHasMore(incoming.length >= count);
          setSearchInfo({ count: countRef.current, source, mode: metaMode });
          if (incoming.length === 0) {
            setSearchError(t('search.foundNothing'));
          }
        }
      } else {
        setHasMore(false);
        setSearchError(res?.error || res?.details || t('search.searchFailed'));
        if (!append) setResults([]);
      }
    } catch (err) {
      console.error('[Search] failed:', err);
      setHasMore(false);
      setSearchError(`${t('search.searchFailed')}: ${err.message}`);
    } finally {
      setSearching(false);
      setLoadingMore(false);
    }
  }, [query, siteUrl, allSites, safeOnly, showToast, t]);

  const runSearch = useCallback(async (rawOverride) => {
    const q = String(rawOverride != null ? rawOverride : query || '').trim();
    setQuery(q);
    if (!q) { showToast(t('search.typeNameOrPaste'), 'err'); return; }

    setPage(1);
    await performSearch(q, { pageArg: 1, append: false });
  }, [query, performSearch, showToast, t]);

  const loadMore = useCallback(() => {
    if (searching || loadingMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    performSearch(query, { pageArg: nextPage, append: true });
  }, [page, query, searching, loadingMore, performSearch]);

  const handleSearch = (e) => {
    e?.preventDefault();
    runSearch();
  };

  useImperativeHandle(ref, () => ({
    runSearch,
    setQuery,
    clearSearch,
    focus: () => { if (inputRef.current) inputRef.current.focus(); }
  }), [runSearch, clearSearch]);

  const handleAddOne = async (v) => {
    try {
      const api = getApi();
      const res = await api.addVideos([{ ...v, category: (tags?.category || v.category || 'Video') }], tags);
      if (res?.success && res.inserted > 0) {
        setAddedIds(prev => new Set(prev).add(v.id));
        showToast(`${t('search.saved')} "${v.title}" ${t('search.toYourLibrary')}`);
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        setAddedIds(prev => new Set(prev).add(v.id));
        showToast(`"${v.title}" ${t('search.alreadyInLibrary')}`);
      }
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'err');
    }
  };

  const handleSaveAll = async () => {
    const fresh = results.filter(v => !addedIds.has(v.id));
    if (fresh.length === 0) { showToast(t('search.everythingSaved')); return; }
    try {
      const api = getApi();
      const res = await api.addVideos(fresh, tags);
      if (res?.success) {
        setAddedIds(prev => new Set([...prev, ...fresh.map(v => v.id)]));
        showToast(`${t('search.saved')} ${res.inserted || fresh.length} ${t('library.videos')} ${t('search.toYourLibrary')}`);
        window.dispatchEvent(new Event('scrapers-synced'));
      }
    } catch (err) {
      showToast('Failed to save: ' + err.message, 'err');
    }
  };

  const handleToggleFavorite = async (v) => {
    const key = v.id || getMediaId(v);
    const identifiable = Boolean((v.pageUrl && String(v.pageUrl).trim()) || (v.id && String(v.id).trim()));
    if (!identifiable || !key) { showToast(t('search.cannotFavorite'), 'err'); return; }
    setTogglingId(key);
    try {
      const api = getApi();
      const payload = favoritePayloadFor(v);
      if (tags && tags.type && !v.type) payload.type = tags.type;
      if (tags && tags.isAdult) payload.isAdult = true;
      const res = await api.toggleFavorite(payload);
      if (res?.success) {
        const favorited = res.data ? res.data.favorited : res.favorited;
        await reloadFavorites();
        showToast(favorited ? t('search.addedToFavorites') : t('search.removedFromFavorites'));
        autoSync();
      } else {
        showToast(t('search.favoriteFailed'), 'err');
      }
    } catch (err) {
      showToast(t('search.favoriteFailed'), 'err');
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
        <div className="vss-input-wrap">
          <input
            ref={inputRef}
            type="text"
            className="vss-input"
            placeholder={placeholder ?? t('search.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('common.search')}
          />
          {query && (
            <button
              type="button"
              className="vss-clear"
              onClick={clearSearch}
              aria-label={t('common.search') + ' ✕'}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
        <button type="submit" className="vss-go" disabled={searching}>
          {searching ? t('common.searching') : t('common.search')}
        </button>
      </form>
      {hint && <p className="vss-hint">{hint}</p>}

      {belowSearch}

      {shelves && !searching && results.length === 0 && (
        <div className="vss-shelves">{shelves}</div>
      )}

      {searchInfo && (
        <div className="vss-meta">
          {searchInfo.count} {t('search.results')} · {t('search.via')} {searchInfo.source === 'server gateway' ? t('search.sourceGateway') : searchInfo.source === 'HTML' ? t('search.sourceHtml') : searchInfo.source}
          {results.length > 0 && (
            <>
              {' · '}
              <button className="vss-linkish" onClick={handleSaveAll}>{t('common.saveAll')}</button>
            </>
          )}
        </div>
      )}

      {searchError && (
        <div className="vss-error">
          <strong>{t('search.noResults')}</strong> {searchError}
        </div>
      )}

      {results.length > 0 && (
        <div className="vss-grid">
          {results.map((v) => {
            const added = addedIds.has(v.id);
            const favKey = v.id || getMediaId(v);
            const isFav = isCardFavorited(v);
            return (
              <div key={favKey} className="vss-card" data-id={favKey}>
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
                    <button className="vss-btn play" onClick={() => playVideo(toPlayerPayload(v))}>{t('common.play')}</button>
                    <button className="vss-btn add" onClick={() => handleAddOne(v)} disabled={added}>
                      {added ? '✔ ' + t('common.saved') : '+ ' + t('common.save')}
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
                      buttonTitle={t('common.addToPlaylist')}
                    />
                    <button
                      className={`vss-btn fav ${isFav ? 'active' : ''}`}
                      title={isFav ? t('common.removeFromFavorites') : t('common.addToFavorites')}
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

      {results.length > 0 && hasMore && !searching && (
        <div className="vss-more-wrap">
          <button className="vss-more" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? t('common.searching') : t('common.loadMore')}
          </button>
        </div>
      )}

      {toast && (
        <div className={`vss-toast ${toast.type === 'err' ? 'err' : ''}`}>{toast.msg}</div>
      )}
    </div>
  );
});

export default VideoSearchSection;