// Install the mobile IPC polyfill BEFORE App mounts: under Capacitor/Android
// there is no Electron main process, so window.api / window.electronAPI are
// bridged to IndexedDB + native fetch instead of crashing the renderer.
import './utils/ipcPolyfill.js';
// D-Pad / spatial navigation for Android TV remotes. Registers its own global
// keydown listeners; safe (inert) on desktop where __NEKOFAL_MOBILE__ is unset.
import './utils/spatialNav.js';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles/index.css';
import './styles/themes.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found!');
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);