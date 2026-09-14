// Keyword-based adult content tagging. Canonical CJS copy used by the MAIN
// process (db inserts). The renderer imports this via src/utils/contentSafety.js
// so both sides share one list.

const ADULT_KEYWORDS = [
  'xvideos', 'xnxx', 'pornhub', 'hentai', 'hanime', 'onlyfans', 'fansly',
  'xhamster', 'redtube', 'youporn', 'spankbang', 'motherless', 'erome',
  'adult', 'nsfw', 'xxx', 'porn', 'sex', 'sextape', 'sex tape', 'milf',
  'escort', 'strip', 'striptease', 'camgirl', 'webcam model', 'erotica',
  'pussy', 'cock', 'tits', 'boobs', 'anal', 'blowjob', 'oral sex',
  'intercourse', 'nude', 'naked', 'threesome', 'bdsm', 'fetish', 'fetish porn',
  'masturbat', 'dildo', 'vibrator', 'orgasm', 'penis', 'vagina', 'squirt',
  'sensual massage', 'xxxvideos', 'jav', 'bareback', 'gangbang',
  'cream pie', 'creampie', 'onlyfans leak', 'horny', 'slut', 'whore',
  'adult content', 'male enhancement', 'hookup', 'swinger', 'orgy'
];

const ADULT_DOMAIN_HINTS = [
  'xvideos.com', 'xnxx.com', 'pornhub.com', 'hanime.tv', 'hentai', 'onlyfans.com',
  'xhamster.com', 'redtube.com', 'youporn.com', 'spankbang.com', 'erome.com',
  'eporner.com', 'beeeg.net', 'porn'
];

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