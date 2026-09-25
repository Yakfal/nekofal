// Keyword-based adult content tagging. Canonical CJS copy used by the MAIN
// process (db inserts). The keyword data lives in contentSafety.data.json so
// the renderer (src/utils/contentSafety.js) can consume the SAME lists through
// Vite's native JSON import — a CommonJS module cannot be statically imported
// by Vite in dev, which left the renderer (and Electron dev window) blank.

const { ADULT_KEYWORDS, ADULT_DOMAIN_HINTS } = require('./contentSafety.data.json');

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

function matchesKeywords(text) {
  const haystack = normalize(text);
  return haystack ? ADULT_KEYWORDS.some(k => haystack.includes(k)) : false;
}

function matchesDomains(text) {
  const haystack = normalize(text);
  return haystack ? ADULT_DOMAIN_HINTS.some(d => haystack.includes(d)) : false;
}

/**
 * Decide whether a media row (or a raw channel/video object) should be flagged
 * as adult content.
 */
function isAdultMedia(item) {
  if (!item) return false;
  if (item.isAdult || item.is_adult) return true;

  const title = item.title || item.videoTitle || item.name || '';
  const category = item.category || item.group || item.groupTitle || '';
  const url = item.videoUrl || item.url || item.logo || '';
  const source = item.sourceSite || item.siteName || '';

  return (category && matchesKeywords(category))
    || (title && matchesKeywords(title))
    || (source && (matchesKeywords(source) || matchesDomains(source)))
    || (url && matchesDomains(url));
}

module.exports = {
  ADULT_KEYWORDS,
  ADULT_DOMAIN_HINTS,
  isAdultMedia
};