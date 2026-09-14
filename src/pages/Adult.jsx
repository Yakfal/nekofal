import React, { useState, useEffect, useCallback } from 'react';
import VideoSearchSection from '../components/VideoSearchSection.jsx';
import './Adult.css';

const STORAGE_KEY = 'pmh-adult-sites';

const PRESETS = [
  { name: 'XVideos', searchTemplate: 'https://www.xvideos.com/?k={query}', homepage: 'https://www.xvideos.com/' }
];

const loadSites = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
};

const Adult = () => {
  const [sites, setSites] = useState(loadSites);
  const [activeId, setActiveId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', searchTemplate: '', homepage: '' });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
    } catch {}
  }, [sites]);

  useEffect(() => {
    if (activeId && !sites.some(s => s.id === activeId)) setActiveId(null);
  }, [sites, activeId]);

  const activeSite = sites.find(s => s.id === activeId) || null;

  const addSite = () => {
    const name = form.name.trim();
    if (!name) return;
    const site = {
      id: 'site-' + Date.now(),
      name,
      searchTemplate: form.searchTemplate.trim() || '',
      homepage: form.homepage.trim() || ''
    };
    setSites(prev => [...prev, site]);
    setActiveId(site.id);
    setForm({ name: '', searchTemplate: '', homepage: '' });
    setShowAdd(false);
  };

  const removeSite = (id) => {
    setSites(prev => prev.filter(s => s.id !== id));
  };

  const addPreset = (p) => {
    setSites(prev => {
      if (prev.some(s => s.searchTemplate === p.searchTemplate)) return prev;
      const site = { id: 'site-' + Date.now() + Math.random().toString(36).slice(2, 6), ...p };
      setActiveId(site.id);
      return [...prev, site];
    });
  };

  const siteTag = activeSite ? { category: 'Adult', sourceSite: activeSite.name, type: 'Web Video' } : { category: 'Adult', sourceSite: 'Web', type: 'Web Video' };

  return (
    <div className="adult-page">
      <div className="adult-header">
        <h1>Adult Sites</h1>
        <p>Search your added sites from here, play, favorite and download. Add any site with a {`{query}`} search template.</p>
      </div>

      <div className="adult-sites">
        <div className="adult-chip-row">
          {sites.length === 0 && (
            <span className="adult-empty-hint">No sites yet — add one below.</span>
          )}
          {sites.map(s => (
            <button
              key={s.id}
              className={`adult-chip ${activeId === s.id ? 'active' : ''}`}
              onClick={() => setActiveId(s.id)}
              title={s.searchTemplate || s.homepage}
            >
              {s.name}
              <span className="adult-chip-x" onClick={(e) => { e.stopPropagation(); removeSite(s.id); }}>×</span>
            </button>
          ))}
          <button className="adult-chip add" onClick={() => setShowAdd(true)}>+ Add Site</button>
        </div>

        <div className="adult-presets">
          {PRESETS.map(p => {
            const exists = sites.some(s => s.searchTemplate === p.searchTemplate);
            return (
              <button key={p.name} className="adult-preset" onClick={() => addPreset(p)} disabled={exists}>
                {exists ? `${p.name} ✓` : `+ ${p.name}`}
              </button>
            );
          })}
        </div>

        {showAdd && (
          <div className="adult-add-form">
            <input
              className="adult-input"
              placeholder="Site name (e.g. MyTube)"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
            />
            <input
              className="adult-input"
              placeholder="Search URL with {query}  e.g. https://www.example.com/?k={query}"
              value={form.searchTemplate}
              onChange={e => setForm({ ...form, searchTemplate: e.target.value })}
            />
            <input
              className="adult-input"
              placeholder="Homepage / category URL (optional)"
              value={form.homepage}
              onChange={e => setForm({ ...form, homepage: e.target.value })}
            />
            <div className="adult-add-actions">
              <button className="adult-btn primary" onClick={addSite} disabled={!form.name.trim()}>Save site</button>
              <button className="adult-btn" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
            <p className="adult-hint">
              Tip: no search URL? Paste the site's category/search page URL to enumerate its videos. Some sites block automation — try a different section or provider.
            </p>
          </div>
        )}
      </div>

      <VideoSearchSection
        key={activeId || 'none'}
        title={activeSite ? `Search · ${activeSite.name}` : 'Search the web'}
        subtitle={activeSite
          ? `Searches "${activeSite.name}". Names become site searches, links fetch whole pages.`
          : 'With no site selected, names search YouTube. Add a site to search inside it.'}
        placeholder={activeSite && activeSite.searchTemplate.includes('{query}')
          ? `Search ${activeSite.name}…`
          : activeSite
            ? `Search ${activeSite.name} by auto-filling its search form…`
            : 'Enter a name or paste a link…'}
        tags={siteTag}
        siteUrl={activeSite?.searchTemplate || activeSite?.homepage || null}
        hint={activeSite && activeSite.searchTemplate.includes('{query}')
          ? `Searching via ${activeSite.searchTemplate.replace('{query}', '…')}`
          : activeSite && activeSite.homepage
            ? `No search template — driving the site's own search form (${activeSite.homepage.replace(/^https?:\/\//, '')})`
            : ''}
        accent="#e11d48"
      />
    </div>
  );
};

export default Adult;