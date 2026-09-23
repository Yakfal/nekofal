const { contextBridge, ipcRenderer } = require('electron');

// SECURITY: Only expose necessary IPC channels via contextBridge
const api = {
  
  // Video proxy server info (actual port/base URL — port may be dynamic)
  getVideoServerInfo: () => ipcRenderer.invoke('video:getServerInfo'),

  // App version from package.json (single source of truth for footer labels)
  getVersion: () => ipcRenderer.invoke('app:getVersion'),

  // Scraper: Run all configured scrapers and store in database
  runScrapers: (urls) => ipcRenderer.invoke('scrapers:run', urls || []),
  
  // Scraper: Extract stream URL from any URL using yt-dlp. formatId gives a
  // specific format; a { height } opts object caps the re-extraction at a
  // resolution tier (used by the standard-quality fallback menu items).
  extractStream: (url, formatIdOrOpts) => ipcRenderer.invoke('scrapers:extractStream',
    (typeof formatIdOrOpts === 'object' && formatIdOrOpts) ? { url, ...formatIdOrOpts } : { url, formatId: formatIdOrOpts }),

  // Web search / aggregation (YouTube search, or any URL/category/search page)
  webSearch: (params) => ipcRenderer.invoke('web:search', params),
  addVideos: (videos, tags) => ipcRenderer.invoke('web:addVideos', { videos, tags }),
  // Home feed: trending YouTube videos for the default Home shelves
  getTrending: (count) => ipcRenderer.invoke('web:trending', { count }),

  // Database operations for videos (scraped content)
  getVideos: (limit, offset) => ipcRenderer.invoke('db:getVideos', limit, offset),
  getVideoCategories: () => ipcRenderer.invoke('db:getVideoCategories'),
  getVideosBySource: (sourceSite) => ipcRenderer.invoke('db:getVideosBySource', sourceSite),

  // Scraper operations
  getScrapers: () => ipcRenderer.invoke('db:getScrapers'),
  saveScrapers: (scrapers) => ipcRenderer.invoke('db:saveScrapers', scrapers),

  // Database operations for favorites and history
  setFavorite: (videoData) => ipcRenderer.invoke('db:setFavorite', videoData),
  getFavorites: () => ipcRenderer.invoke('db:getFavorites'),
  removeFavorite: (videoId) => ipcRenderer.invoke('db:removeFavorite', videoId),
  
  // New database operations
  toggleFavorite: (videoData) => ipcRenderer.invoke('db:toggleFavorite', videoData),
  checkIsFavorite: (videoId) => ipcRenderer.invoke('db:checkIsFavorite', videoId),

  // Permanently delete a media item (also removes favorites/playlist references)
  deleteMedia: (videoId) => ipcRenderer.invoke('db:deleteMedia', videoId),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('playlists:list'),
  createPlaylist: (name, description) => ipcRenderer.invoke('playlists:create', { name, description }),
  deletePlaylist: (playlistId) => ipcRenderer.invoke('playlists:delete', playlistId),
  addToPlaylist: (playlistId, video) => ipcRenderer.invoke('playlists:addItem', { playlistId, video }),
  removeFromPlaylist: (itemId) => ipcRenderer.invoke('playlists:removeItem', itemId),
  getPlaylistItems: (playlistId) => ipcRenderer.invoke('playlists:items', playlistId),
  
  setWatchHistory: (videoData) => ipcRenderer.invoke('db:setHistory', videoData),
  getWatchHistory: () => ipcRenderer.invoke('db:getHistory'),

  // Media preference weights (Because You Watched / recommended mixes)
  addMediaWeight: (payload) => ipcRenderer.invoke('db:addMediaWeight', payload),
  getTopMediaWeights: (payload) => ipcRenderer.invoke('db:getTopMediaWeights', payload),

  // Database management
  clearAll: () => ipcRenderer.invoke('db:clearAll'),

  // IPTV / M3U playlist operations
  addIptvSource: (name, url) => ipcRenderer.invoke('iptv:addSource', { name, url }),
  getIptvSources: () => ipcRenderer.invoke('iptv:getSources'),
  removeIptvSource: (sourceId) => ipcRenderer.invoke('iptv:removeSource', sourceId),

  // IPTV pre-flight: probe which channel streams are actually reachable so
  // dead/geo-blocked channels can be filtered out of the channel list.
  probeIptvChannels: (channels) => ipcRenderer.invoke('iptv:probeChannels', { channels }),

  // IPTV stream availability validator with persistent caching (v1.0.54).
  // Mirrors probeIptvChannels but stores results in the videos table
  // (is_online + last_checked) so repeat checks within 24h are served from cache.
  validateIptvStreams: (channels) => ipcRenderer.invoke('iptv:validate-streams', { channels }),

  // Video download
  downloadVideo: (video) => ipcRenderer.invoke('video:download', video || {}),
  getDownloads: () => ipcRenderer.invoke('downloads:getState'),
  removeDownload: (downloadId) => ipcRenderer.invoke('downloads:remove', downloadId),
  revealDownload: (filePath) => ipcRenderer.invoke('downloads:reveal', filePath),

  // Playback position (resume support)
  saveVideoPosition: (videoId, lastPosition) => ipcRenderer.invoke('db:saveVideoPosition', videoId, lastPosition),

  // Floating mini-player (PiP)
  openMiniPlayer: (payload) => ipcRenderer.invoke('mini:open', payload),
  closeMiniPlayer: () => ipcRenderer.invoke('mini:close'),
  restoreMiniPlayer: (payload) => ipcRenderer.invoke('mini:restore', payload),
  onMiniPayload: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('mini:payload', subscription);
    return () => ipcRenderer.removeListener('mini:payload', subscription);
  },
  // Full player resumes in the main window after a mini-player Restore/Expand
  onMainOpenFromMini: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('mini:restore-in-main', subscription);
    return () => ipcRenderer.removeListener('mini:restore-in-main', subscription);
  },

  // Push live playback state to main for auto-float on window minimize.
  mediaActive: (state) => ipcRenderer.send('media:active', state),
  // Main tells the renderer to float to MiniPlayer when the window is minimized
  // during active playback (wire-video float handled by VideoPlayer via the
  // 'nek-float-to-mini' custom event dispatched here).
  onRequestMini: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('minimize-to-mini', subscription);
    return () => ipcRenderer.removeListener('minimize-to-mini', subscription);
  },

  // Register custom stream headers (referer/UA/cookies) for native injection
  setStreamHeaders: (url, headers) => ipcRenderer.invoke('streams:setHeaders', { url, headers }),

  // Universal custom-site scraper (stealth browser automation)
  customSearch: (baseUrl, query, count) =>
    ipcRenderer.invoke('scraper:autoSearch', { baseUrl, query, count }),

  // Network stream sniffer — load a page in the stealth browser and capture the
  // .m3u8/.mp4/iframe media requests it makes
  sniffStreams: (url, watchMs) =>
    ipcRenderer.invoke('scraper:sniff', { url, watchMs }),

  // Live stream-sniffed events pushed while a page is being sniffed
  onStreamSniffed: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('stream:sniffed', subscription);
    return () => ipcRenderer.removeListener('stream:sniffed', subscription);
  },
  offStreamSniffed: (callback) => {
    ipcRenderer.removeListener('stream:sniffed', callback);
  },

  // Backup / restore
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),

  // Global keyboard / media key shortcuts
  onGlobalMediaKey: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('global-media-key', subscription);
    return () => ipcRenderer.removeListener('global-media-key', subscription);
  },

  // Download progress events
  onDownloadProgress: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('download:progress', subscription);
    return () => ipcRenderer.removeListener('download:progress', subscription);
  },
  onDownloadCompleted: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('download:completed', subscription);
    return () => ipcRenderer.removeListener('download:completed', subscription);
  },
  onDownloadError: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('download:error', subscription);
    return () => ipcRenderer.removeListener('download:error', subscription);
  },
  onDownloadsState: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('downloads:state', subscription);
    return () => ipcRenderer.removeListener('downloads:state', subscription);
  },

  // Open DevTools
  openDevTools: () => ipcRenderer.send('app:openDevTools'),

  // Auto-updates (GitHub Releases)
  checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
  quitAndInstall: () => ipcRenderer.invoke('app:quitAndInstall'),
  onUpdateEvent: (callback) => {
    const subscription = (_event, data) => callback(data);
    ipcRenderer.on('app:update', subscription);
    return () => ipcRenderer.removeListener('app:update', subscription);
  },

  // Secure credential vault (OS-encrypted API keys / tokens)
  secrets: {
    set: (key, value) => ipcRenderer.invoke('vault:set', { key, value }),
    get: (key) => ipcRenderer.invoke('vault:get', key),
    list: () => ipcRenderer.invoke('vault:list'),
    remove: (key) => ipcRenderer.invoke('vault:delete', key)
  },

  // Error handling - listen for errors from main process
  onAppError: (callback) => {
    const subscription = (_error, data) => callback(data);
    ipcRenderer.on('app-error', subscription);
    return () => {
      ipcRenderer.removeListener('app-error', subscription);
    };
  }
};

// Expose via contextBridge with 'api' namespace
contextBridge.exposeInMainWorld('api', api);

// Also expose as 'electronAPI' for backward compatibility
contextBridge.exposeInMainWorld('electronAPI', api);

// Verify all required methods are exposed (dev only)
if (process.env.NODE_ENV === 'development') {
  const requiredMethods = [
    'getVideoServerInfo',
    'openMiniPlayer', 'closeMiniPlayer', 'restoreMiniPlayer', 'onMiniPayload',
    'onMainOpenFromMini', 'mediaActive', 'onRequestMini',
    'runScrapers', 'extractStream',
    'getVideos', 'getVideoCategories',
    'setFavorite', 'getFavorites', 'removeFavorite',
    'toggleFavorite', 'checkIsFavorite',
    'setWatchHistory', 'getWatchHistory',
    'clearAll', 'openDevTools'
  ];

  for (const method of requiredMethods) {
    if (!api[method]) {
      console.warn(`[preload.js] Missing method: ${method}`);
    }
  }
}

// Export types for TypeScript/ESLint
if (typeof process !== 'undefined' && process.type === 'worker') {
  module.exports = {};
} else {
  // Prevent access in worker context or other non-renderer processes
  Object.freeze(globalThis.api);
  Object.freeze(globalThis.electronAPI);
}