// iptvService.js — multi-language Live TV feed catalog + import helper.
//
// This is the public renderer-side of the Live Channels page. It owns the
// curated catalog of iptv-org language playlists (the "quick-start" feeds shown
// as chips on the page), a tiny M3U preview parser, and the typed import path
// that reuses the existing, proven `iptv:addSource` engine.

export const IPTV_LANGUAGE_FEEDS = [
  { key: 'eng', label: 'English', url: 'https://iptv-org.github.io/iptv/languages/eng.m3u', flag: '🇬🇧' },
  { key: 'spa', label: 'Español', url: 'https://iptv-org.github.io/iptv/languages/spa.m3u', flag: '🇪🇸' },
  { key: 'fra', label: 'Français', url: 'https://iptv-org.github.io/iptv/languages/fra.m3u', flag: '🇫🇷' },
  { key: 'deu', label: 'Deutsch', url: 'https://iptv-org.github.io/iptv/languages/deu.m3u', flag: '🇩🇪' },
  { key: 'jpn', label: '日本語', url: 'https://iptv-org.github.io/iptv/languages/jpn.m3u', flag: '🇯🇵' },
  { key: 'news', label: 'News', url: 'https://iptv-org.github.io/iptv/categories/news.m3u', flag: '🗞️' }
];

// All iptv-org i18n playlists: `#EXTINF:-1,<name>` line, then the raw URL
// (tvg-id / tvg-logo / tvg-country live in the preceding EXTINF, group-title in
// a `group-title=` attr). We parse only what this page shows: name + logo + url.

export function getApi() {
  return window?.api || window?.electronAPI || window?.electron;
}

// Import any iptv-org fragment through the same M3U engine the user's own
// playlists flow through. The engine fetches+parses+dedupes+saves, then the
// page just refreshes its grid — same single proven path, zero divergence.
export async function importLanguageFeed(feed, onProgress) {
  const api = getApi();
  if (!api?.addIptvSource) return { success: false, error: 'IPTV engine not available' };
  try {
    const res = await api.addIptvSource(feed.label + ' · ' + feed.key, feed.url, onProgress);
    return res || { success: false, error: 'No response from engine' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
