// Renderer-facing adult-content detector. The keyword lists are shared as a
// JSON file consumed by BOTH this renderer module and the Electron main-process
// copy (electron/contentSafety.cjs), so the two stay in sync. A CommonJS module
// cannot be statically imported by Vite in dev (blank-window bug), so the data
// moves through JSON, which Vite supports natively.
import contentSafetyData from '../../electron/contentSafety.data.json';

const ADULT_KEYWORDS = contentSafetyData.ADULT_KEYWORDS;
const ADULT_DOMAIN_HINTS = contentSafetyData.ADULT_DOMAIN_HINTS;

function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesKeywords(text) {
  const haystack = normalize(text);
  return haystack ? ADULT_KEYWORDS.some((k) => haystack.includes(k)) : false;
}

function matchesDomains(text) {
  const haystack = normalize(text);
  return haystack ? ADULT_DOMAIN_HINTS.some((d) => haystack.includes(d)) : false;
}

/**
 * Decide whether a media row (or a raw channel/video object) should be flagged
 * as adult content. Mirrors electron/contentSafety.cjs::isAdultMedia.
 */
function isAdultMedia(item) {
  if (!item) return false;
  if (item.isAdult || item.is_adult) return true;

  const title = item.title || item.videoTitle || item.name || '';
  const category = item.category || item.group || item.groupTitle || '';
  const url = item.videoUrl || item.url || item.logo || '';
  const source = item.sourceSite || item.siteName || '';

  return (
    (category && matchesKeywords(category)) ||
    (title && matchesKeywords(title)) ||
    (source && (matchesKeywords(source) || matchesDomains(source))) ||
    (url && matchesDomains(url))
  );
}

export default isAdultMedia;