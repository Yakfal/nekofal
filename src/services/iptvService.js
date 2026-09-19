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
function parseM3UFragments(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let current = { title: '', logo: '', url: '' };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const titleMatch = line.match(/,(.+)$/);
      current = {
        title: titleMatch ? titleMatch[1].trim() : '',
        logo: logoMatch ? logoMatch[1] : '',
        url: ''
      };
    } else if (!line.startsWith('#') && /^https?:\/\//i.test(line)) {
      current.url = line;
      if (current.title) items.push(current);
      current = { title: '', logo: '', url: '' };
    }
  }
  return items;
}

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

// Lightweight local renderer for the chips row when an import hasn't run yet —
// returns the channel titles we expect so the page can show a live "counting…"
// hint. Probably unnecessary on the real page; kept for previews/tests.
export function previewFeedChannels(text) {
  return parseM3UFragments(text).slice(0, 24);
}
