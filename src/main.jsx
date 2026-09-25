// Install the mobile IPC polyfill BEFORE App mounts: under Capacitor/Android
// there is no Electron main process, so window.api / window.electronAPI are
// bridged to IndexedDB + native fetch instead of crashing the renderer.
import './utils/ipcPolyfill.js';
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