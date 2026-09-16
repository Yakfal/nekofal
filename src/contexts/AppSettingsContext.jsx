import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'yakfal-hub-preferences';

const DEFAULT_SETTINGS = {
  theme: 'dark-cyber',
  familyMode: true,
  familyPasscodeHash: '',
};

const passcodeHash = async (code) => {
  try {
    const data = new TextEncoder().encode('yakfal-hub::' + code);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
};

const loadSettings = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Never trust/keep a plaintext passcode from older versions.
      delete parsed.familyPasscode;
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (err) {
    console.error('[AppSettings] Failed to load preferences:', err);
  }
  return { ...DEFAULT_SETTINGS };
};

const AppSettingsContext = createContext({
  settings: DEFAULT_SETTINGS,
  unlocked: false,
  setTheme: () => {},
  setFamilyMode: () => {},
  setFamilyPasscode: async () => {},
  verifyFamilyPasscode: async () => false,
  unlock: async () => false,
  lock: () => {},
  hasFamilyPasscode: () => false,
});

export const AppSettingsProvider = ({ children }) => {
  const [settings, setSettings] = useState(loadSettings);
  // Session-only: true once the correct passcode was entered while Family Mode
  // is on. Never persisted.
  const [unlocked, setUnlocked] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      console.error('[AppSettings] Failed to save preferences:', err);
    }
  }, [settings]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.setAttribute('data-family-mode', settings.familyMode ? 'on' : 'off');
  }, [settings.theme, settings.familyMode]);

  const value = useMemo(() => ({
    settings,
    unlocked,
    setTheme: (theme) => {
      setSettings(prev => ({ ...prev, theme }));
    },
    setFamilyMode: (familyMode) => {
      // Always allowed to turn ON; turning OFF is gated in the UI by passcode.
      setSettings(prev => ({ ...prev, familyMode: Boolean(familyMode) }));
      if (familyMode) setUnlocked(false);
    },
    setFamilyPasscode: async (passcode) => {
      const hash = passcode ? await passcodeHash(passcode) : '';
      setSettings(prev => ({ ...prev, familyPasscodeHash: hash }));
      return hash;
    },
    verifyFamilyPasscode: async (passcode) => {
      if (!settings.familyPasscodeHash) return true;
      const hash = await passcodeHash(passcode);
      return Boolean(hash) && hash === settings.familyPasscodeHash;
    },
    unlock: async (passcode) => {
      const ok = !settings.familyPasscodeHash ? true : (await passcodeHash(passcode)) === settings.familyPasscodeHash;
      if (ok) setUnlocked(true);
      return ok;
    },
    lock: () => setUnlocked(false),
    hasFamilyPasscode: () => Boolean(settings.familyPasscodeHash),
  }), [settings, unlocked]);

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
};

export const useAppSettings = () => useContext(AppSettingsContext);

export default AppSettingsContext;