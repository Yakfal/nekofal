import React, { useEffect, useState, useRef, forwardRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useSearchContext } from '../contexts/SearchContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import logoUrl from '../assets/logo.svg';
import './Navbar.css';

const Navbar = forwardRef((props, ref) => {
  const { searchQuery, setSearchQuery } = useSearchContext();
  const { settings, setTheme } = useAppSettings();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const isVideoPlayerPage = location.pathname.startsWith('/video/');

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

  const handleSyncScrapers = async () => {
    if (isScraping) return;
    setIsScraping(true);
    
    try {
      if (window.electronAPI?.runScrapers) {
        const result = await window.electronAPI.runScrapers();
        if (result.success) {
          console.log(`Scrapers synced: ${result.inserted} new videos added`);
          window.dispatchEvent(new CustomEvent('scrapers-synced', { 
            detail: { inserted: result.inserted, total: result.totalVideos } 
          }));
        } else {
          console.error('Scraper sync failed:', result.error);
        }
      }
    } catch (err) {
      console.error('Failed to sync scrapers:', err);
    } finally {
      setIsScraping(false);
    }
  };

  const handleMenuItemClick = (action) => {
    setShowMenu(false);
    switch (action) {
      case 'refresh':
        window.dispatchEvent(new CustomEvent('scrapers-synced', { detail: { refresh: true } }));
        break;
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

        {/* Search Bar */}
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

        {/* Sync Scrapers Button */}
        {!isVideoPlayerPage && (
          <button 
            className="sync-button"
            onClick={handleSyncScrapers}
            disabled={isScraping}
            title="Sync Scrapers"
          >
            <svg 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor"
              className={isScraping ? 'spin' : ''}
            >
              <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M23 4v6h-6" />
              <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M1 20v-6h6" />
              <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            <span className="sync-tooltip">Sync Scrapers</span>
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
                <div className="dropdown-item" onClick={() => handleMenuItemClick('refresh')}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                    <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
                  </svg>
                  Refresh Library
                </div>
                <div className="dropdown-divider"></div>
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
                  Nekofal v1.0
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