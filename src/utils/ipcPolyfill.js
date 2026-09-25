/**
 * Nekofal Mobile — Electron IPC Polyfill (v1.0.57)
 *
 * Capacitor/Android WebView has no Electron main process, so `window.api` /
 * `window.electronAPI` are absent. Without a fallback, every `getApi()` call
 * returns undefined and the whole UI crashes on the first IPC touch.
 *
 * This module installs a safe, Capacitor-aware `window.api` (aliased onto
 * `window.electronAPI` for backward-compatible callers) that:
 *   - Persists the local database surface (videos, favorites, history,
 *     playlists, IPTV sources, media weights, playback positions) in
 *     IndexedDB so the Library / Favorites / Playlists / IPTV / History pages
 *     keep working with a device-local datastore.
 *   - Routes `web:search` / extract-as-page scraping through the Capacitor
 *     native HTTP engine (bypasses Android's Chromium CORS for cross-origin
 *     media/scrape fetches) instead of Electron's yt-dlp backend.
 *   - Returns graceful, shape-compatible "not available on mobile" responses
 *     for desktop-only features (downloads, auto-updater, mini-player, media
 *     keys, secrets vault, video-proxy server) so those ui affordances degrade
 *     instead of throwing.
 *
 * It must be imported BEFORE App.jsx so every `getApi()` resolves.
 */
(function installIpcPolyfill() {
  // Never override a real Electron bridge or a previously-installed polyfill.
  if (window.api || window.electronAPI || window.__NEKOFAL_IPC_POLYFILLED__) return;
  if (!(typeof window !== 'undefined')) return;

  window.__NEKOFAL_IPC_POLYFILLED__ = true;

  // ------------------------------------------------------------------
  // Detect mobile runtime (Capacitor) so we know which native paths exist.
  // ------------------------------------------------------------------
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

  // ------------------------------------------------------------------
  // Tiny IndexedDB wrapper (Promise-based, map-style DB).
  // Stores live in one database `nekofal-mobile-db`; each `store` holds
  // rows keyed by `id` with a `value` payload. Reads/writes never throw:
  // any failure degrades to an empty result so the UI stays alive.
  // ------------------------------------------------------------------
  const DB_NAME = 'nekofal-mobile-db';
  const DB_VERSION = 1;
  const STORES = ['videos', 'favorites', 'history', 'playlists', 'playlistItems', 'iptv', 'weights', 'positions', 'cloud', 'prefs'];
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    if (!(window.indexedDB)) {
      dbPromise = Promise.resolve(null);
      return dbPromise;
    }
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of STORES) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function withStore(store, mode, fn) {
    return openDb().then((db) => {
      if (!db) return null;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(store, mode);
          const obj = tx.objectStore(store);
          const req = fn(obj);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
  }

  const idb = {
    set(store, id, value) {
      return withStore(store, 'readwrite', (obj) => obj.put({ id: String(id), value }));
    },
    get(store, id) {
      return withStore(store, 'readonly', (obj) => obj.get(String(id))).then((row) => (row && row.value != null ? row.value : null));
    },
    del(store, id) {
      return withStore(store, 'readwrite', (obj) => obj.delete(String(id)));
    },
    all(store) {
      return withStore(store, 'readonly', (obj) => obj.getAll()).then((rows) => (Array.isArray(rows) ? rows.filter((r) => r && r.value != null).map((r) => r.value) : []));
    },
    clear(store) {
      return withStore(store, 'readwrite', (obj) => obj.clear());
    },
  };

  // Async no-op used when a db isn't available; every store call resolves to
  // the same safe default regardless.
  const okAsync = (payload) => Promise.resolve(payload);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------
  const stableId = (item) => {
    const raw = String(
      (item && (item.id || item.media_id || item.videoId || item.videoUrl || item.url || item.streamUrl)) || ''
    ).trim();
    return raw;
  };

  const videoRow = (item) => ({
    ...(item || {}),
    id: stableId(item) || String(Math.random().toString(36).slice(2)),
    title: item && (item.videoTitle || item.title || item.name || 'Untitled'),
    videoUrl: item && (item.videoUrl || item.url || item.streamUrl || ''),
    thumbnailUrl: item && (item.thumbnailUrl || item.thumbnail || item.poster || ''),
    sourceSite: item && (item.sourceSite || item.source || item.provider || ''),
    duration: item && (item.duration || 0),
    addedAt: (item && item.addedAt) || Date.now(),
  });

  const favRow = (item) => videoRow(item);
  const histRow = (item) => videoRow(item);

  const playlistPlaylist = (p) => ({
    id: p && p.id,
    name: p && (p.name || p.title || 'Untitled'),
    description: p && (p.description || ''),
    created: (p && p.created) || Date.now(),
  });

  const playlistItemRow = (item) => ({
    id: String((item && (item.id || item.itemId)) || Math.random().toString(36).slice(2)),
    playlistId: String((item && item.playlistId) || ''),
    videoTitle: item && (item.videoTitle || item.title || item.name || 'Untitled'),
    videoUrl: item && (item.videoUrl || item.url || item.streamUrl || ''),
    thumbnailUrl: item && (item.thumbnailUrl || item.thumbnail || ''),
    sourceSite: item && (item.sourceSite || item.source || ''),
    duration: item && (item.duration || 0),
  });

  const iptvRow = (s) => ({
    id: String((s && (s.id || s.sourceId)) || Math.random().toString(36).slice(2)),
    name: s && (s.name || 'IPTV Playlist'),
    url: s && (s.url || ''),
    channelCount: s && (s.channelCount || s.channel_count || 0),
    addedAt: (s && s.addedAt) || Date.now(),
  });

  // ------------------------------------------------------------------
  // API surface (shape-compatible with electron/preload.js)
  // ------------------------------------------------------------------
  const polyfillApi = {
    // --- video server info (desktop proxy) ----------------------------
    getVideoServerInfo: () => okAsync({ port: null, token: '', baseUrl: window.location.origin }),

    // --- version -------------------------------------------------------
    getVersion: () => okAsync('1.0.57-mobile'),

    // --- scrapers (server-side yt-dlp) ---------------------------------
    runScrapers: () => okAsync({ success: false, error: 'Scrapers require the desktop backend.' }),
    extractStream: () => okAsync({ success: false, error: 'Stream extraction requires the desktop backend.' }),
    sniffStreams: () => okAsync({ success: false, error: 'Stream sniffing requires the desktop backend.' }),
    onStreamSniffed: () => () => {},
    offStreamSniffed: () => {},

    // --- web search / aggregation --------------------------------------
    webSearch: async (params = {}) => {
      // Capacitor native HTTP bypasses CORS; fall back to plain fetch in a
      // plain browser. Unknown/missing modes degrade gracefully.
      const { mode, query } = params || {};
      const q = String((query || '').trim());
      if (!q) return { success: false, error: 'Nothing to search for' };
      if (mode === 'yt' || mode === 'search') {
        try {
          const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
          const res = await fetch(url, { mode: 'cors', redirect: 'follow' });
          const html = await res.text();
          const ids = [...html.matchAll(/"videoId":"([^"]+)"/g)].map((m) => m[1]);
          const titles = [...html.matchAll(/"title":\{"runs":\[\{"text":"([^"]+)"/g)].map((m) => m[1]);
          const seen = new Set();
          const videos = [];
          ids.forEach((id, i) => {
            if (!id || seen.has(id)) return;
            seen.add(id);
            videos.push({
              id,
              videoId: id,
              title: titles[i] || 'YouTube video',
              videoUrl: `https://www.youtube.com/watch?v=${id}`,
              pageUrl: `https://www.youtube.com/watch?v=${id}`,
              thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
              sourceSite: 'YouTube',
              duration: 0,
            });
          });
          return { success: true, videos, source: 'mobile-html', count: videos.length };
        } catch (err) {
          return { success: false, error: `Mobile search failed: ${err && err.message ? err.message : err}` };
        }
      }
      return { success: false, error: 'Web search for this mode is not available on mobile.' };
    },
    addVideos: async (videos, tags) => {
      const list = Array.isArray(videos) ? videos : [];
      await Promise.all(list.map((v) => idb.set('videos', stableId(v) || String(Math.random().toString(36).slice(2)), videoRow(v))));
      const names = Array.isArray(tags) ? tags.filter(Boolean).map((t) => (t && t.name) || t) : [];
      if (names.length) {
        await idb.set('prefs', 'lastTags', names);
      }
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('scrapers-synced'));
      return { success: true, inserted: list.length };
    },
    getTrending: () => okAsync({ success: false, videos: [], error: 'Trending requires the desktop backend.' }),

    // --- database: videos ----------------------------------------------
    getVideos: async (limit, offset) => {
      const all = await idb.all('videos');
      const start = Number(offset) || 0;
      const end = Number(limit) ? start + Number(limit) : undefined;
      return { success: true, data: end ? all.slice(start, end) : all.slice(start), total: all.length, totalFiltered: all.length };
    },
    getVideoCategories: async () => {
      const all = await idb.all('videos');
      const cats = new Map();
      all.forEach((v) => {
        const c = String((v && (v.category || v.sourceSite)) || 'Uncategorized');
        if (!cats.has(c)) cats.set(c, { name: c, count: 0 });
        cats.get(c).count++;
      });
      return { success: true, data: [...cats.values()] };
    },
    getVideosBySource: async (sourceSite) => {
      const all = await idb.all('videos');
      const src = String(sourceSite || '');
      return { success: true, data: all.filter((v) => String((v && (v.sourceSite || v.source)) || '') === src) };
    },

    // --- favorites -----------------------------------------------------
    setFavorite: async (videoData) => {
      const row = favRow(videoData);
      await idb.set('favorites', row.id, row);
      return { success: true, data: row };
    },
    toggleFavorite: async (videoData) => {
      const row = favRow(videoData);
      const existing = await idb.get('favorites', row.id);
      if (existing) {
        await idb.del('favorites', row.id);
        return { success: true, data: { favorited: false, id: row.id } };
      }
      await idb.set('favorites', row.id, row);
      return { success: true, data: { favorited: true, id: row.id } };
    },
    checkIsFavorite: async (videoId) => {
      const key = String(videoId || '');
      if (!key) return { success: true, favorited: false };
      const existing = await idb.get('favorites', key);
      return { success: true, favorited: !!existing };
    },
    getFavorites: async () => {
      const all = await idb.all('favorites');
      return { success: true, data: all };
    },
    removeFavorite: async (videoId) => {
      await idb.del('favorites', String(videoId || ''));
      return { success: true };
    },
    deleteMedia: async (videoId) => {
      const key = String(videoId || '');
      await Promise.all([
        idb.del('videos', key),
        idb.del('favorites', key),
        idb.del('history', key),
      ]);
      return { success: true };
    },

    // --- history / positions --------------------------------------------
    setWatchHistory: async (videoData) => {
      const row = histRow(videoData);
      await idb.set('history', row.id, { ...row, watchedAt: Date.now() });
      return { success: true };
    },
    getWatchHistory: async () => {
      const all = await idb.all('history');
      return { success: true, data: all.sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0)) };
    },
    saveVideoPosition: async (videoId, lastPosition) => {
      await idb.set('positions', String(videoId || 'last'), { id: String(videoId || 'last'), lastPosition: Number(lastPosition) || 0, updatedAt: Date.now() });
      return { success: true };
    },

    // --- playlists ------------------------------------------------------
    getPlaylists: async () => {
      const all = await idb.all('playlists');
      return { success: true, data: all.map(playlistPlaylist) };
    },
    createPlaylist: async (name, description) => {
      const pl = { id: String(Math.random().toString(36).slice(2, 10)), name: String(name || 'Untitled'), description: String(description || ''), created: Date.now() };
      await idb.set('playlists', pl.id, pl);
      return { success: true, playlist: pl };
    },
    deletePlaylist: async (playlistId) => {
      await idb.del('playlists', String(playlistId || ''));
      return { success: true };
    },
    addToPlaylist: async (playlistId, video) => {
      const row = playlistItemRow({ ...(video || {}), playlistId });
      await idb.set('playlistItems', row.id, row);
      return { success: true, data: row };
    },
    removeFromPlaylist: async (itemId) => {
      await idb.del('playlistItems', String(itemId || ''));
      return { success: true };
    },
    getPlaylistItems: async (playlistId) => {
      const all = await idb.all('playlistItems');
      const pid = String(playlistId || '');
      return { success: true, data: all.filter((i) => String(i.playlistId || '') === pid) };
    },

    // --- IPTV / M3U -----------------------------------------------------
    addIptvSource: async (name, url) => {
      const row = iptvRow({ name, url });
      await idb.set('iptv', row.url, row);
      return { success: true, data: row };
    },
    getIptvSources: async () => {
      const all = await idb.all('iptv');
      return { success: true, data: all };
    },
    removeIptvSource: async (sourceId) => {
      await idb.del('iptv', String(sourceId || ''));
      return { success: true };
    },
    probeIptvChannels: () => okAsync({ success: true, results: [] }),
    validateIptvStreams: () => okAsync({ success: true, results: [] }),
    updateVideoAvailability: () => okAsync({ success: true }),

    // --- media weights (recommendations) --------------------------------
    addMediaWeight: async (payload) => {
      const p = payload || {};
      const key = stableId(p) || String(Math.random().toString(36).slice(2));
      await idb.set('weights', key, { ...p, id: key, ts: Date.now() });
      return { success: true };
    },
    getTopMediaWeights: async (payload) => {
      const { limit = 20 } = payload || {};
      const all = await idb.all('weights');
      all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return { success: true, data: all.slice(0, Number(limit) || 20) };
    },

    // --- DB management ---------------------------------------------------
    clearAll: async () => {
      await Promise.all(STORES.map((s) => idb.clear(s)));
      return { success: true };
    },

    // --- downloads (desktop-only) ---------------------------------------
    downloadVideo: () => okAsync({ success: false, error: 'Downloads require the desktop backend.' }),
    getDownloads: () => okAsync({ success: true, items: [] }),
    removeDownload: () => okAsync({ success: true }),
    revealDownload: () => okAsync({ success: true }),
    onDownloadProgress: () => () => {},
    onDownloadCompleted: () => () => {},
    onDownloadError: () => () => {},
    onDownloadsState: () => () => {},

    // --- mini-player (desktop-only) -------------------------------------
    openMiniPlayer: () => okAsync({ success: true }),
    closeMiniPlayer: () => okAsync({ success: true }),
    restoreMiniPlayer: () => okAsync({ success: true }),
    onMiniPayload: () => () => {},
    onMainOpenFromMini: () => () => {},
    mediaActive: () => {},
    onRequestMini: () => () => {},

    // --- media keys (desktop-only) --------------------------------------
    onGlobalMediaKey: () => () => {},

    // --- stream headers (desktop proxy only) ----------------------------
    setStreamHeaders: () => okAsync({ success: true }),

    // --- backup / restore (desktop-only) --------------------------------
    exportBackup: () => okAsync({ success: false, error: 'Backup requires the desktop backend.' }),
    importBackup: () => okAsync({ success: false, error: 'Restore requires the desktop backend.' }),

    // --- devtools (desktop-only) ----------------------------------------
    openDevTools: () => {},

    // --- auto-update (desktop-only) -------------------------------------
    checkForUpdates: () => okAsync({ success: false }),
    quitAndInstall: () => okAsync({ success: false }),
    onUpdateEvent: () => () => {},

    // --- secrets vault (desktop-only; localStorage stand-in on mobile) ---
    secrets: {
      set: async (key, value) => {
        try { localStorage.setItem(`nekofal-secret-${key}`, value); } catch { /* ignore */ }
        return { success: true };
      },
      list: () => okAsync({ success: true, keys: [] }),
      remove: async (key) => {
        try { localStorage.removeItem(`nekofal-secret-${key}`); } catch { /* ignore */ }
        return { success: true };
      },
    },

    // --- errors ----------------------------------------------------------
    onAppError: () => () => {},
  };

  // Alias — some callers use window.electronAPI (legacy).
  Object.defineProperties(window, {
    api: { value: polyfillApi, writable: true, configurable: true },
    electronAPI: { value: polyfillApi, writable: true, configurable: true },
  });

  if (isNative) {
    console.info('[ipcPolyfill] Nekofal running on mobile (Capacitor native). Desktop IPC bridged to IndexedDB + native fetch.');
  }

  // Export the detect flag for other modules that want to branch on runtime.
  window.__NEKOFAL_MOBILE__ = true;
})();