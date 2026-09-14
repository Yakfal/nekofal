import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import './Sidebar.css';

const makeChannelsSection = (withAdult) => ({
  title: 'Channels',
  items: [
    ...(withAdult ? [{ path: '/adult', label: 'Adult Sites', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M12 21s-7-4.6-9.33-9.67C1.35 8.94 3.34 6 6.5 6c2 0 3.5 1 4.5 2.5C12 6 13.5 6 16.5 6c3.16 0 5.15 2.94 3.83 5.33C19 16.4 12 21 12 21z"/>
      </svg>
    )}] : []),
    { path: '/iptv', label: 'IPTV / Live TV', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="6" width="20" height="12" rx="1.5" strokeWidth="2"/>
        <path d="M8 2l4 4 4-4M5 18l-2.5 4M19 18l2.5 4" strokeWidth="2" strokeLinecap="round"/>
        <path d="M10 10.5l4 2.5-4 2.5v-5z" fill="currentColor"/>
      </svg>
    )},
    { path: '/radio', label: 'Live Radio', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <circle cx="12" cy="12" r="3" strokeWidth="2"/>
        <path d="M12 5v0a7 7 0 017 7M12 5v0a7 7 0 00-7 7M5 5l2.5 14M19 5l-2.5 14" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    )},
    { path: '/cinema', label: 'Classic Cinema', icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <rect x="2" y="5" width="20" height="14" rx="2" strokeWidth="2"/>
        <path d="M7 5l4 4M17 5l-4 4M7 19l4-4M17 19l-4-4" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    )},
  ]
});

const Sidebar = ({ isCollapsed, toggleSidebar, width }) => {
  const { settings } = useAppSettings();
  const withAdult = !settings.familyMode;

  const sections = [
  {
    title: 'Browse',
    items: [
      { path: '/discover', label: 'Discover', icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="11" cy="11" r="8" strokeWidth="2"/>
          <path d="M21 21l-4.35-4.35" strokeWidth="2" strokeLinecap="round"/>
          <path d="M11 8l3 3-3 3-3-3 3-3z" fill="currentColor"/>
        </svg>
      )},
      { path: '/library', label: 'Library', icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <rect x="2" y="2" width="20" height="20" rx="2.18" strokeWidth="2"/>
          <path d="M7 2v7h7V2" strokeWidth="2" strokeLinecap="round"/>
          <circle cx="17" cy="7" r="1.43" fill="currentColor"/>
        </svg>
      )},
      { path: '/favorites', label: 'Favorites', icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976-2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
        </svg>
      )},
      { path: '/playlists', label: 'Playlists', icon: (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M9 18V5l12-2v13M9 18a2 2 0 11-4 0 2 2 0 014 0zm12-2a2 2 0 11-4 0 2 2 0 014 0zM9 13l12-2"/>
        </svg>
      )},
    ]
  },
  makeChannelsSection(withAdult),
  {
    title: 'System',
    items: [
      { path: '/settings', label: 'Settings', icon: (
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
          <div key={section.title} className="sidebar-section">
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
            Nekofal v2.0<br/>
            &copy; {new Date().getFullYear()}
          </p>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;