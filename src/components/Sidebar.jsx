import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import './Sidebar.css';

const makeChannelsSection = (withAdult, t) => ({
  id: 'channels',
  title: t('nav.channels'),
  items: [
    ...(withAdult ? [{ path: '/adult', label: t('nav.adult'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-4.6-9.33-9.67C1.35 8.94 3.34 6 6.5 6c2 0 3.5 1 4.5 2.5C12 6 13.5 6 16.5 6c3.16 0 5.15 2.94 3.83 5.33C19 16.4 12 21 12 21z"/>
      </svg>
    )}] : []),
    { path: '/iptv', label: t('nav.liveChannels'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="6" width="20" height="12" rx="1.5" strokeWidth="2"/>
        <path d="M8 2l4 4 4-4M5 18l-2.5 4M19 18l2.5 4" strokeWidth="2" strokeLinecap="round"/>
        <path d="M10 10.5l4 2.5-4 2.5v-5z" fill="currentColor"/>
      </svg>
    )},
    { path: '/radio', label: t('nav.liveRadio'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="3" strokeWidth="2"/>
        <path d="M12 5v0a7 7 0 017 7M12 5v0a7 7 0 00-7 7M5 5l2.5 14M19 5l-2.5 14" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    )},
    { path: '/cinema', label: t('nav.freeMovies'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="6" width="20" height="14" rx="2" strokeWidth="2"/>
        <path d="M9 6l3 4 3-4" strokeWidth="2" strokeLinecap="round"/>
        <path d="M17 3l-1 3M7 3l1 3" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    )},
  ]
});

const makeBrowseSection = (t) => ({
  id: 'browse',
  title: t('nav.browse'),
  items: [
    { path: '/discover', label: t('nav.home'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M3 11.5L12 4l9 7.5"/>
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M5.5 10v9.5h13V10"/>
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M10 19.5v-5h4v5"/>
      </svg>
    )},
    { path: '/library', label: t('nav.library'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="2" width="20" height="20" rx="2.18" strokeWidth="2"/>
        <path d="M7 2v7h7V2" strokeWidth="2" strokeLinecap="round"/>
        <circle cx="17" cy="7" r="1.43" fill="currentColor"/>
      </svg>
    )},
    { path: '/favorites', label: t('nav.favorites'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976-2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
      </svg>
    )},
    { path: '/playlists', label: t('nav.mixes'), icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="9" strokeWidth="2"/>
        <circle cx="12" cy="12" r="2.5" strokeWidth="2"/>
        <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeWidth="1.6" strokeLinecap="round"/>
      </svg>
    )},
  ]
});

const Sidebar = ({ isCollapsed, toggleSidebar, width }) => {
  const { settings } = useAppSettings();
  const { t } = useLanguage();
  const [appVersion, setAppVersion] = useState(null);
  const withAdult = !settings.familyMode;

  useEffect(() => {
    let alive = true;
    const fetchVersion = window.api?.getVersion ? window.api.getVersion() : (window.electronAPI?.getVersion?.() );
    fetchVersion?.then((v) => {
      if (alive) setAppVersion(v);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const sections = [
    makeBrowseSection(t),
    makeChannelsSection(withAdult, t),
    {
      id: 'system',
      title: t('nav.system'),
      items: [
        { path: '/settings', label: t('nav.settings'), icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
          </svg>
        )},
      ]
    },
  ];

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`} style={{ width }}>
      {/* Menu Toggle Button */}
      <button 
        className="sidebar-toggle"
        onClick={toggleSidebar}
        aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" 
            d={isCollapsed ? "M15 19l-7-7 7-7" : "M3 12h18"}
          />
        </svg>
      </button>

      {/* Navigation Menu */}
      <nav className="sidebar-nav">
        {sections.map((section) => (
          <div key={section.id || section.title} className="sidebar-section">
            {!isCollapsed && <span className="sidebar-section-title">{section.title}</span>}
            {section.items.map((item) => (
              <NavLink 
                key={item.path} 
                to={item.path}
                className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              >
                <span className="sidebar-icon">{item.icon}</span>
                {!isCollapsed && <span className="sidebar-label">{item.label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer / Credits */}
      {!isCollapsed && (
        <div className="sidebar-footer">
          <p className="sidebar-credits">
            Nekofal v{appVersion || '1.0.0'}<br/>
            &copy; {new Date().getFullYear()}
          </p>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;