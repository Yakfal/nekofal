// Minimal window.api stub for the VideoPlayer browser harness.
//
// The real VideoPlayer talks to Electron over IPC. For the playback harness we
// only need a shell that answers the calls the component makes on mount, plus
// ONE deliberate hook: `__videoUrl` lets the test inject the stream URL that
// `extractStream` resolves to (a locally-served MP4), so the component runs its
// genuine loadStream -> hls/native decision -> <video> pipeline.
//
// Every method returns a resolved promise in the shape the caller expects, so a
// missing method surfaces loudly as a test failure instead of silently hanging.

const noop = () => {};
const resolved = (value) => () => Promise.resolve(value);

export function installStubApi(config = {}) {
  const calls = [];

  const record = (name, fn) => (...args) => {
    calls.push({ name, args });
    if (typeof fn === 'function') return fn(...args);
    return undefined;
  };

  const api = {
    // ---- harness introspection -------------------------------------------
    __calls: calls,
    __videoUrl: config.videoUrl || '',
    __isHLS: !!config.isHLS,

    // ---- the one call that decides the stream ---------------------------
    // Mirrors main's `{ success, data: { videoUrl, ... } }` success shape.
    extractStream: record('extractStream', async () => ({
      success: true,
      data: {
        videoUrl: api.__videoUrl,
        isHLS: api.__isHLS,
        httpHeaders: null,
        formats: [],
        qualityLevels: [],
      },
    })),

    // ---- everything else: inert, but present and awaitable ---------------
    getVideoServerInfo: record('getVideoServerInfo', resolved({ port: 5001, token: 'harness' })),
    setStreamHeaders: record('setStreamHeaders', resolved({ success: true })),
    sniffStreams: record('sniffStreams', resolved({ success: true, streams: [] })),
    parseMasterStream: record('parseMasterStream', resolved({ success: true, levels: [] })),
    setFavorite: record('setFavorite', resolved({ success: true })),
    removeFavorite: record('removeFavorite', resolved({ success: true })),
    checkIsFavorite: record('checkIsFavorite', resolved(false)),
    toggleFavorite: record('toggleFavorite', resolved(false)),
    saveVideoPosition: record('saveVideoPosition', resolved({ success: true })),
    setWatchHistory: record('setWatchHistory', resolved({ success: true })),
    updateVideoAvailability: record('updateVideoAvailability', resolved({ success: true })),
    downloadVideo: record('downloadVideo', resolved({ success: true })),
    openMiniPlayer: record('openMiniPlayer', resolved({ success: true })),
  };

  window.api = api;
  window.electronAPI = api;
  return api;
}

export function stubCalls() {
  return (window.api && window.api.__calls) || [];
}

export function resetStubCalls() {
  if (window.api && Array.isArray(window.api.__calls)) window.api.__calls.length = 0;
}

export const noopForTests = noop;