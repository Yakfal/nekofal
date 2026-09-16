/**
 * Nekofal - Dual-Mode Database Adapter.
 *
 *  Offline mode : every read/write goes through the local SQLite IPC (window.api).
 *  Cloud mode   : while enabled + logged in, this adapter mirrors the four
 *                 PocketBase collections (favorites, playlists, playlist_items,
 *                 iptv_sources) between the local database and the remote server.
 *
 * Local records stay the source of truth; online mutations are pushed to
 * PocketBase and remote records are pulled back in (merge by content key).
 */
import { recoveredYouTubeWatchUrl } from './customScraper.js';

const STORAGE_KEY = 'yakfal-cloud';
const DEFAULT_STATE = { version: 1, enabled: false, url: '', token: '', user: null };
const MAX_PAGES = 10;
const TIMEOUT_MS = 25000;

let state = loadState();
let syncing = false;
const listeners = new Set();

const getApi = () => window.api || window.electronAPI;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed, user: parsed.user || null, token: parsed.token || '' };
  } catch (err) {
    console.error('[Cloud] failed to load state:', err);
    return { ...DEFAULT_STATE };
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('[Cloud] failed to persist state:', err);
  }
}

function emit() {
  listeners.forEach((fn) => {
    try { fn(getCloudState()); } catch { /* ignore listener errors */ }
  });
}

function normUrl(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `http://${u}`;
}

function base() {
  return normUrl(state.url);
}

/** Raw PocketBase REST call against an explicit base (used pre-login too). */
async function rawFetch(baseUrl, pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + pathname, {
    method,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const first = json && json.data ? Object.values(json.data)[0] : null;
    const detail = first && first.message ? first.message : json && json.message ? json.message : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return json;
}

function pb(pathname, opts = {}) {
  return rawFetch(base(), pathname, { token: state.token, ...opts });
}

async function pbList(collection, filter) {
  const all = [];
  const filterParam = filter ? `&filter=${encodeURIComponent(filter)}` : '';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const json = await pb(`/api/collections/${collection}/records?page=${page}&perPage=200${filterParam}`);
    all.push(...(json.items || []));
    if (all.length >= (json.totalItems || 0) || !json.page || json.page === json.totalPages) break;
  }
  return all;
}

function pbCreate(collection, data) {
  return pb(`/api/collections/${collection}/records`, { method: 'POST', body: data });
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

/** Unified favorite key across every card type (DB row, IPTV, radio
 *  station, archive.org item, search result). Prefers a stable id and
 *  falls back to the playable URL so nothing is ever keyed by undefined. */
export function getMediaId(item) {
  if (!item) return '';
  return String(
    item.id || item.media_id || item.url || item.videoUrl || item.streamUrl || ''
  ).trim();
}

// Media-request heuristic: a native-playable URL is a media file extension
// (before any query string), a local path, a localhost video-proxy route, or a
// known rotation-CDN host. Everything else over http(s) is a "page" that must
// be re-extracted on play.
const MEDIA_REQUEST_RE = /\.(mp4|webm|mkv|m4v|mov|avi|mp3|m4a|flac|wav|ogg|aac|ts|mpd|m3u8)([?#].*)?$/i;

/** True for anything <video> can grab directly without scraping. */
export function isDirectMediaUrl(url) {
  const u = String(url || '').trim();
  if (!u) return false;
  if (/^file:\/\//i.test(u) || /^[a-zA-Z]:[\\\/]/.test(u)) return true;
  if (/^(srt|rtmp|rtsp):\/\//i.test(u)) return true;
  if (/^https?:\/\//i.test(u)) {
    const hostAndPath = u.replace(/^https?:\/\//i, '').toLowerCase();
    if (hostAndPath.startsWith('localhost:') && hostAndPath.includes('/video/proxy/stream')) return true;
    if (hostAndPath.includes('googlevideo.com') || hostAndPath.includes('videoplayback')) return true;
    return MEDIA_REQUEST_RE.test(String(u.split('#')[0] || u).split('?')[0] || u);
  }
  return false;
}

/** A URL that points at a web page rather than an already-playable stream. */
export function isPageUrl(url) {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return false;
  return !isDirectMediaUrl(u);
}

/** Canonical favorite payload shared by every surface (MediaCard, Discover
 *  search results, IPTV, Classic Cinema, Live Radio) so all of them hit the
 *  same db:toggleFavorite path and cloud sync sees identical fields.
 *  A re-extractable page URL is authoritative over an ephemeral CDN stream:
 *  streams rotate, pages live long. Direct media files (no page) are kept
 *  verbatim as the play source. */
export function favoritePayloadFor(item) {
  const raw = String(item.videoUrl || item.url || item.streamUrl || '').trim();
  const explicitPage = String(item.pageUrl || item.webUrl || '').trim();
  // Legacy CDN recovery: rebuild the canonical watch page from a googlevideo
  // docid/id so old favorites/history re-extract instead of pinning a dead
  // signed stream URL.
  const recovered = recoveredYouTubeWatchUrl(explicitPage) || recoveredYouTubeWatchUrl(raw);
  const pageUrl = recovered || explicitPage || ((raw && isPageUrl(raw)) ? raw : '');
  const url = pageUrl ? '' : raw;
  return {
    id: getMediaId(item),
    media_id: item.media_id || item.mediaId || '',
    title: item.videoTitle || item.title || item.name || item.streamName || 'Untitled Video',
    url,
    pageUrl,
    type: item.type || item.sourceSite || (item.streamUrl ? 'Radio' : 'video'),
    provider: item.provider || '',
    thumbnail: item.thumbnailUrl || item.favicon || item.poster || '',
    isAdult: !!item.isAdult,
    duration: item.duration || 0,
    category: item.category || ''
  };
}

export function getCloudState() {
  return { ...state, user: state.user ? { ...state.user } : null };
}

export function isCloudConnected() {
  return state.enabled && !!base() && !!state.token && !!state.user;
}

export function onCloudChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function testConnection(url) {
  const u = normUrl(url);
  if (!u) return { success: false, error: 'Server URL is required' };
  try {
    const json = await rawFetch(u, '/api/health');
    const data = json && json.data ? json.data : {};
    return { success: true, version: data.app && data.app.version ? data.app.version : 'unknown' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function cloudLogin(url, email, password) {
  const u = normUrl(url) || base();
  if (!u) return { success: false, error: 'Server URL is required' };
  if (!email || !password) return { success: false, error: 'Email and password are required' };
  try {
    const json = await rawFetch(u, '/api/collections/users/auth-with-password', {
      method: 'POST',
      body: { identity: String(email).trim(), password: String(password) },
    });
    const rec = json.record || {};
    state = {
      ...state,
      url: u,
      enabled: true,
      token: json.token || '',
      user: { id: rec.id || '', username: rec.username || '', email: rec.email || '', name: rec.name || '' },
    };
    persist();
    emit();
    const sync = await syncNow();
    return { success: true, user: state.user, sync };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function cloudRegister(url, email, username, password) {
  const u = normUrl(url) || base();
  if (!u) return { success: false, error: 'Server URL is required' };
  if (!email || !password) return { success: false, error: 'Email and password are required' };
  const body = { email: String(email).trim(), password: String(password), passwordConfirm: String(password) };
  const name = String(username || '').trim();
  if (name) body.username = name;
  try {
    await rawFetch(u, '/api/collections/users/records', { method: 'POST', body });
  } catch (err) {
    return { success: false, error: err.message };
  }
  return cloudLogin(u, email, password);
}

export async function cloudLogout() {
  state = { ...DEFAULT_STATE, url: base() };
  persist();
  emit();
  return { success: true };
}

export async function setCloudEnabled(enabled) {
  if (enabled && !state.token) return { success: false, error: 'Connect an account first' };
  state = { ...state, enabled: !!enabled, url: base() };
  persist();
  emit();
  if (enabled) {
    const sync = await syncNow();
    return { success: true, sync };
  }
  return { success: true };
}

export async function syncNow() {
  if (!isCloudConnected()) return { success: false, error: 'Not connected to a cloud server' };
  if (syncing) return { success: false, alreadyRunning: true };
  const api = getApi();
  if (!api) return { success: false, error: 'Local database unavailable' };

  syncing = true;
  const report = { pushed: 0, pulled: 0, skipped: 0, errors: [] };
  try {
    await syncFavorites(api, report);
    await syncPlaylists(api, report);
    await syncIptv(api, report);
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('scrapers-synced'));
    return { success: true, ...report, at: new Date().toISOString() };
  } catch (err) {
    report.errors.push(err.message);
    return { success: false, error: err.message, ...report };
  } finally {
    syncing = false;
  }
}

/** Fire-and-forget sync when a local record changed (no-op unless connected). */
export function autoSync() {
  if (!isCloudConnected() || syncing) return;
  syncNow().catch(() => { /* background sync */ });
}

/* ------------------------------------------------------------------ */
/* Sync engine                                                         */
/* ------------------------------------------------------------------ */

function favKey(x) {
  return String(x && (x.videoUrl || x.url || x.media_id || x.id) || '').trim();
}

function plKey(p) {
  return `${String(p.name || p.title || '').trim()}|${String(p.description || '').trim()}`;
}

function localList(res) {
  if (res && res.success && Array.isArray(res.data)) return res.data;
  if (res && Array.isArray(res)) return res;
  return Array.isArray(res) ? res : [];
}

async function syncFavorites(api, report) {
  // Strictly best-effort/best-effort-safety: PocketBase cloud network state can
  // never block or clobber local favorite saving. Every failure (dead server,
  // auth expiry, row conflict) is recorded in the report and skipped; a fully
  // unreachable server aborts early after listing instead of cascading.
  try {
    const myId = state.user && state.user.id;
    if (!myId) return;

    let remote = [];
    try {
      remote = await pbList('favorites', `(user="${myId}")`);
    } catch (err) {
      report.errors.push(`favorites.listen: ${err.message}`);
      return;
    }

    const local = localList(await api.getFavorites());
    const remoteByKey = new Map(remote.map((r) => [favKey(r), r]));
    const localByKey = new Map(local.map((v) => [favKey(v), v]));

    for (const v of local) {
      const key = favKey(v);
      if (!key || remoteByKey.has(key)) continue;
      const mediaId = String(v.id || v.media_id || v.externalId || '').trim();
      // Canonical play source: a page URL outlives rotating CDN streams, so
      // page-only favorites (videoUrl empty) still push their page to the cloud.
      const url = String(v.videoUrl || v.pageUrl || '').trim();
      // A cloud row needs the site+own id and a playable url. Rows without them
      // are invalid and must not silently disappear — count them as skipped so
      // the sync report surfaces it.
      if (!mediaId || !url) {
        report.skipped++;
        continue;
      }
      try {
        // Standardized cloud payload fields.
        await pbCreate('favorites', {
          user: myId,
          media_id: mediaId,
          title: String(v.title || 'Untitled').trim(),
          url,
          type: String(v.sourceSite || v.type || 'video').trim(),
          thumbnail: String(v.thumbnailUrl || '').trim(),
          is_adult: !!v.isAdult,
        });
        remoteByKey.set(key, {});
        report.pushed++;
      } catch (err) {
        report.errors.push(`favorites.pushed: ${err.message}`);
      }
    }

    for (const r of remote) {
      const key = favKey(r);
      if (!key || localByKey.has(key)) continue;
      // Skip genuinely empty cloud rows (no media_id and no url) instead of
      // importing garbage into the local library.
      if (!String(r.media_id || '').trim() && !String(r.url || '').trim()) {
        report.skipped++;
        continue;
      }
      try {
        // Canonical cloud payload: { id, title, url, type, thumbnail, isAdult }
        // normalized here to the local columns (the IPC maps media_id -> id,
        // url -> videoUrl, type -> sourceSite, thumbnail -> thumbnailUrl).
        const payload = {
          id: String(r.media_id || `fav-cloud-${r.id}`),
          media_id: String(r.media_id || ''),
          title: String(r.title || 'Untitled'),
          url: key,
          type: r.type && r.type !== 'video' ? r.type : '',
          thumbnail: String(r.thumbnail || ''),
          isAdult: !!r.is_adult,
          duration: 0,
        };
        const res = await api.toggleFavorite(payload);
        if (res && res.success) report.pulled++;
      } catch (err) {
        report.errors.push(`favorites.pulled: ${err.message}`);
      }
    }
  } catch (unexpectedErr) {
    report.errors.push(`favorites.sync: ${unexpectedErr.message}`);
  }
}

async function syncPlaylists(api, report) {
  const myId = state.user.id;
  const remotePl = await pbList('playlists');
  const localPl = localList(await api.getPlaylists());

  const remoteByKey = new Map(remotePl.map((p) => [plKey(p), p]));
  const localByKey = new Map(localPl.map((p) => [plKey(p), p]));

  // Pull remote -> local
  const remoteToLocal = new Map(); // remote id -> local id
  for (const rp of remotePl) {
    let lp = localByKey.get(plKey(rp));
    if (!lp) {
      try {
        const created = await api.createPlaylist(rp.title || 'Untitled', rp.description || '');
        if (created && created.success && created.playlist) {
          lp = created.playlist;
          report.pulled++;
        }
      } catch (err) {
        report.errors.push(`playlists.pulled: ${err.message}`);
        continue;
      }
    }
    if (lp && lp.id) {
      remoteToLocal.set(String(rp.id), String(lp.id));
      localByKey.set(plKey(rp), lp);
    }
  }

  // Push local -> remote
  const localToRemote = new Map(); // local id -> remote id
  for (const lp of localPl) {
    let rp = remoteByKey.get(plKey(lp));
    if (!rp) {
      try {
        rp = await pbCreate('playlists', {
          user: myId,
          title: String(lp.name || 'Untitled'),
          description: String(lp.description || ''),
          is_public: !!lp.is_public,
        });
        report.pushed++;
      } catch (err) {
        report.errors.push(`playlists.pushed: ${err.message}`);
        continue;
      }
    }
    if (rp && rp.id) localToRemote.set(String(lp.id), String(rp.id));
  }

  if (localToRemote.size === 0 && remoteToLocal.size === 0) return;

  // Items: fetch once
  let remoteItemsAll = [];
  try {
    remoteItemsAll = await pbList('playlist_items');
  } catch (err) {
    report.errors.push(`playlist_items.list: ${err.message}`);
  }

  // Push items for local playlists
  for (const [localPlId, remotePlId] of localToRemote) {
    const remoteItems = remoteItemsAll.filter((i) => String(i.playlist) === remotePlId);
    const remoteByUrl = new Map(remoteItems.map((i) => [String(i.url || '').trim(), i]));
    const localItems = (await api.getPlaylistItems(localPlId)) || [];
    let pos = 0;
    for (const li of localItems) {
      const key = String(li.videoUrl || '').trim();
      if (!key) continue;
      if (remoteByUrl.has(key)) { pos++; continue; }
      try {
        await pbCreate('playlist_items', {
          playlist: remotePlId,
          title: String(li.videoTitle || 'Untitled'),
          url: key,
          thumbnail: String(li.thumbnailUrl || ''),
          position: pos,
        });
        report.pushed++;
      } catch (err) {
        report.errors.push(`playlist_items.pushed: ${err.message}`);
      }
      pos++;
    }
  }

  // Pull items for remote playlists
  for (const [remotePlId, localPlId] of remoteToLocal) {
    const rpItems = remoteItemsAll.filter((i) => String(i.playlist) === remotePlId);
    const localItems = (await api.getPlaylistItems(localPlId)) || [];
    const localByUrl = new Map(localItems.map((i) => [String(i.videoUrl || '').trim(), i]));
    for (const ri of rpItems) {
      const u = String(ri.url || '').trim();
      if (!u || localByUrl.has(u)) continue;
      try {
        await api.addToPlaylist(localPlId, {
          id: ri.media_id || ri.id,
          title: ri.title || 'Untitled',
          videoUrl: u,
          thumbnailUrl: ri.thumbnail || '',
          sourceSite: '',
          duration: 0,
        });
        report.pulled++;
      } catch (err) {
        report.errors.push(`playlist_items.pulled: ${err.message}`);
      }
    }
  }
}

async function syncIptv(api, report) {
  const myId = state.user.id;
  const remoteSrc = await pbList('iptv_sources');
  const localSrc = localList(await api.getIptvSources());
  const remoteByUrl = new Map(remoteSrc.map((s) => [String(s.url || '').trim(), s]));
  const localByUrl = new Map(localSrc.map((s) => [String(s.url || '').trim(), s]));

  for (const s of localSrc) {
    const u = String(s.url || '').trim();
    if (!u || remoteByUrl.has(u)) continue;
    try {
      await pbCreate('iptv_sources', {
        user: myId,
        name: String(s.name || 'IPTV Playlist'),
        url: u,
        channel_count: Number(s.channelCount || s.channel_count || 0),
      });
      report.pushed++;
    } catch (err) {
      report.errors.push(`iptv.pushed: ${err.message}`);
    }
  }

  for (const r of remoteSrc) {
    const u = String(r.url || '').trim();
    if (!u || localByUrl.has(u)) continue;
    try {
      const res = await api.addIptvSource(String(r.name || 'IPTV Playlist'), u);
      if (res && res.success) report.pulled++;
    } catch (err) {
      report.errors.push(`iptv.pulled: ${err.message}`);
    }
  }
}

