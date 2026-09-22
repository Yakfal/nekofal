import React, { useState, useEffect, useCallback } from 'react';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { useLanguage, SUPPORTED_LANGUAGES } from '../i18n/LanguageContext.jsx';
import {
  getCloudState,
  onCloudChange,
  cloudLogin,
  cloudRegister,
  cloudLogout,
  setCloudEnabled,
  syncNow,
  testConnection,
} from '../services/dbAdapter.js';
import './Settings.css';

const Settings = () => {
  const getApi = () => window.api || window.electronAPI;
  const { settings, setTheme, setFamilyMode, setFamilyPasscode, verifyFamilyPasscode, hasFamilyPasscode, lock } = useAppSettings();
  const { language, setLanguage, t } = useLanguage();
  const [passcodeInput, setPasscodeInput] = useState('');
  const [confirmFor, setConfirmFor] = useState(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmError, setConfirmError] = useState('');

  const [toast, setToast] = useState(null);
  const [ytDlpEnabled, setYtDlpEnabled] = useState(true);
  const [adultSiteUrl, setAdultSiteUrl] = useState('');
  const [adultSiteName, setAdultSiteName] = useState('');
  const [scrapingAdult, setScrapingAdult] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [cloudState, setCloudState] = useState(() => getCloudState());
  const [cloudServerUrl, setCloudServerUrl] = useState(() => getCloudState().url || '');
  const [cloudEmail, setCloudEmail] = useState('');
  const [cloudPassword, setCloudPassword] = useState('');
  const [cloudUsername, setCloudUsername] = useState('');
  const [cloudRegisterMode, setCloudRegisterMode] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);
  const [playbackPrefs, setPlaybackPrefs] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('pmh-preferences')) || {};
    } catch {
      return {};
    }
  });
  const [secretKeys, setSecretKeys] = useState([]);
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretsBusy, setSecretsBusy] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => onCloudChange((s) => setCloudState(s)), []);

  const refreshSecrets = useCallback(async () => {
    const api = getApi();
    if (!api?.secrets?.list) return;
    try {
      const res = await api.secrets.list();
      if (res && res.success) setSecretKeys(res.keys || []);
    } catch (err) {
      console.error('Failed to list secrets:', err);
    }
  }, []);

  useEffect(() => {
    refreshSecrets();
    const api = getApi();
    const off = api?.onUpdateEvent ? api.onUpdateEvent((e) => {
      if (!e || !e.type) return;
      if (e.type === 'available') setUpdateMsg(`${t('settings.updateFound')}${e.version ? ' (' + e.version + ')' : ''}`);
      else if (e.type === 'progress') setUpdateMsg(`${t('settings.downloadingUpdate')} ${Math.round(e.percent || 0)}%`);
      else if (e.type === 'downloaded') setUpdateMsg(t('settings.updateDownloaded'));
      else if (e.type === 'error') setUpdateMsg(`Update check failed: ${e.message || 'unknown error'}`);
      else if (e.type === 'not-available') setUpdateMsg(t('settings.latestVersion'));
    }) : undefined;
    return () => { if (typeof off === 'function') off(); };
  }, [refreshSecrets]);

  const handleAddSecret = async (e) => {
    e.preventDefault();
    const name = secretName.trim();
    if (!name || !secretValue) { showToast(t('settings.enterKeyNameValue'), 'error'); return; }
    const api = getApi();
    if (!api?.secrets?.set) { showToast(t('settings.vaultUnavailable'), 'error'); return; }
    try {
      setSecretsBusy(true);
      const res = await api.secrets.set(name, secretValue);
      if (res && res.success) {
        showToast(t('settings.secretSaved'));
        setSecretName('');
        setSecretValue('');
        refreshSecrets();
      } else {
        showToast((res && res.error) || 'Failed to save secret.', 'error');
      }
    } catch (err) {
      showToast('Failed to save secret.', 'error');
    } finally {
      setSecretsBusy(false);
    }
  };

  const handleRemoveSecret = async (key) => {
    const api = getApi();
    if (!api?.secrets?.remove) return;
    try {
      await api.secrets.remove(key);
      showToast(`${t('settings.removedSecret')} "${key}"`);
      refreshSecrets();
    } catch (err) {
      showToast('Failed to remove secret.', 'error');
    }
  };

  const handleCheckUpdates = async () => {
    const api = getApi();
    if (!api?.checkForUpdates) { setUpdateMsg(t('settings.manualUpdatesPackaged')); return; }
    setUpdateBusy(true);
    try {
      const res = await api.checkForUpdates();
      if (res && res.success) {
        if (res.updateInfo) setUpdateMsg(`${t('settings.updateFound')}${res.updateInfo.version ? ' (' + res.updateInfo.version + ')' : ''}`);
        else setUpdateMsg(t('settings.checking'));
      } else {
        setUpdateMsg((res && res.error) || t('settings.noUpdate'));
      }
    } catch (err) {
      setUpdateMsg('Update check unavailable.');
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleCloudLogin = async (e) => {
    e.preventDefault();
    if (!cloudEmail || !cloudPassword) { showToast(t('settings.emailPasswordRequired'), 'error'); return; }
    setCloudBusy(true);
    try {
      const res = await cloudLogin(cloudServerUrl, cloudEmail, cloudPassword);
      if (res.success) {
        const s = res.sync || {};
        showToast(t('settings.connectedAs') + ' ' + res.user.email + (s.pushed || s.pulled ? ` — ${s.pushed} ${t('settings.pushed')}, ${s.pulled} ${t('settings.pulled')}` : ''));
        setCloudPassword('');
      } else {
        showToast('Cloud login failed: ' + res.error, 'error');
      }
    } catch (err) {
      showToast('Cloud login failed: ' + err.message, 'error');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudRegister = async (e) => {
    e.preventDefault();
    if (!cloudEmail || !cloudPassword || cloudPassword.length < 6) {
      showToast(t('settings.emailPasswordMin'), 'error');
      return;
    }
    setCloudBusy(true);
    try {
      const res = await cloudRegister(cloudServerUrl, cloudEmail, cloudUsername, cloudPassword);
      if (res.success) {
        showToast(t('settings.accountCreated') + ' ' + res.user.email);
        setCloudPassword('');
      } else {
        showToast('Registration failed: ' + res.error, 'error');
      }
    } catch (err) {
      showToast('Registration failed: ' + err.message, 'error');
    } finally {
      setCloudBusy(false);
    }
  };

  const handleCloudLogout = async () => {
    await cloudLogout();
    showToast(t('settings.cloudDisconnected'));
  };

  const handleCloudEnable = async (enabled) => {
    const res = await setCloudEnabled(enabled);
    if (!res.success && res.error) { showToast(res.error, 'error'); return; }
    if (enabled) {
      const s = res.sync || {};
      showToast(`${t('settings.cloudSyncEnabledMsg')} — ${s.pushed} ${t('settings.pushed')}, ${s.pulled} ${t('settings.pulled')}`);
    } else {
      showToast(t('settings.cloudSyncOffMsg'));
    }
  };

  const handleCloudSync = async () => {
    setCloudSyncBusy(true);
    try {
      const res = await syncNow();
      if (res.success) {
        showToast(`${t('settings.syncComplete')} — ${res.pushed} ${t('settings.pushed')}, ${res.pulled} ${t('settings.pulled')}` + (res.errors.length ? `, ${res.errors.length} ${t('settings.skipped')}` : ''));
      } else {
        showToast('Sync failed: ' + res.error, 'error');
      }
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleCloudTest = async () => {
    const res = await testConnection(cloudServerUrl);
    showToast(res.success ? t('settings.serverReachable') + (res.version !== 'unknown' ? ' (' + res.version + ')' : '') : 'Server unreachable: ' + res.error, res.success ? 'success' : 'error');
  };

  const handleExportBackup = async () => {
    const api = getApi();
    if (!api?.exportBackup) { showToast('Backup unavailable', 'error'); return; }
    setBackupBusy(true);
    try {
      const res = await api.exportBackup();
      if (res?.canceled) return;
      if (res?.success) {
        const c = res.counts || {};
        showToast(`${t('settings.backupSavedTo')} ${res.path || t('settings.file')}: ${c.playlists} ${t('settings.playlists')}, ${c.playlistItems} ${t('settings.items')}, ${c.favorites} ${t('settings.favoritesCount')}, ${c.iptvSources} ${t('settings.iptvSourcesCount')}`);
      } else {
        showToast('Backup failed: ' + (res?.error || 'unknown'), 'error');
      }
    } catch (err) {
      showToast('Backup failed: ' + err.message, 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImportBackup = async () => {
    const api = getApi();
    if (!api?.importBackup) { showToast('Restore unavailable', 'error'); return; }
    setBackupBusy(true);
    try {
      const res = await api.importBackup();
      if (res?.canceled) return;
      if (res?.success) {
        const c = res.counts || {};
        showToast(`${t('settings.restoredFrom')} ${res.source || t('settings.file')}: ${c.playlists} ${t('settings.playlists')}, ${c.playlistItems} ${t('settings.items')}, ${c.favorites} ${t('settings.favoritesCount')}, ${c.iptvSources} ${t('settings.iptvSourcesCount')}`);
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        showToast('Restore failed: ' + (res?.error || 'unknown'), 'error');
      }
    } catch (err) {
      showToast('Restore failed: ' + err.message, 'error');
    } finally {
      setBackupBusy(false);
    }
  };

  const clearDatabase = async () => {
    if (!window.confirm(t('settings.clearDatabaseConfirm'))) return;

    try {
      const api = getApi();
      if (api?.clearAll) {
        await api.clearAll();
        showToast(t('settings.databaseCleared'));
      }
    } catch (err) {
      console.error('Failed to clear database:', err);
      showToast('Failed to clear database', 'error');
    }
  };

  const toggleYtDlp = () => {
    setYtDlpEnabled(prev => {
      const next = !prev;
      showToast(next ? t('settings.ytdlpEnabled') : t('settings.ytdlpDisabled'));
      return next;
    });
  };

  const handleFamilyModeOff = () => {
    if (settings.familyMode && hasFamilyPasscode()) {
      setConfirmFor({ action: 'off' });
      setConfirmCode('');
      setConfirmError('');
      return;
    }
    setFamilyMode(false);
    lock();
    showToast(t('settings.familyModeOff'));
  };

  const handleSavePasscode = async () => {
    if (!passcodeInput.trim()) {
      showToast(t('settings.enterPasscodeFirst'), 'error');
      return;
    }
    if (passcodeInput.trim().length < 4) {
      showToast(t('settings.passcodeMin'), 'error');
      return;
    }
    await setFamilyPasscode(passcodeInput.trim());
    setPasscodeInput('');
    showToast(t('settings.passcodeSaved'));
  };

  const handleClearPasscode = () => {
    if (hasFamilyPasscode()) {
      setConfirmFor({ action: 'clear' });
      setConfirmCode('');
      setConfirmError('');
      return;
    }
    setFamilyPasscode(null);
    setPasscodeInput('');
    showToast(t('settings.passcodeRemoved'));
  };

  const handleConfirmSubmit = async (e) => {
    e.preventDefault();
    if (!confirmFor) return;
    const ok = await verifyFamilyPasscode(confirmCode);
    if (!ok) {
      setConfirmError(t('settings.incorrectPasscode'));
      return;
    }
    const action = confirmFor.action;
    setConfirmFor(null);
    setConfirmCode('');
    setConfirmError('');
    if (action === 'off') {
      setFamilyMode(false);
      lock();
      showToast(t('settings.familyModeOff'));
    } else if (action === 'clear') {
      await setFamilyPasscode(null);
      setPasscodeInput('');
      showToast(t('settings.passcodeRemoved'));
    }
  };

  const savePlaybackPref = (patch) => {
    setPlaybackPrefs(prev => {
      const next = { ...prev, ...patch };
      localStorage.setItem('pmh-preferences', JSON.stringify(next));
      return next;
    });
  };

  const handleVolumePref = (e) => {
    savePlaybackPref({ defaultVolume: Number(e.target.value) / 100 });
  };

  const handleRatePref = (e) => {
    savePlaybackPref({ defaultRate: Number(e.target.value) });
  };

  const handleQualityPref = (e) => {
    savePlaybackPref({ preferredQuality: e.target.value });
  };

  const handleScrapeAdultSite = async (e) => {
    e.preventDefault();
    const url = adultSiteUrl.trim();
    const name = adultSiteName.trim();
    if (!url) { showToast(t('settings.siteUrlRequired'), 'error'); return; }

    setScrapingAdult(true);
    try {
      const api = getApi();
      const result = await api.runScrapers([url]);
      if (result?.success) {
        showToast(`${t('settings.addedVideosPrefix')} ${result.inserted || 0} ${t('settings.videosFrom')} "${name || url}"`);
        setAdultSiteUrl(''); setAdultSiteName('');
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        showToast(result?.error || 'Scrape failed — try a direct video or category page URL', 'error');
      }
    } catch (err) {
      showToast('Scrape failed: ' + err.message, 'error');
    } finally {
      setScrapingAdult(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1 className="page-title">{t('nav.settings')}</h1>
      </div>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="9" strokeWidth="2"/>
            <path d="M3.6 9h16.8M3.6 15h16.8" strokeWidth="2" strokeLinecap="round"/>
            <path d="M12 3a15 15 0 010 18M12 3a15 15 0 000 18" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <h2>{t('settings.appLanguage')}</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.languageLabel')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.languageDesc')}
              </span>
            </span>
            <select
              className="form-input"
              style={{ width: 'auto', minWidth: '220px', padding: '6px 10px' }}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              aria-label={t('settings.appLanguage')}
            >
              {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.nativeName}</option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-6.36l-1.42 1.42M7.05 16.95l-1.41 1.41m12.72 0l-1.41-1.41M7.05 7.05L5.64 5.64M12 8a4 4 0 100 8 4 4 0 000-8z" />
          </svg>
          <h2>{t('settings.appearanceAndFamily')}</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.theme')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.themeDesc')}
              </span>
            </span>
            <div className="theme-options" style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'dark-cyber' ? 'active' : ''}`}
                onClick={() => setTheme('dark-cyber')}
              >
                <span className="theme-swatch dark"></span> {t('settings.themeDark')}
              </button>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'light-sky' ? 'active' : ''}`}
                onClick={() => setTheme('light-sky')}
              >
                <span className="theme-swatch light"></span> {t('settings.themeLight')}
              </button>
            </div>
          </div>

          <div className="toggle-item">
            <span>
              {t('settings.familyMode')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.familyModeDesc')}
              </span>
            </span>
            <button
              type="button"
              className={`toggle ${settings.familyMode ? 'active' : 'off'}`}
              onClick={() => settings.familyMode ? handleFamilyModeOff() : setFamilyMode(true)}
            >
              {settings.familyMode ? t('common.on') : t('common.off')}
            </button>
          </div>

          <div className="toggle-item">
            <span>
              {t('settings.familyPasscode')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.familyPasscodeDesc')} {hasFamilyPasscode() ? t('settings.passcodeSet') : t('settings.passcodeNotSet')}
              </span>
            </span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                className="form-input"
                placeholder={t('settings.passcodePlaceholder')}
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                style={{ width: '160px' }}
              />
              <button type="button" className="btn btn-primary btn-small" onClick={handleSavePasscode}>
                {t('common.save')}
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={handleClearPasscode}>
                {t('common.remove')}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 5h9a3 3 0 013 3v1m0 0h4v7a3 3 0 01-3 3H4a1 1 0 01-1-1V6a1 1 0 011-1zm7 5l3-2m0 0l3 2m-3-2v6" />
          </svg>
          <h2>{t('settings.backupRestore')}</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.exportBackup')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.exportBackupDesc')}
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={handleExportBackup} disabled={backupBusy}>
              {backupBusy ? t('settings.working') : t('settings.export')}
            </button>
          </div>
          <div className="toggle-item">
            <span>
              {t('settings.restoreBackup')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.restoreBackupDesc')}
              </span>
            </span>
            <button type="button" className="btn btn-secondary btn-small" onClick={handleImportBackup} disabled={backupBusy}>
              {backupBusy ? t('settings.working') : t('settings.import')}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M4 4a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" />
            <path d="M8 20a2 2 0 01-2-2M16 20a2 2 0 001.465-.535M12 20v-4M12 12a3 3 0 00-3-3h-1a2 2 0 012-2h2a2 2 0 012 2 2 2 0 01-2 2h0" />
          </svg>
          <h2>{t('settings.cloudSync')}</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.cloudSyncToggle')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {cloudState.user
                  ? t('settings.cloudConnectedAs') + ' ' + (cloudState.user.email || cloudState.user.username) + (cloudState.enabled ? '.' : t('settings.cloudSyncDisabled') + '.')
                  : t('settings.cloudNotConnected')}
              </span>
            </span>
            <button
              type="button"
              className={`toggle ${cloudState.enabled ? 'active' : 'off'}`}
              onClick={() => handleCloudEnable(!cloudState.enabled)}
              disabled={!cloudState.user}
            >
              {cloudState.enabled ? t('common.on') : t('common.off')}
            </button>
          </div>

          {cloudState.user && (
            <div className="toggle-item">
              <span>
                {t('settings.manualSync')}
                <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                  {t('settings.manualSyncDesc')}
                </span>
              </span>
              <button type="button" className="btn btn-primary btn-small" onClick={handleCloudSync} disabled={cloudSyncBusy}>
                {cloudSyncBusy ? t('settings.syncing') : t('settings.syncNow')}
              </button>
            </div>
          )}
        </div>

        <form className="settings-form" style={{ marginTop: '16px' }} onSubmit={cloudRegisterMode ? handleCloudRegister : handleCloudLogin}>
          <div className="form-group">
            <label htmlFor="cloud-url">{t('settings.serverUrl')}</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="cloud-url"
                type="text"
                className="form-input"
                style={{ flex: 1 }}
                placeholder={t('settings.serverUrlPlaceholder')}
                value={cloudServerUrl}
                onChange={(e) => setCloudServerUrl(e.target.value)}
                disabled={cloudBusy}
              />
              <button type="button" className="btn btn-secondary btn-small" onClick={handleCloudTest} disabled={cloudBusy || !cloudServerUrl.trim()}>
                {t('settings.test')}
              </button>
            </div>
            <p className="form-hint">
              {t('settings.serverUrlHint')}
            </p>
          </div>

          {cloudRegisterMode && (
            <div className="form-group">
              <label htmlFor="cloud-username">{t('settings.usernameOptional')}</label>
              <input
                id="cloud-username"
                type="text"
                className="form-input"
                placeholder={t('settings.usernamePlaceholder')}
                value={cloudUsername}
                onChange={(e) => setCloudUsername(e.target.value)}
                disabled={cloudBusy}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="cloud-email">{t('settings.email')}</label>
            <input
              id="cloud-email"
              type="email"
              className="form-input"
              placeholder={t('settings.emailPlaceholder')}
              value={cloudEmail}
              onChange={(e) => setCloudEmail(e.target.value)}
              disabled={cloudBusy}
            />
          </div>

          <div className="form-group">
            <label htmlFor="cloud-password">{t('settings.password')}</label>
            <input
              id="cloud-password"
              type="password"
              className="form-input"
              placeholder={cloudRegisterMode ? t('settings.passwordRegisterHint') : t('settings.passwordPlaceholder')}
              value={cloudPassword}
              onChange={(e) => setCloudPassword(e.target.value)}
              disabled={cloudBusy}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={cloudBusy}>
              {cloudBusy ? t('settings.working') : (cloudRegisterMode ? t('settings.createAccount') : (cloudState.user ? t('settings.reconnect') : t('settings.connect')))}
            </button>
            {cloudState.user && (
              <button type="button" className="btn btn-secondary btn-small" onClick={handleCloudLogout}>
                {t('settings.logout')}
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setCloudRegisterMode(v => !v)} disabled={cloudBusy}>
              {cloudRegisterMode ? t('settings.useExistingAccount') : t('settings.createAccountShort')}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
          <h2>{t('settings.videoSiteScraping')}</h2>
        </div>

        <p className="form-hint" style={{ marginBottom: '16px' }}>
          {settings.familyMode ? t('settings.ytdlpIntroFamily') : t('settings.ytdlpIntro')}
        </p>

        <form className="settings-form" onSubmit={handleScrapeAdultSite}>
          <div className="form-group">
            <label htmlFor="adult-name">{t('settings.sourceNameOptional')}</label>
            <input
              id="adult-name"
              type="text"
              className="form-input"
              placeholder={settings.familyMode ? t('settings.sourceNamePlaceholderFamily') : t('settings.sourceNamePlaceholder')}
              value={adultSiteName}
              onChange={(e) => setAdultSiteName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="adult-url">{t('settings.scrapeUrlLabel')}</label>
            <input
              id="adult-url"
              type="url"
              className="form-input"
              placeholder={t('settings.scrapeUrlPlaceholder')}
              value={adultSiteUrl}
              onChange={(e) => setAdultSiteUrl(e.target.value)}
            />
            <p className="form-hint">
              {t('settings.ytdlpHint')}
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={scrapingAdult}>
            {scrapingAdult ? t('settings.extracting') : t('settings.scrapeSite')}
          </button>
        </form>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            <path d="M13 5l3 3m0 0l-3 3m3-3H8a4 4 0 00-4 4v.5" />
          </svg>
          <h2>{t('settings.playbackQuality')}</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.defaultVolume')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.defaultVolumeDesc')}
              </span>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              className="volume-slider"
              value={Math.round((playbackPrefs.defaultVolume ?? 1) * 100)}
              onChange={handleVolumePref}
              aria-label={t('settings.defaultVolume')}
              style={{ width: '160px', accentColor: '#3b82f6' }}
            />
            <span className="text-white font-mono text-sm" style={{ width: '44px', textAlign: 'right' }}>
              {Math.round((playbackPrefs.defaultVolume ?? 1) * 100)}%
            </span>
          </div>

          <div className="toggle-item">
            <span>
              {t('settings.defaultSpeed')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.defaultSpeedDesc')}
              </span>
            </span>
            <select
              className="form-input"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={playbackPrefs.defaultRate ?? 1}
              onChange={handleRatePref}
              aria-label={t('settings.defaultSpeed')}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                <option key={rate} value={rate}>{rate}x</option>
              ))}
            </select>
          </div>

          <div className="toggle-item">
            <span>
              {t('settings.preferredQuality')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.preferredQualityDesc')}
              </span>
            </span>
            <select
              className="form-input"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={playbackPrefs.preferredQuality ?? 'auto'}
              onChange={handleQualityPref}
              aria-label={t('settings.preferredQuality')}
            >
              <option value="auto">{t('settings.qualityAuto')}</option>
              <option value="max">{t('settings.qualityHighest')}</option>
              <option value="1080">1080p</option>
              <option value="720">720p</option>
              <option value="480">480p</option>
            </select>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <h2>{t('settings.options')}</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>{t('settings.useYtDlp')}</span>
            <button
              type="button"
              className={`toggle ${ytDlpEnabled ? 'active' : 'off'}`}
              onClick={toggleYtDlp}
            >
              {ytDlpEnabled ? t('common.on') : t('common.off')}
            </button>
          </div>
        </div>

        <div className="danger-zone">
          <h3 className="text-red-400 font-semibold mb-2">{t('settings.dangerZone')}</h3>
          <button type="button" className="clear-database" onClick={clearDatabase}>
            {t('settings.clearDatabase')}
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-4z" />
          </svg>
          <h2>{t('settings.apiKeysAndSecrets')}</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.secureVault')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.secureVaultDesc')}
              </span>
            </span>
          </div>
          <div className="toggle-item">
            <span>
              {t('settings.storedKeys')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.storedKeysDesc')}
              </span>
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end', maxWidth: '60%' }}>
              {secretKeys.length === 0 && <span className="form-hint">{t('settings.noneYet')}</span>}
              {secretKeys.map((k) => (
                <button
                  key={k}
                  type="button"
                  title={t('common.remove') + ` "${k}"`}
                  onClick={() => handleRemoveSecret(k)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: '6px', background: '#111827',
                    border: '1px solid #334155', borderRadius: '8px', padding: '4px 8px', fontSize: '12px',
                    color: '#e2e8f0', cursor: 'pointer', fontFamily: 'inherit'
                  }}
                >
                  {k} <span style={{ color: '#ef4444', fontWeight: 700 }}>×</span>
                </button>
              ))}
            </div>
          </div>
          <form className="toggle-item" onSubmit={handleAddSecret}>
            <span>
              {t('settings.addKey')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.addKeyDesc')}
              </span>
            </span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="form-input"
                placeholder={t('settings.keyName')}
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                style={{ width: '150px' }}
              />
              <input
                className="form-input"
                type="password"
                placeholder={t('settings.value')}
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                style={{ width: '180px' }}
              />
              <button type="submit" className="btn btn-primary btn-small" disabled={secretsBusy}>
                {secretsBusy ? t('settings.working') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M13 2L4.5 12H11l-1 10 8.5-10H12l1-10z" />
          </svg>
          <h2>{t('settings.updates')}</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              {t('settings.appUpdates')}
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {t('settings.appUpdatesDesc')}
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={handleCheckUpdates} disabled={updateBusy}>
              {updateBusy ? t('settings.checking') : t('settings.checkForUpdates')}
            </button>
          </div>
          {updateMsg && (
            <div className="toggle-item">
              <span>{updateMsg}</span>
            </div>
          )}
        </div>
      </section>

      {confirmFor && (
        <div className="passcode-overlay" onClick={() => setConfirmFor(null)}>
          <div className="passcode-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{confirmFor.action === 'off' ? t('settings.familyOffTitle') : t('settings.removePasscodeTitle')}</h3>
            <p>{t('settings.enterPasscode')}</p>
            <form onSubmit={handleConfirmSubmit}>
              <input
                type="password"
                className="form-input"
                placeholder={t('settings.passcode')}
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                autoFocus
              />
              {confirmError && <p className="passcode-error">{confirmError}</p>}
              <div className="passcode-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirmFor(null)}>{t('common.cancel')}</button>
                <button type="submit" className="btn btn-primary btn-small">{t('settings.confirm')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-2xl text-white text-sm z-50 ${
            toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
};

export default Settings;