import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Navbar from './Navbar.jsx';
import Sidebar from './Sidebar.jsx';
import DownloadManager from './DownloadManager.jsx';
import AdultGate from './AdultGate.jsx';
import MediaLibrary from '../pages/MediaLibrary.jsx';
import Favorites from '../pages/Favorites.jsx';
import Settings from '../pages/Settings.jsx';
import Discover from '../pages/Discover.jsx';
import IPTV from '../pages/IPTV.jsx';
import Playlists from '../pages/Playlists.jsx';
import LiveRadio from '../pages/LiveRadio.jsx';
import Cinema from '../pages/Cinema.jsx';
import { SearchProvider } from '../contexts/SearchContext.jsx';
import './ScrollFab.css';

// Persistent view registry. Every main tab stays mounted once it has been
// visited — switching tabs only toggles `display` on the wrapper (never
// unmounts), so playing IPTV/radio streams, active searches and per-view
// scroll positions survive navigation.
const VIEWS = {
  '/discover': <Discover />,
  '/adult': <AdultGate />,
  '/iptv': <IPTV />,
  '/library': <MediaLibrary />,
  '/favorites': <Favorites />,
  '/playlists': <Playlists />,
  '/radio': <LiveRadio />,
  '/cinema': <Cinema />,
  '/settings': <Settings />,
};

const VIEW_PATHS = Object.keys(VIEWS);

// Map a router path to a persistent view key. The bare `/` (app home) maps to
// Discover, and transient/legacy routes (`/video/...`) keep the last view.
function resolveView(pathname) {
  if (!pathname || pathname === '/') return '/discover';
  return VIEW_PATHS.includes(pathname) ? pathname : null;
}

const AppLayout = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(window.innerWidth < 960);
  const activeViewRef = useRef(null);
  const menuRef = useRef(null);
  const [updateToast, setUpdateToast] = useState(null);
  const [showScrollFab, setShowScrollFab] = useState(false);
  const [scrollFabUp, setScrollFabUp] = useState(false);

  // Keep the last "real" tab in mind so transient routes (`/video/...`, the
  // legacy player URL) show the tab the user was on instead of a blank page.
  const lastViewRef = useRef('/discover');
  const rawView = resolveView(pathname);
  if (rawView) lastViewRef.current = rawView;
  const activeView = rawView || lastViewRef.current;

  // Views mount lazily on first visit and stay mounted for the session.
  const [mountedViews, setMountedViews] = useState(() => new Set([rawView || '/discover']));

  // Deep-linked home (`#/`) is normalized to Discover so the sidebar/NavLink
  // highlighting and React Router's URL stay consistent.
  useEffect(() => {
    if (pathname === '/') navigate('/discover', { replace: true });
  }, [pathname, navigate]);

  useEffect(() => {
    if (!mountedViews.has(activeView)) {
      setMountedViews((prev) => new Set(prev).add(activeView));
    }
  }, [activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  // Broadcast the active tab to every keep-alive media surface (IPTV pane,
  // Live Radio, Cinema). They listen for this and pause their stream when this
  // view is no longer the active one — preserving position/quality because the
  // handle itself is never destroyed, just muted for the background.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('nek-view-changed', { detail: { view: activeView } }));
  }, [activeView]);

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

  // Single smart scroll FAB. It appears only when the ACTIVE view actually
  // overflows, and toggles direction based on scroll position: ↓ near the top
  // (scroll down), ↑ once scrolled down (return to top). Each keep-alive view
  // is its own scroll container, so this re-attaches on tab switch.
  useEffect(() => {
    const el = activeViewRef.current;
    if (!el) return undefined;
    let frame = 0;
    const update = () => {
      frame = 0;
      const overflow = el.scrollHeight - el.clientHeight;
      const nearBottom = el.scrollTop >= overflow - 140;
      const atTop = el.scrollTop <= 120;
      setShowScrollFab(overflow > 160 && (atTop || !nearBottom));
      setScrollFabUp(!atTop);
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
  }, [activeView]);

  const handleScrollFabClick = () => {
    const el = activeViewRef.current;
    if (!el) return;
    if (scrollFabUp) {
      el.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      el.scrollBy({ top: Math.max(el.clientHeight * 0.85, 320), behavior: 'smooth' });
    }
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
            className="main-content flex-1 w-full overflow-hidden p-6 flex flex-col"
            style={{ marginLeft: sidebarWidth, marginTop: '70px' }}
          >
            {/* Keep-alive view stack: all visited views stay in the DOM; the
                active one is shown, the rest are just display:none. */}
            <div className="view-stack">
              {[...mountedViews].map((viewPath) => (
                <div
                  key={viewPath}
                  ref={viewPath === activeView ? activeViewRef : undefined}
                  className={`keepalive-view ${viewPath === activeView ? 'active' : ''}`}
                  style={{ display: viewPath === activeView ? 'block' : 'none' }}
                >
                  {VIEWS[viewPath]}
                </div>
              ))}
            </div>
          </main>
        </div>
        <DownloadManager />
      </div>

      {/* Smart scroll FAB — appears only when the active page overflows; ↓ near
          the top, ↑ once scrolled down. */}
      {showScrollFab && (
        <button
          type="button"
          className="scroll-fab"
          onClick={handleScrollFabClick}
          title={scrollFabUp ? 'Scroll to top' : 'Scroll down for more'}
          aria-label={scrollFabUp ? 'Scroll to top' : 'Scroll down for more content'}
        >
          {scrollFabUp ? '↑' : '↓'}
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