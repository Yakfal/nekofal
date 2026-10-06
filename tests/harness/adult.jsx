// Harness page for the real Family-Mode passcode gate — the app's name for the
// "Adult PIN" (src/components/AdultGate.jsx + src/contexts/AppSettingsContext.jsx).
//
// Both are the REAL components. Only the cloud-sync adapter is stubbed, because
// it talks to the Electron DB bridge; the localStorage persistence
// (yakfal-hub-preferences), the SHA-256 passcode hashing, the gate markup and
// the unlock/lock transitions are all the production code paths.
//
// Test hooks on window:
//   __setPasscode(code)   create/set the passcode through the real context API
//   __context()           read current { familyMode, unlocked, hasPasscode }
//   __lock()              re-lock the session (simulates a fresh app launch)
//   __errors              anything that threw

import React from 'react';
import { createRoot } from 'react-dom/client';

// Only the cloud-sync/DB adapter is stubbed, and it is stubbed at BUILD time via
// a Vite resolve.alias (see vite.harness.config.js) because an ES-module
// namespace object is frozen and cannot be patched at runtime.
//
// Everything exercised below is production code: the SHA-256 passcode hashing,
// localStorage persistence (yakfal-hub-preferences), the gate markup in
// AdultGate.jsx, and every unlock/lock transition in AppSettingsContext.jsx.

import { AppSettingsProvider, useAppSettings } from '../../src/contexts/AppSettingsContext.jsx';
import AdultGate from '../../src/components/AdultGate.jsx';

window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason)));

// Bridge so the test can read/drive the REAL context from outside React.
let ctxRef = null;
const Capture = () => {
  ctxRef = useAppSettings();
  return <AdultGate />;
};

createRoot(document.getElementById('root')).render(
  <AppSettingsProvider>
    <Capture />
  </AppSettingsProvider>
);

window.__context = () => {
  if (!ctxRef) return null;
  return {
    familyMode: !!ctxRef.settings.familyMode,
    unlocked: !!ctxRef.unlocked,
    hasPasscode: ctxRef.hasFamilyPasscode(),
    storedPrefs: localStorage.getItem('yakfal-hub-preferences'),
  };
};

window.__setPasscode = async (code) => {
  if (!ctxRef) throw new Error('context not ready');
  return ctxRef.setFamilyPasscode(code);
};

window.__verify = async (code) => (ctxRef ? ctxRef.verifyFamilyPasscode(code) : false);

window.__lock = () => { if (ctxRef) ctxRef.lock(); };

window.__harnessReady = true;
