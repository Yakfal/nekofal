const STREAM_URL_RE = /\.(m3u8|mp4)([?#].*)?$/i;

export function isMediaUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && STREAM_URL_RE.test(url);
}

export function pickBestStream(streams) {
  const list = Array.isArray(streams) ? streams : [];
  if (!list.length) return null;
  const master = list.find((s) => /master|(^|\/)[^/]*\.m3u8/i.test(String(s || '').toLowerCase())) || list[0];
  return master;
}

export async function autoSearch(baseUrl, query, count = 25) {
  const result = await window.api.customSearch(baseUrl, query, count);
  if (!result || !result.success) {
    throw new Error((result && result.error) || 'Custom site search failed');
  }
  return result.videos || [];
}

export async function sniffStreams(url, watchMs = 9000) {
  const result = await window.api.sniffStreams(url, watchMs);
  if (!result) throw new Error('Stream sniff returned no result');
  return result;
}

let sniffListener = null;

export function onSniffedStream(callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (payload) => callback(payload);
  const off = window.api.onStreamSniffed(handler);
  sniffListener = handler;
  return () => {
    if (off) off();
    sniffListener = null;
  };
}

export function cleanupSniffListener() {
  if (sniffListener) {
    window.api.offStreamSniffed && window.api.offStreamSniffed(sniffListener);
    sniffListener = null;
  }
}

// ---- YouTube canonical metadata helpers ---------------------------------------
// YouTube URLs arrive in several shapes (youtube.com/watch?v=, youtu.be/ID,
// /shorts|embed|live/ID, and raw googlevideo CDN streams). Favorites/history
// persist a canonical watch page URL so a saved item stays re-extractable long
// after its CDN stream URL rotates. These helpers mirror the canonicalization
// used at playback time (PlaybackContext) so every search surface agrees.
const YT_URL_RE = /(youtube\.com|youtu\.be|googlevideo\.com)/i;
// Strict 11-character YouTube video ID. /watch?v= (with any preceding query),
// shorts/, embed/, live/, v/ and youtu.be/ all embed it; the (?![\w-]) guard
// refuses to capture the first 11 chars of a longer token (query params, CDN
// hashes), so the extracted ID is always the exact video ID.
const YT_VIDEO_ID_RE = /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?![\w-])/i;

export function isYouTubeUrl(input) {
  return YT_URL_RE.test(String(input || ''));
}

export function getYouTubeVideoId(input) {
  const m = String(input || '').match(YT_VIDEO_ID_RE);
  return m ? m[1] : '';
}

export function canonicalYouTubePageUrl(input) {
  const id = getYouTubeVideoId(input);
  return id ? `https://www.youtube.com/watch?v=${id}` : String(input || '');
}

// Legacy CDN recovery: old app versions persisted googlevideo CDN stream URLs
// (or pages) as an item's pageUrl/videoUrl. Those links die (rotating signed
// URLs) and yt-dlp refuses them with MEDIA_ELEMENT_ERROR_FORMAT_ERROR-style
// failures. When such a URL carries an exact 11-character docid (preferred,
// YouTube's own video-id field) or an id that is neither the o- CDN-hash
// prefix nor a longer hash we rebuild the canonical youtube.com/watch?v= page
// so the item re-extracts cleanly forever. Long CDN hash ids (base64 / o-…)
// are deliberately ignored — they are not video IDs.
export function recoveredYouTubeWatchUrl(input) {
  const s = String(input || '');
  if (!/googlevideo\.com/i.test(s) && !/redirector\.googlevideo\.com/i.test(s)) return '';
  const vid = s.match(/[?&]docid=([a-zA-Z0-9_-]{11})(?![\w-])/)
    || s.match(/[?&]id=(?!o-)([a-zA-Z0-9_-]{11})(?![\w-])/);
  return vid ? `https://www.youtube.com/watch?v=${vid[1]}` : '';
}

// ---- Pornhub strict result sanitizer ---------------------------------------
// Mirror of the main-process strict filter (electron/main.js): a valid pornhub
// search hit MUST be a viewkey video page, must NOT point at a /language/
// filter, and must NOT be a bare language-name chip (English/French/Spanish/
// Italian/Portuguese/German/Russian/Japanese) that slips into the card grid.
const PH_VIEWKEY_RE = /view_video\.php\?viewkey=/i;
const PH_LANG_RE = /^(English|French|Spanish|Italian|Portuguese|German|Russian|Japanese)$/i;

export function isPornhubVideo(item) {
  const url = String((item && (item.videoUrl || item.url)) || '');
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\/language\//i.test(url)) return false;
  if (!PH_VIEWKEY_RE.test(url)) return false;
  const title = String((item && item.title) || '').trim();
  if (PH_LANG_RE.test(title)) return false;
  return true;
}

export function sanitizePornhubResults(videos) {
  return (Array.isArray(videos) ? videos : []).filter(isPornhubVideo);
}

export async function pornhubSearch(query, count = 25) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Nothing to search for');
  const api = window.api;
  if (!api || typeof api.webSearch !== 'function') {
    throw new Error('Web search is only available inside the app');
  }
  const res = await api.webSearch({
    mode: 'site',
    query: q,
    siteUrl: 'https://www.pornhub.com/video/search?search={query}',
    count: Number(count) || 25
  });
  if (!res || !res.success) {
    throw new Error((res && (res.error || res.details)) || 'Pornhub search failed');
  }
  return sanitizePornhubResults(res.videos || []);
}