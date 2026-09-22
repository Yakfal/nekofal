import React, { useEffect, useState, useRef, forwardRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSearchContext } from '../contexts/SearchContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import logoUrl from '../assets/logo.svg';
import './Navbar.css';

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const Navbar = forwardRef(function Navbar(props, ref) {
  const { searchQuery, setSearchQuery } = useSearchContext();
  const { settings, setTheme } = useAppSettings();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [appVersion, setAppVersion] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    const fetchVersion = window.api?.getVersion ? window.api.getVersion() : (window.electronAPI?.getVersion?.());
    fetchVersion?.then((v) => {
      if (alive) setAppVersion(v);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const isVideoPlayerPage = location.pathname.startsWith('/video/');
  const isLibraryPage = location.pathname === '/library';

  // Live library-sync status. Backed by the `scrapers-sync-started`/`scrapers-synced`
  // events fired by main's background scraper sync (and by in-app refresh actions).
  const [syncState, setSyncState] = useState({ syncing: false, lastSynced: null, inserted: 0 });

  useEffect(() => {
    const onStarted = () => setSyncState(s => ({ ...s, syncing: true }));
    const onSynced = (e) => {
      const d = (e && e.detail) || {};
      setSyncState(s => ({
        syncing: false,
        lastSynced: Date.now(),
        inserted: d.inserted !== undefined ? d.inserted : s.inserted,
      }));
    };
    window.addEventListener('scrapers-sync-started', onStarted);
    window.addEventListener('scrapers-synced', onSynced);
    return () => {
      window.removeEventListener('scrapers-sync-started', onStarted);
      window.removeEventListener('scrapers-synced', onSynced);
    };
  }, []);

  // Forward the ref to the menu wrapper
  const menuWrapperRef = useRef(null);
  React.useImperativeHandle(ref, () => ({
    toggleMenu: () => setShowMenu(prev => !prev),
    closeMenu: () => setShowMenu(false),
  }), []);

  // Handle escape key to close search
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsSearchOpen(false);
        setShowMenu(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!event.target.closest('.app-menu-wrapper')) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  // Handle escape key to close search and menu
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsSearchOpen(false);
        setShowMenu(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  const handleMenuItemClick = (action) => {
    setShowMenu(false);
    switch (action) {
      case 'devtools':
        if (window.electronAPI?.openDevTools) {
          window.electronAPI.openDevTools();
        } else if (window.require) {
          try {
            const { remote } = window.require('electron');
            remote.getCurrentWindow().toggleDevTools();
          } catch (e) {
            console.log('DevTools toggle not available in this context');
          }
        }
        break;
    }
  };

  return (
    <nav className="navbar">
      <div className="navbar-container">
        {/* Logo - links to library */}
        <NavLink 
          to="/library" 
          className="nav-logo" 
          aria-label="Go to library"
        >
          <img src={logoUrl} alt="Nekofal" className="logo-icon" draggable={false} />
          <span className="logo-text">Nekofal</span>
        </NavLink>

        {/* Search Bar - only on the Library page */}
        {isLibraryPage && (
          <div className={`search-container ${isSearchOpen ? 'open' : ''}`}>
          <div 
            className="search-input-wrapper"
            onClick={() => setIsSearchOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            <input
              type="text"
              placeholder={searchQuery ? 'Search' : 'Search videos...'}
              value={searchQuery || ''}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setIsSearchOpen(true);
              }}
              className="search-input"
            />
            {searchQuery && (
              <button 
                onClick={(e) => { e.stopPropagation(); setSearchQuery(''); }}
                className="clear-search"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Search Results Dropdown */}
          {searchQuery && (
            <ul className="search-results">
              <li className="search-placeholder">Showing results for "{searchQuery}"</li>
            </ul>
          )}
          </div>
        )}

        {/* Library sync status — live pill for background scraper syncs */}
        {!isVideoPlayerPage && (
          <div
            className="sync-status"
            title={syncState.lastSynced ? `Last synced ${timeAgo(syncState.lastSynced)}` : 'Library not synced yet'}
          >
            <span className={`sync-dot ${syncState.syncing ? 'pulse' : ''}`} aria-hidden="true" />
            <span className="sync-status-text">
              {syncState.syncing
                ? 'Updating library…'
                : syncState.lastSynced
                  ? `Synced ${timeAgo(syncState.lastSynced)}`
                  : 'Library in sync'}
              {!syncState.syncing && syncState.lastSynced && syncState.inserted > 0 && (
                <span className="sync-new">+{syncState.inserted}</span>
              )}
            </span>
          </div>
        )}

        {/* Theme toggle — quick sun/moon; the full menu entry lives in the ⋮ menu */}
        {!isVideoPlayerPage && (
          <button
            className="theme-toggle"
            aria-label="Toggle theme"
            title={settings.theme === 'dark-cyber' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme(settings.theme === 'dark-cyber' ? 'light-sky' : 'dark-cyber')}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              {settings.theme === 'dark-cyber' ? (
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 3v2m0 14v2M5.22 5.22l1.42 1.42m10.72 10.72l1.42 1.42M3 12h2m14 0h2M5.22 18.78l1.42-1.42M17.36 7.64l1.42-1.42M12 8a4 4 0 100 8 4 4 0 000-8z" />
              ) : (
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              )}
            </svg>
          </button>
        )}

        {/* App Menu - Three dots dropdown */}
        {!isVideoPlayerPage && (
          <div className="app-menu-wrapper" ref={ref}>
            <button 
              className="app-menu" 
              aria-label="App menu"
              onClick={() => setShowMenu(!showMenu)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
            </button>
            {showMenu && (
              <div className="app-menu-dropdown">
                <div className="dropdown-item" onClick={() => setTheme(settings.theme === 'dark-cyber' ? 'light-sky' : 'dark-cyber')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                  {settings.theme === 'dark-cyber' ? 'Light Theme' : 'Dark Theme'}
                </div>
                <div className="dropdown-divider"></div>
                <div className="dropdown-item" onClick={() => handleMenuItemClick('devtools')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M12 4h9m-9 8h9m-15 0v8m0-8l8-8m0 0l8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8m0-8l-8 8" />
                  </svg>
                  Open DevTools
                </div>
                <div className="dropdown-divider"></div>
                <div className="dropdown-item text-gray-400 text-xs px-3 py-2">
                  Nekofal v{appVersion || '1.0.0'}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Mobile Menu Button - visible only on small screens */}
        <button className="mobile-menu-toggle" aria-label="Menu">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        </button>
      </div>
    </nav>
  );
});

export default Navbar;