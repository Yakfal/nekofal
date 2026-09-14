/**
 * OS-backed credential vault.
 * Values are encrypted with Electron's safeStorage (Windows Credential
 * Manager / DPAPI, macOS Keychain) and persisted to a JSON file inside the
 * user data directory — never in the repository.
 */

const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

let vaultFile = null;
let entries = {};

function isAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (err) {
    return false;
  }
}

function load() {
  entries = {};
  if (!vaultFile || !fs.existsSync(vaultFile)) return;
  try {
    entries = JSON.parse(fs.readFileSync(vaultFile, 'utf8')) || {};
  } catch (err) {
    console.warn('[vault] failed to read vault file:', err && err.message);
    entries = {};
  }
}

function save() {
  if (!vaultFile) throw new Error('[vault] not initialized');
  const dir = path.dirname(vaultFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${vaultFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries), 'utf8');
  fs.renameSync(tmp, vaultFile);
}

function init(userDataPath) {
  vaultFile = path.join(userDataPath, 'secrets.json');
  load();
}

function setSecret(key, value) {
  if (!isAvailable()) throw new Error('OS encryption unavailable');
  if (typeof key !== 'string' || key.trim() === '') throw new Error('key must be a non-empty string');
  if (typeof value !== 'string' || value === '') throw new Error('value must be a non-empty string');
  entries[key.trim()] = { enc: safeStorage.encryptString(value).toString('base64') };
  save();
  return true;
}

function getSecret(key) {
  const entry = entries[key];
  if (!entry || !entry.enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(entry.enc, 'base64'));
  } catch (err) {
    console.warn('[vault] failed to decrypt secret:', key, err && err.message);
    return null;
  }
}

function listKeys() {
  return Object.keys(entries).sort();
}

function deleteSecret(key) {
  if (!(key in entries)) return false;
  delete entries[key];
  save();
  return true;
}

module.exports = { init, isAvailable, setSecret, getSecret, listKeys, deleteSecret };