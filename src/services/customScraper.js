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