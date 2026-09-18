import React, { useState, useRef, useEffect } from 'react';
import Navbar from './Navbar.jsx';
import Sidebar from './Sidebar.jsx';
import DownloadManager from './DownloadManager.jsx';
import { Outlet } from 'react-router-dom';
import { SearchProvider } from '../contexts/SearchContext.jsx';
import './ScrollFab.css';

const AppLayout = () => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(window.innerWidth < 960);
  const contentRef = useRef(null);
  const menuRef = useRef(null);
  const [updateToast, setUpdateToast] = useState(null);
  const [showScrollFab, setShowScrollFab] = useState(false);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 960 && !isSidebarCollapsed) return;
      setIsSidebarCollapsed(window.innerWidth < 960);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isSidebarCollapsed]);

  // Non-intrusive GitHub update notifications pushed from the main process.
  useEffect(() => {
    const api = window.api || window.electronAPI;
    if (!api?.onUpdateEvent) return undefined;
    const unsubscribe = api.onUpdateEvent((e) => {
      if (!e || !e.type) return;
      if (e.type === 'available') {
        setUpdateToast({ text: `Nekofal ${e.version || 'update'} found — downloading…`, action: null });
      } else if (e.type === 'progress') {
        setUpdateToast({ text: `Downloading update… ${Math.round(e.percent || 0)}%`, action: null });
      } else if (e.type === 'downloaded') {
        setUpdateToast({ text: 'Update downloaded — restart to install', action: 'restart' });
      } else {
        if (e.type === 'not-available' || e.type === 'error') {
          setUpdateToast((prev) => (prev && prev.action === 'restart') ? prev : null);
        }
      }
    });
    return unsubscribe;
  }, []);

  const toggleSidebar = () => setIsSidebarCollapsed(!isSidebarCollapsed);

  // Show the scroll-down affordance only when the routed page actually
  // overflows the viewport, and hide it once the user reaches the bottom.
  // Re-evaluates on scroll, resize, and any DOM change (async shelves/images).
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const overflow = el.scrollHeight - el.clientHeight;
      const nearBottom = el.scrollTop >= overflow - 140;
      setShowScrollFab(overflow > 160 && !nearBottom);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const observer = new MutationObserver(schedule);
    observer.observe(el, { childList: true, subtree: true });
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      resizeObserver.disconnect();
    };
  }, []);

  const scrollToLowerContent = () => {
    const el = contentRef.current;
    if (!el) return;
    el.scrollBy({ top: Math.max(el.clientHeight * 0.85, 320), behavior: 'smooth' });
  };

  const sidebarWidth = isSidebarCollapsed ? '72px' : '240px';

  return (
    <SearchProvider>
      <div className="layout-wrapper min-h-screen bg-brand-900 flex flex-col">
        <Navbar menuRef={menuRef} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar 
            isCollapsed={isSidebarCollapsed}
            toggleSidebar={toggleSidebar}
            width={sidebarWidth}
          />
          <main 
            ref={contentRef}
            className="main-content flex-1 w-full overflow-y-auto p-6"
            style={{ marginLeft: sidebarWidth, marginTop: '70px' }}
          >
            <Outlet />
          </main>
        </div>
        <DownloadManager />
      </div>

      {/* Scroll-down FAB — appears only when the page overflows the viewport */}
      {showScrollFab && (
        <button
          type="button"
          className="scroll-fab"
          onClick={scrollToLowerContent}
          title="Scroll down for more"
          aria-label="Scroll down for more content"
        >
          ↓
        </button>
      )}

      {/* Update notification toast */}
      {updateToast && (
        <div
          style={{
            position: 'fixed',
            bottom: '18px',
            right: '18px',
            zIndex: 5000,
            background: 'rgba(8, 12, 20, 0.96)',
            color: '#e2e8f0',
            border: '1px solid #334155',
            borderRadius: '12px',
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.55)',
            fontSize: '13px',
            maxWidth: '360px'
          }}
        >
          <span>{updateToast.text}</span>
          {updateToast.action === 'restart' && (
            <button
              onClick={() => { (window.api || window.electronAPI)?.quitAndInstall?.(); }}
              style={{
                background: '#3b82f6',
                color: '#fff',
                border: 'none',
                borderRadius: '8px',
                padding: '6px 12px',
                fontSize: '13px',
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              Restart & install
            </button>
          )}
          <button
            onClick={() => setUpdateToast(null)}
            style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </SearchProvider>
  );
};

export default AppLayout;