// Stub for src/services/dbAdapter.js, used ONLY by the browser harness.
//
// The real adapter drives the Electron DB/cloud bridge, which does not exist in
// a plain Chromium page. This module is wired in via a Vite `resolve.alias` in
// tests/harness/vite.harness.config.js. An ES-module namespace object is frozen,
// so the harness cannot monkey-patch the real module — aliasing is the only way.
//
// Everything else in the Family-Mode gate is the real production code.

export function getMediaId(item) {
  if (!item) return null;
  return item.id ?? item.videoId ?? null;
}
export function isDirectMediaUrl(url) {
  return /\.(mp4|m3u8|webm|mkv)(\?|#|$)/i.test(String(url || ''));
}
export function isPageUrl(url) {
  return /^https?:\/\//i.test(String(url || '')) && !isDirectMediaUrl(url);
}
export function favoritePayloadFor(item) {
  return item || null;
}
export function getCloudState() {
  return { connected: false, url: '', email: '', enabled: false, status: 'disabled' };
}
export function isCloudConnected() {
  return false;
}
export function onCloudChange() {
  return () => {};
}
export async function testConnection() {
  return false;
}
export async function cloudLogin() {
  return false;
}
export async function cloudRegister() {
  return false;
}
export async function cloudLogout() {
  return false;
}
export async function setCloudEnabled() {
  return false;
}
export async function syncNow() {
  return false;
}
export function autoSync() {}
// The harness has no remote prefs to pull.
export function getStoredPrefs() {
  return null;
}
export function applyStoredPrefs() {}
