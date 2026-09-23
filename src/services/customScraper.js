export function pickBestStream(streams) {
  const list = Array.isArray(streams) ? streams : [];
  if (!list.length) return null;
  const master = list.find((s) => /master|(^|\/)[^/]*\.m3u8/i.test(String(s || '').toLowerCase())) || list[0];
  return master;
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