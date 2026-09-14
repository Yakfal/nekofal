import React, { useState, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import './DownloadManager.css';

const getApi = () => window.api || window.electronAPI;

const formatBytes = (bytes) => {
  const b = Number(bytes) || 0;
  const mb = b / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
};

const formatEta = (sec) => {
  if (!sec || sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = String(Math.floor(sec % 60)).padStart(2, '0');
  return `${m}:${s}`;
};

const formatSpeed = (bytesPerSec) => {
  if (!bytesPerSec || bytesPerSec <= 0) return '—';
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
};

const formatRelativeTime = (ts) => {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString();
};

const DownloadManager = () => {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState([]);
  const [completed, setCompleted] = useState([]);
  const location = useLocation();
  const { activeVideo } = usePlayback();

  // Never let the floating Downloads button/panel overlap an active player:
  // hide it while on the fullscreen player route OR while a global video is open.
  const isPlayerActive = location.pathname.startsWith('/video') || !!activeVideo;

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api?.getDownloads) return;
    try {
      const state = await api.getDownloads();
      if (state?.active) setActive(state.active);
      if (state?.completed) setCompleted(state.completed);
    } catch (err) {
      console.error('[DownloadManager] Failed to load state:', err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const api = getApi();
    const unsubs = [];

    if (api?.onDownloadProgress) {
      unsubs.push(api.onDownloadProgress((d) => {
        setActive(prev => {
          const exists = prev.some(a => a.id === d.id);
          if (exists) return prev.map(a => (a.id === d.id ? { ...a, ...d } : a));
          return [{ id: d.id, title: d.title || 'Video', url: d.url, filePath: d.filePath, ...d }, ...prev];
        });
      }));
    }

    if (api?.onDownloadCompleted) {
      unsubs.push(api.onDownloadCompleted((d) => {
        setActive(prev => prev.filter(a => a.id !== d.id));
        setCompleted(prev => [d, ...prev]);
      }));
    }

    if (api?.onDownloadError) {
      unsubs.push(api.onDownloadError((d) => {
        setActive(prev => prev.map(a => (a.id === d.id ? { ...a, status: 'error', error: d.error } : a)));
      }));
    }

    if (api?.onDownloadsState) {
      unsubs.push(api.onDownloadsState((state) => {
        if (state?.active) setActive(state.active);
        if (state?.completed) setCompleted(state.completed);
      }));
    }

    return () => unsubs.forEach(u => { if (u) u(); });
  }, [refresh]);

  const handleRemove = async (id) => {
    const api = getApi();
    if (!api?.removeDownload) return;
    try {
      await api.removeDownload(id);
      setCompleted(prev => prev.filter(c => c.id !== id));
    } catch (err) {
      console.error('[DownloadManager] Remove failed:', err);
    }
  };

  const handleReveal = (path) => {
    const api = getApi();
    if (api?.revealDownload && path) api.revealDownload(path);
  };

  const activeCount = active.length;
  const recent = completed.slice(0, 25);

  if (isPlayerActive) return null;

  return (
    <>
      <button
        className={`dm-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        aria-label="Downloads"
        title="Downloads"
      >
        <span className="dm-toggle-icon">⬇</span>
        {activeCount > 0 && <span className="dm-badge">{activeCount}</span>}
      </button>

      <div className={`dm-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="dm-header">
          <h3>Downloads</h3>
          <button className="dm-close" onClick={() => setOpen(false)} aria-label="Close downloads panel">
            ×
          </button>
        </div>

        <div className="dm-body">
          {active.length === 0 && completed.length === 0 && (
            <div className="dm-empty">
              <div className="dm-empty-icon">⬇</div>
              <p>No downloads yet.</p>
              <p className="dm-empty-hint">Hit the download button in any video player to get started.</p>
            </div>
          )}

          {active.length > 0 && (
            <div className="dm-section">
              <div className="dm-section-title">Active downloads</div>
              {active.map(d => (
                <div key={d.id} className={`dm-item ${d.status === 'error' ? 'error' : ''}`}>
                  <div className="dm-item-title" title={d.title || d.filePath}>
                    {d.title || 'Video'}
                  </div>
                  {d.status === 'error' ? (
                    <div className="dm-item-error">{d.error || 'Download failed'}</div>
                  ) : (
                    <>
                      <div className="dm-progress">
                        <div className="dm-progress-bar" style={{ width: `${Math.min(100, d.percent || 0)}%` }} />
                      </div>
                      <div className="dm-item-meta">
                        <span>{(d.percent || 0).toFixed(1)}%</span>
                        <span>{formatSpeed(d.speed)}</span>
                        <span>ETA {formatEta(d.eta)}</span>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {recent.length > 0 && (
            <div className="dm-section">
              <div className="dm-section-title">Completed files</div>
              {recent.map(c => (
                <div key={c.id} className="dm-item completed">
                  <div className="dm-item-title" title={c.path}>
                    {c.title || c.path}
                  </div>
                  <div className="dm-item-meta">
                    <span>{formatBytes(c.sizeBytes)}</span>
                    <span>{formatRelativeTime(c.completedAt)}</span>
                  </div>
                  <div className="dm-item-actions">
                    <button className="dm-action" onClick={() => handleReveal(c.path)} title="Show in folder">
                      📁 Show in folder
                    </button>
                    <button className="dm-action" onClick={() => handleRemove(c.id)} title="Remove record">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default DownloadManager;