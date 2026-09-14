import React, { useState, useEffect, useCallback } from 'react';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import {
  getCloudState,
  onCloudChange,
  cloudLogin,
  cloudRegister,
  cloudLogout,
  setCloudEnabled,
  syncNow,
  testConnection,
  autoSync,
} from '../services/dbAdapter.js';
import './Settings.css';

const Settings = () => {
  const getApi = () => window.api || window.electronAPI;
  const { settings, setTheme, setFamilyMode, setFamilyPasscode, verifyFamilyPasscode, hasFamilyPasscode, lock } = useAppSettings();
  const [passcodeInput, setPasscodeInput] = useState('');
  const [confirmFor, setConfirmFor] = useState(null);
  const [confirmCode, setConfirmCode] = useState('');
  const [confirmError, setConfirmError] = useState('');

  const [siteName, setSiteName] = useState('');
  const [urls, setUrls] = useState(['']);
  const [savedScrapers, setSavedScrapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [removingId, setRemovingId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [toast, setToast] = useState(null);
  const [ytDlpEnabled, setYtDlpEnabled] = useState(true);
  const [iptvSources, setIptvSources] = useState([]);
  const [iptvName, setIptvName] = useState('');
  const [iptvUrl, setIptvUrl] = useState('');
  const [iptvLoading, setIptvLoading] = useState(false);
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

  // Convert internal { id, siteName, urls } to DB shape { id, siteName, baseUrls }
  const toDbScraper = (s) => ({
    id: s.id,
    siteName: s.siteName,
    baseUrls: (Array.isArray(s.urls) ? s.urls : s.baseUrls || []).filter(u => u && u.trim() !== '')
  });

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      const api = getApi();
      if (api?.getScrapers) {
        const result = await api.getScrapers();
        if (result.success && Array.isArray(result.data)) {
          setSavedScrapers(
            result.data.map(s => ({
              id: s.id,
              siteName: s.siteName,
              urls: Array.isArray(s.baseUrls) ? s.baseUrls : s.baseUrls ? [s.baseUrls] : []
            }))
          );
        }
      }
      if (api?.getIptvSources) {
        const res = await api.getIptvSources();
        if (res.success && Array.isArray(res.data)) {
          setIptvSources(res.data);
        }
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

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
      if (e.type === 'available') setUpdateMsg(`Update ${e.version || ''} found — downloading…`);
      else if (e.type === 'progress') setUpdateMsg(`Downloading update… ${Math.round(e.percent || 0)}%`);
      else if (e.type === 'downloaded') setUpdateMsg('Update downloaded — restart to install.');
      else if (e.type === 'error') setUpdateMsg(`Update check failed: ${e.message || 'unknown error'}`);
      else if (e.type === 'not-available') setUpdateMsg('You are on the latest version.');
    }) : undefined;
    return () => { if (typeof off === 'function') off(); };
  }, [refreshSecrets]);

  const handleAddSecret = async (e) => {
    e.preventDefault();
    const name = secretName.trim();
    if (!name || !secretValue) { showToast('Enter a key name and value.', 'error'); return; }
    const api = getApi();
    if (!api?.secrets?.set) { showToast('Secure vault unavailable in this build.', 'error'); return; }
    try {
      setSecretsBusy(true);
      const res = await api.secrets.set(name, secretValue);
      if (res && res.success) {
        showToast('Secret saved to the vault');
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
      showToast(`Removed "${key}"`);
      refreshSecrets();
    } catch (err) {
      showToast('Failed to remove secret.', 'error');
    }
  };

  const handleCheckUpdates = async () => {
    const api = getApi();
    if (!api?.checkForUpdates) { setUpdateMsg('Manual updates are available in the packaged app.'); return; }
    setUpdateBusy(true);
    try {
      const res = await api.checkForUpdates();
      if (res && res.success) {
        if (res.updateInfo) setUpdateMsg(`Update ${res.updateInfo.version || ''} found — downloading…`);
        else setUpdateMsg('Checking…');
      } else {
        setUpdateMsg((res && res.error) || 'No update available.');
      }
    } catch (err) {
      setUpdateMsg('Update check unavailable.');
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleCloudLogin = async (e) => {
    e.preventDefault();
    if (!cloudEmail || !cloudPassword) { showToast('Email and password are required', 'error'); return; }
    setCloudBusy(true);
    try {
      const res = await cloudLogin(cloudServerUrl, cloudEmail, cloudPassword);
      if (res.success) {
        const s = res.sync || {};
        showToast(`Connected as ${res.user.email}` + (s.pushed || s.pulled ? ` — ${s.pushed} pushed, ${s.pulled} pulled` : ''));
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
      showToast('Email and a password (6+ chars) are required', 'error');
      return;
    }
    setCloudBusy(true);
    try {
      const res = await cloudRegister(cloudServerUrl, cloudEmail, cloudUsername, cloudPassword);
      if (res.success) {
        showToast(`Account created & connected as ${res.user.email}`);
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
    showToast('Disconnected from cloud');
  };

  const handleCloudEnable = async (enabled) => {
    const res = await setCloudEnabled(enabled);
    if (!res.success && res.error) { showToast(res.error, 'error'); return; }
    if (enabled) {
      const s = res.sync || {};
      showToast(`Cloud sync enabled — ${s.pushed} pushed, ${s.pulled} pulled`);
    } else {
      showToast('Cloud sync disabled');
    }
  };

  const handleCloudSync = async () => {
    setCloudSyncBusy(true);
    try {
      const res = await syncNow();
      if (res.success) {
        showToast(`Sync complete — ${res.pushed} pushed, ${res.pulled} pulled` + (res.errors.length ? `, ${res.errors.length} skipped` : ''));
      } else {
        showToast('Sync failed: ' + res.error, 'error');
      }
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleCloudTest = async () => {
    const res = await testConnection(cloudServerUrl);
    showToast(res.success ? `Server reachable` + (res.version !== 'unknown' ? ' (version ' + res.version + ')' : '') : 'Server unreachable: ' + res.error, res.success ? 'success' : 'error');
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
        showToast(`Backup saved to ${res.path || 'file'}: ${c.playlists} playlists, ${c.playlistItems} items, ${c.favorites} favorites, ${c.iptvSources} IPTV sources`);
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
        showToast(`Restored from ${res.source || 'file'}: ${c.playlists} playlists, ${c.playlistItems} items, ${c.favorites} favorites, ${c.iptvSources} sources`);
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

  const addUrlField = () => {
    setUrls(prev => [...prev, '']);
  };

  const removeUrlField = (index) => {
    setUrls(prev => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleAddScraper = async (e) => {
    e.preventDefault();

    const name = siteName.trim();
    const validUrls = urls.map(u => u.trim()).filter(u => u !== '');

    if (!name) {
      showToast('Site name is required', 'error');
      return;
    }

    const validUrlRegex = /^https?:\/\/.+/i;
    const passingUrls = validUrls.filter(u => validUrlRegex.test(u));

    if (passingUrls.length === 0) {
      showToast('At least one valid URL (http/https) is required', 'error');
      return;
    }

    const newScraper = {
      id: Date.now().toString(),
      siteName: name,
      urls: passingUrls
    };

    // Add to React state
    setSavedScrapers(prev => [...prev, newScraper]);

    // Persist immediately to SQLite with the updated array
    try {
      const api = getApi();
      if (api?.saveScrapers) {
        const result = await api.saveScrapers([...savedScrapers, newScraper].map(toDbScraper));
        if (result && result.success) {
          showToast(`Added "${name}" to saved scrapers`);
        } else {
          showToast('Failed to save scraper', 'error');
        }
      }
    } catch (err) {
      console.error('Failed to save scraper:', err);
      showToast('Failed to save scraper', 'error');
    }

    // Reset the form
    setSiteName('');
    setUrls(['']);
  };

  const removeScraper = async (scraperId) => {
    setRemovingId(scraperId);
    try {
      const filtered = savedScrapers.filter(s => s.id !== scraperId);
      setSavedScrapers(filtered);

      const api = getApi();
      if (api?.saveScrapers) {
        const result = await api.saveScrapers(filtered.map(toDbScraper));
        if (result && result.success) {
          showToast('Scraper removed');
        } else {
          showToast('Failed to remove scraper', 'error');
        }
      }
    } catch (err) {
      console.error('Failed to remove scraper:', err);
      showToast('Failed to remove scraper', 'error');
    } finally {
      setRemovingId(null);
    }
  };

  const testScraper = async (scraper) => {
    const targets = (Array.isArray(scraper.urls) ? scraper.urls : []).filter(u => u.trim());
    if (targets.length === 0) {
      showToast('No URLs to test for this scraper', 'error');
      return;
    }

    setTestingId(scraper.id);
    try {
      const api = getApi();
      let successCount = 0;

      for (const url of targets) {
        try {
          if (api?.extractStream) {
            const res = await api.extractStream(url);
            if (res && res.success && res.data) {
              successCount += 1;
            }
          } else {
            successCount += 1;
          }
        } catch (err) {
          console.warn(`[Settings] Test failed for ${url}:`, err.message);
        }
      }

      showToast(
        successCount === targets.length
          ? `${scraper.siteName}: all ${successCount} URLs OK`
          : `${scraper.siteName}: ${successCount}/${targets.length} URLs OK`
      );
    } catch (err) {
      console.error('Failed to test scraper:', err);
      showToast('Scraper test failed', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const syncScrapers = async () => {
    const allUrls = savedScrapers.flatMap(s => (s.urls || []).filter(u => u && u.trim() !== ''));
    if (allUrls.length === 0) {
      showToast('Add a scraper with at least one URL first', 'error');
      return;
    }

    setSyncing(true);
    try {
      const api = getApi();
      if (!api?.runScrapers) {
        showToast('Sync not available in this environment', 'error');
        return;
      }

      const result = await api.runScrapers(allUrls);
      if (result && result.success) {
        showToast(`Synced ${result.inserted || 0} new videos into Media Library`);
        window.dispatchEvent(new Event('scrapers-synced'));
      } else {
        showToast(result?.error || 'Sync failed', 'error');
      }
    } catch (err) {
      console.error('Sync failed:', err);
      showToast('Sync failed: ' + err.message, 'error');
    } finally {
      setSyncing(false);
    }
  };

  const clearDatabase = async () => {
    if (!window.confirm('Are you sure you want to clear the entire database? This cannot be undone.')) return;

    try {
      const api = getApi();
      if (api?.clearAll) {
        await api.clearAll();
        showToast('Database cleared');
      }
    } catch (err) {
      console.error('Failed to clear database:', err);
      showToast('Failed to clear database', 'error');
    }
  };

  const toggleYtDlp = () => {
    setYtDlpEnabled(prev => {
      const next = !prev;
      showToast(next ? 'yt-dlp extraction enabled' : 'yt-dlp extraction disabled');
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
    showToast('Family Mode off');
  };

  const handleSavePasscode = async () => {
    if (!passcodeInput.trim()) {
      showToast('Enter a passcode first', 'error');
      return;
    }
    if (passcodeInput.trim().length < 4) {
      showToast('Passcode must be at least 4 characters', 'error');
      return;
    }
    await setFamilyPasscode(passcodeInput.trim());
    setPasscodeInput('');
    showToast('Family passcode saved');
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
    showToast('Family passcode removed');
  };

  const handleConfirmSubmit = async (e) => {
    e.preventDefault();
    if (!confirmFor) return;
    const ok = await verifyFamilyPasscode(confirmCode);
    if (!ok) {
      setConfirmError('Incorrect passcode');
      return;
    }
    const action = confirmFor.action;
    setConfirmFor(null);
    setConfirmCode('');
    setConfirmError('');
    if (action === 'off') {
      setFamilyMode(false);
      lock();
      showToast('Family Mode off');
    } else if (action === 'clear') {
      await setFamilyPasscode(null);
      setPasscodeInput('');
      showToast('Family passcode removed');
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

  const handleAddIptv = async (e) => {
    e.preventDefault();
    const name = iptvName.trim();
    const url = iptvUrl.trim();
    if (!url) { showToast('Playlist URL is required', 'error'); return; }
    if (!/^https?:\/\/.+/i.test(url)) { showToast('Enter a valid http/https URL', 'error'); return; }

    setIptvLoading(true);
    try {
      const api = getApi();
      const result = await api.addIptvSource(name || 'IPTV Playlist', url);
      if (result?.success) {
        showToast(`Added ${result.inserted || 0} channels from "${name || 'playlist'}"`);
        setIptvName(''); setIptvUrl('');
        autoSync();
        window.dispatchEvent(new Event('scrapers-synced'));
        const src = await api.getIptvSources();
        if (src?.success) setIptvSources(src.data);
      } else {
        showToast(result?.error || 'Failed to add IPTV source', 'error');
      }
    } catch (err) {
      showToast('Failed to add IPTV source: ' + err.message, 'error');
    } finally {
      setIptvLoading(false);
    }
  };

  const handleRemoveIptv = async (sourceId) => {
    try {
      const api = getApi();
      await api.removeIptvSource(sourceId);
      setIptvSources(prev => prev.filter(s => s.id !== sourceId));
      showToast('IPTV source removed');
      autoSync();
      window.dispatchEvent(new Event('scrapers-synced'));
    } catch (err) {
      showToast('Failed to remove source', 'error');
    }
  };

  const handleScrapeAdultSite = async (e) => {
    e.preventDefault();
    const url = adultSiteUrl.trim();
    const name = adultSiteName.trim();
    if (!url) { showToast('Site URL is required', 'error'); return; }

    setScrapingAdult(true);
    try {
      const api = getApi();
      const result = await api.runScrapers([url]);
      if (result?.success) {
        showToast(`Added ${result.inserted || 0} videos from "${name || url}"`);
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
        <h1 className="page-title">Settings</h1>
      </div>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-6.36l-1.42 1.42M7.05 16.95l-1.41 1.41m12.72 0l-1.41-1.41M7.05 7.05L5.64 5.64M12 8a4 4 0 100 8 4 4 0 000-8z" />
          </svg>
          <h2>Appearance &amp; Family</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              Theme
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Dark Cyber (default) or Light Sky.
              </span>
            </span>
            <div className="theme-options" style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'dark-cyber' ? 'active' : ''}`}
                onClick={() => setTheme('dark-cyber')}
              >
                <span className="theme-swatch dark"></span> Dark Cyber
              </button>
              <button
                type="button"
                className={`theme-option ${settings.theme === 'light-sky' ? 'active' : ''}`}
                onClick={() => setTheme('light-sky')}
              >
                <span className="theme-swatch light"></span> Light Sky
              </button>
            </div>
          </div>

          <div className="toggle-item">
            <span>
              Family Mode
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Hides adult content everywhere and locks the Adult Sites tab. Add a passcode to prevent turning it off.
              </span>
            </span>
            <button
              type="button"
              className={`toggle ${settings.familyMode ? 'active' : 'off'}`}
              onClick={() => settings.familyMode ? handleFamilyModeOff() : setFamilyMode(true)}
            >
              {settings.familyMode ? 'On' : 'Off'}
            </button>
          </div>

          <div className="toggle-item">
            <span>
              Family passcode
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Required to turn Family Mode off or open the Adult tab. {hasFamilyPasscode() ? 'Already set.' : 'Not set.'}
              </span>
            </span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                type="password"
                className="form-input"
                placeholder="New passcode"
                value={passcodeInput}
                onChange={(e) => setPasscodeInput(e.target.value)}
                style={{ width: '160px' }}
              />
              <button type="button" className="btn btn-primary btn-small" onClick={handleSavePasscode}>
                Save
              </button>
              <button type="button" className="btn btn-secondary btn-small" onClick={handleClearPasscode}>
                Remove
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
          <h2>Backup &amp; Restore</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              Export backup
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Saves playlists, playlist items, favorites and custom IPTV sources into a single .json file.
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={handleExportBackup} disabled={backupBusy}>
              {backupBusy ? 'Working…' : 'Export'}
            </button>
          </div>
          <div className="toggle-item">
            <span>
              Restore backup
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Re-imports a previous .json backup. Existing entries are kept, missing ones are added.
              </span>
            </span>
            <button type="button" className="btn btn-secondary btn-small" onClick={handleImportBackup} disabled={backupBusy}>
              {backupBusy ? 'Working…' : 'Import'}
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
          <h2>Cloud Sync</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              Cloud sync
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                {cloudState.user
                  ? `Connected as ${cloudState.user.email || cloudState.user.username}${cloudState.enabled ? '' : ' — sync disabled'}.`
                  : 'Not connected. Favorites, playlists and IPTV sources stay local until you connect.'}
              </span>
            </span>
            <button
              type="button"
              className={`toggle ${cloudState.enabled ? 'active' : 'off'}`}
              onClick={() => handleCloudEnable(!cloudState.enabled)}
              disabled={!cloudState.user}
            >
              {cloudState.enabled ? 'On' : 'Off'}
            </button>
          </div>

          {cloudState.user && (
            <div className="toggle-item">
              <span>
                Manual sync
                <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                  Push local changes up and pull remote changes down right now.
                </span>
              </span>
              <button type="button" className="btn btn-primary btn-small" onClick={handleCloudSync} disabled={cloudSyncBusy}>
                {cloudSyncBusy ? 'Syncing…' : 'Sync Now'}
              </button>
            </div>
          )}
        </div>

        <form className="settings-form" style={{ marginTop: '16px' }} onSubmit={cloudRegisterMode ? handleCloudRegister : handleCloudLogin}>
          <div className="form-group">
            <label htmlFor="cloud-url">Server URL</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                id="cloud-url"
                type="text"
                className="form-input"
                style={{ flex: 1 }}
                placeholder="http://132.145.159.2:8090"
                value={cloudServerUrl}
                onChange={(e) => setCloudServerUrl(e.target.value)}
                disabled={cloudBusy}
              />
              <button type="button" className="btn btn-secondary btn-small" onClick={handleCloudTest} disabled={cloudBusy || !cloudServerUrl.trim()}>
                Test
              </button>
            </div>
            <p className="form-hint">
              Your PocketBase server (see deploy/ — docker compose on 132.145.159.2). Schema is created by the deploy script.
            </p>
          </div>

          {cloudRegisterMode && (
            <div className="form-group">
              <label htmlFor="cloud-username">Username (optional)</label>
              <input
                id="cloud-username"
                type="text"
                className="form-input"
                placeholder="e.g. myhub"
                value={cloudUsername}
                onChange={(e) => setCloudUsername(e.target.value)}
                disabled={cloudBusy}
              />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="cloud-email">Email</label>
            <input
              id="cloud-email"
              type="email"
              className="form-input"
              placeholder="you@example.com"
              value={cloudEmail}
              onChange={(e) => setCloudEmail(e.target.value)}
              disabled={cloudBusy}
            />
          </div>

          <div className="form-group">
            <label htmlFor="cloud-password">Password</label>
            <input
              id="cloud-password"
              type="password"
              className="form-input"
              placeholder={cloudRegisterMode ? '6+ characters' : 'Your password'}
              value={cloudPassword}
              onChange={(e) => setCloudPassword(e.target.value)}
              disabled={cloudBusy}
            />
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={cloudBusy}>
              {cloudBusy ? 'Working…' : (cloudRegisterMode ? 'Create Account' : (cloudState.user ? 'Reconnect' : 'Connect'))}
            </button>
            {cloudState.user && (
              <button type="button" className="btn btn-secondary btn-small" onClick={handleCloudLogout}>
                Logout
              </button>
            )}
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setCloudRegisterMode(v => !v)} disabled={cloudBusy}>
              {cloudRegisterMode ? 'Use existing account' : 'Create account'}
            </button>
          </div>
        </form>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66l1.41-1.41M4.93 19.07l1.41-1.41m12.72 1.41l-1.41-1.41M6.34 6.34L4.93 4.93M12 8a4 4 0 104 4 4 4 0 00-4-4z" />
          </svg>
          <h2>Scraper Management</h2>
        </div>

        {/* Add Scraper Form */}
        <form className="settings-form" onSubmit={handleAddScraper}>
          <div className="form-group">
            <label htmlFor="site-name">Site Name</label>
            <input
              id="site-name"
              type="text"
              className="form-input"
              placeholder="e.g. Example Streams"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label>Target URLs</label>
            {urls.map((url, index) => (
              <div key={index} className="url-row" style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <input
                  type="url"
                  className="form-input"
                  style={{ flex: 1 }}
                  placeholder="https://example.com/browse"
                  value={url}
                  onChange={(e) => {
                    const next = [...urls];
                    next[index] = e.target.value;
                    setUrls(next);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => removeUrlField(index)}
                  disabled={urls.length <= 1}
                  aria-label="Remove URL field"
                >
                  &times;
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-small" onClick={addUrlField}>
              + Add URL
            </button>
            <p className="form-hint">
              Enter one or more category/browse page URLs. The scraper will extract video links from these pages.
            </p>
          </div>

          <button type="submit" className="btn btn-primary">Add Scraper</button>
        </form>

        {/* Saved Scrapers List */}
        <div className="section-title" style={{ marginTop: '40px' }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM8 7h8M8 12h8M8 17h5" />
          </svg>
          <h2>Saved Scrapers</h2>
        </div>

        {loading ? (
          <div className="empty-state">
            <p>Loading scrapers...</p>
          </div>
        ) : savedScrapers.length === 0 ? (
          <div className="empty-state">
            <p>No scrapers saved yet.</p>
            <p className="form-hint">Use the form above to add your first target site.</p>
          </div>
        ) : (
          <div className="scraper-list">
            {savedScrapers.map((scraper) => (
              <div key={scraper.id} className="scraper-item">
                <div className="scraper-name">
                  <div className="text-white font-medium">{scraper.siteName}</div>
                  <ul className="mt-1 space-y-1">
                    {(scraper.urls || []).map((u, i) => (
                      <li key={i} className="scraper-details">{u}</li>
                    ))}
                  </ul>
                </div>
                <div className="scraper-actions" style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => testScraper(scraper)}
                    disabled={testingId === scraper.id}
                  >
                    {testingId === scraper.id ? 'Testing...' : 'Test Scraper'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-small"
                    onClick={() => removeScraper(scraper.id)}
                    disabled={removingId === scraper.id}
                  >
                    {removingId === scraper.id ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Sync */}
        <div className="settings-form" style={{ marginTop: '24px' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={syncScrapers}
            disabled={syncing || savedScrapers.length === 0}
          >
            {syncing ? 'Syncing...' : 'Sync Scrapers Now'}
          </button>
          <p className="form-hint">
            Run all saved scrapers and add any new videos to your Media Library.
          </p>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <h2>IPTV / Live TV</h2>
        </div>

        <form className="settings-form" onSubmit={handleAddIptv}>
          <div className="form-group">
            <label htmlFor="iptv-name">Playlist Name (optional)</label>
            <input
              id="iptv-name"
              type="text"
              className="form-input"
              placeholder="e.g. My IPTV, Sports, Movies"
              value={iptvName}
              onChange={(e) => setIptvName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="iptv-url">M3U / M3U8 Playlist URL</label>
            <input
              id="iptv-url"
              type="url"
              className="form-input"
              placeholder="https://example.com/playlist.m3u8"
              value={iptvUrl}
              onChange={(e) => setIptvUrl(e.target.value)}
            />
            <p className="form-hint">
              Paste an M3U or M3U8 playlist URL. Channels will appear in your Media Library.
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={iptvLoading}>
            {iptvLoading ? 'Loading playlist...' : 'Add IPTV Source'}
          </button>
        </form>

        {iptvSources.length > 0 && (
          <div className="scraper-list" style={{ marginTop: '20px' }}>
            {iptvSources.map((src) => (
              <div key={src.id} className="scraper-item">
                <div className="scraper-name">
                  <div className="text-white font-medium">{src.name}</div>
                  <div className="scraper-details">{src.channelCount} channels &middot; {src.url}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() => handleRemoveIptv(src.id)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
          <h2>Video Site Scraping (yt-dlp)</h2>
        </div>

        <p className="form-hint" style={{ marginBottom: '16px' }}>
          yt-dlp supports 1000+ sites including adult platforms (XVideos, Pornhub, etc.),
          YouTube, Vimeo, and more. Add a direct video URL, search page, or category page URL.
        </p>

        <form className="settings-form" onSubmit={handleScrapeAdultSite}>
          <div className="form-group">
            <label htmlFor="adult-name">Source Name (optional)</label>
            <input
              id="adult-name"
              type="text"
              className="form-input"
              placeholder="e.g. XVideos, Pornhub, YouTube"
              value={adultSiteName}
              onChange={(e) => setAdultSiteName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="adult-url">Video / Category / Search Page URL</label>
            <input
              id="adult-url"
              type="url"
              className="form-input"
              placeholder="https://www.example.com/category/some-category"
              value={adultSiteUrl}
              onChange={(e) => setAdultSiteUrl(e.target.value)}
            />
            <p className="form-hint">
              Works best with direct video pages, category pages, or search result pages.
              yt-dlp will extract video metadata and stream URLs automatically.
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={scrapingAdult}>
            {scrapingAdult ? 'Extracting videos...' : 'Scrape Site'}
          </button>
        </form>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            <path d="M13 5l3 3m0 0l-3 3m3-3H8a4 4 0 00-4 4v.5" />
          </svg>
          <h2>Playback &amp; Quality</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              Default volume
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Used the next time you open any video player.
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
              aria-label="Default volume"
              style={{ width: '160px', accentColor: '#3b82f6' }}
            />
            <span className="text-white font-mono text-sm" style={{ width: '44px', textAlign: 'right' }}>
              {Math.round((playbackPrefs.defaultVolume ?? 1) * 100)}%
            </span>
          </div>

          <div className="toggle-item">
            <span>
              Default playback speed
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Applied automatically in the player.
              </span>
            </span>
            <select
              className="form-input"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={playbackPrefs.defaultRate ?? 1}
              onChange={handleRatePref}
              aria-label="Default playback speed"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                <option key={rate} value={rate}>{rate}x</option>
              ))}
            </select>
          </div>

          <div className="toggle-item">
            <span>
              Preferred quality
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Auto picks the best available level. Works for adaptive (HLS) streams.
              </span>
            </span>
            <select
              className="form-input"
              style={{ width: 'auto', padding: '6px 10px' }}
              value={playbackPrefs.preferredQuality ?? 'auto'}
              onChange={handleQualityPref}
              aria-label="Preferred quality"
            >
              <option value="auto">Auto (best available)</option>
              <option value="max">Highest quality</option>
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
          <h2>Options</h2>
        </div>

        <div className="settings-toggles">
          <div className="toggle-item">
            <span>Use yt-dlp for stream extraction</span>
            <button
              type="button"
              className={`toggle ${ytDlpEnabled ? 'active' : 'off'}`}
              onClick={toggleYtDlp}
            >
              {ytDlpEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        <div className="danger-zone">
          <h3 className="text-red-400 font-semibold mb-2">Danger Zone</h3>
          <button type="button" className="clear-database" onClick={clearDatabase}>
            Clear Database
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="section-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 2l7 4v6c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6l7-4z" />
          </svg>
          <h2>API Keys &amp; Secrets</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              Secure vault
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Keys are encrypted on this PC with the OS keychain (Windows Credential Manager / DPAPI). Values never touch the repository.
              </span>
            </span>
          </div>
          <div className="toggle-item">
            <span>
              Stored keys
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Click a chip to remove it.
              </span>
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'flex-end', maxWidth: '60%' }}>
              {secretKeys.length === 0 && <span className="form-hint">None yet.</span>}
              {secretKeys.map((k) => (
                <button
                  key={k}
                  type="button"
                  title={`Remove "${k}"`}
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
              Add a key
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                e.g. SCRAPER_API_KEY, CLOUD_TOKEN, GITHUB_TOKEN…
              </span>
            </span>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                className="form-input"
                placeholder="Key name"
                value={secretName}
                onChange={(e) => setSecretName(e.target.value)}
                style={{ width: '150px' }}
              />
              <input
                className="form-input"
                type="password"
                placeholder="Value"
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                style={{ width: '180px' }}
              />
              <button type="submit" className="btn btn-primary btn-small" disabled={secretsBusy}>
                {secretsBusy ? 'Saving…' : 'Save'}
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
          <h2>Updates</h2>
        </div>
        <div className="settings-toggles">
          <div className="toggle-item">
            <span>
              App updates
              <span className="form-hint" style={{ display: 'block', fontSize: '11px' }}>
                Releases are pulled from GitHub automatically and installed on restart. Check manually below.
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={handleCheckUpdates} disabled={updateBusy}>
              {updateBusy ? 'Checking…' : 'Check for updates'}
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
            <h3>{confirmFor.action === 'off' ? 'Turn Family Mode off' : 'Remove family passcode'}</h3>
            <p>Enter your family passcode to continue.</p>
            <form onSubmit={handleConfirmSubmit}>
              <input
                type="password"
                className="form-input"
                placeholder="Family passcode"
                value={confirmCode}
                onChange={(e) => setConfirmCode(e.target.value)}
                autoFocus
              />
              {confirmError && <p className="passcode-error">{confirmError}</p>}
              <div className="passcode-actions">
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setConfirmFor(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary btn-small">Confirm</button>
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