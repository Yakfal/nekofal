import React, { useState, useEffect, useCallback } from 'react';
import VideoSearchSection from '../components/VideoSearchSection.jsx';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import './Adult.css';

const STORAGE_KEY = 'pmh-adult-sites';

const PRESETS = [
  { name: 'XVideos', searchTemplate: 'https://www.xvideos.com/?k={query}', homepage: 'https://www.xvideos.com/' },
  { name: 'XNXX', searchTemplate: 'https://www.xnxx.com/search/{query}', homepage: 'https://www.xnxx.com/' },
  { name: 'Pornhub', searchTemplate: 'https://www.pornhub.com/video/search?search={query}', homepage: 'https://www.pornhub.com/' }
];

// Sites whose search URL follows a known pattern. Matching is by hostname so
// www./m. subdomains all work — paste the main site URL and the app figures
// out the search format automatically (no manual ?k= guessing).
const KNOWN_SEARCH_URLS = [
  { host: 'xvideos.com', template: 'https://www.xvideos.com/?k={query}' },
  { host: 'xnxx.com', template: 'https://www.xnxx.com/search/{query}' },
  { host: 'pornhub.com', template: 'https://www.pornhub.com/video/search?search={query}' }
];

function detectSearchTemplate(input) {
  const raw = String(input || '').trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  const match = KNOWN_SEARCH_URLS.find(e => host === e.host || host.endsWith('.' + e.host));
  return match ? match.template : null;
}

function hostNameOf(input) {
  try { return new URL(String(input || '').trim()).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const loadSites = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
};

const Adult = () => {
  const { t } = useLanguage();
  const { settings } = useAppSettings();
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
    const name = form.name.trim() || hostNameOf(form.homepage) || t('adult.customSite');
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
        <h1>{t('nav.adult')}</h1>
        <p>{t('adult.subtitle')}</p>
      </div>

      <div className="adult-sites">
        <div className="adult-chip-row">
          {sites.length === 0 && (
            <span className="adult-empty-hint">{t('adult.noSites')}</span>
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
          <button className="adult-chip add" onClick={() => setShowAdd(true)}>{t('adult.addSite')}</button>
        </div>

        <div className="adult-presets">
          {!settings.familyMode && PRESETS.map(p => {
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
              placeholder={t('adult.siteNamePlaceholder')}
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
            />
            <input
              className="adult-input"
              placeholder={t('adult.homeUrlPlaceholder')}
              value={form.homepage}
              onChange={e => {
                const homepage = e.target.value;
                setForm(prev => {
                  const next = { ...prev, homepage };
                  if (!prev.name) next.name = hostNameOf(homepage);
                  if (!prev.searchTemplate) {
                    const t = detectSearchTemplate(homepage);
                    if (t) { next.searchTemplate = t; next.detected = true; }
                    else next.detected = false;
                  }
                  return next;
                });
              }}
            />
            <input
              className="adult-input"
              placeholder={t('adult.searchUrlPlaceholder')}
              value={form.searchTemplate}
              onChange={e => setForm({ ...form, searchTemplate: e.target.value, detected: false })}
            />
            <div className="adult-add-actions">
              <button className="adult-btn primary" onClick={addSite} disabled={!form.name.trim() && !form.homepage.trim()}>{t('adult.saveSite')}</button>
              <button className="adult-btn" onClick={() => setShowAdd(false)}>{t('common.cancel')}</button>
            </div>
            {form.detected && (
              <p className="adult-hint ok">
                {t('adult.detectedHint')}
              </p>
            )}
            <p className="adult-hint">
              {settings.familyMode ? t('adult.tipFamily') : t('adult.tip')}
            </p>
          </div>
        )}
      </div>

      <VideoSearchSection
        key={activeId || 'none'}
        title={activeSite ? `${t('adult.searchTitle')} · ${activeSite.name}` : t('adult.searchWeb')}
        subtitle={activeSite
          ? `${t('adult.searchesSite')} "${activeSite.name}". ${t('adult.namesSitesHint')}`
          : t('adult.noSiteSubtitle')}
        placeholder={activeSite && activeSite.searchTemplate.includes('{query}')
          ? `${t('common.search')} ${activeSite.name}…`
          : activeSite
            ? `${t('common.search')} ${activeSite.name} ${t('adult.byAutoFilling')}`
            : t('search.searchPlaceholder')}
        tags={siteTag}
        siteUrl={activeSite?.searchTemplate || activeSite?.homepage || null}
        hint={activeSite && activeSite.searchTemplate.includes('{query}')
          ? `${t('adult.searchingVia')} ${activeSite.searchTemplate.replace('{query}', '…')}`
          : activeSite && activeSite.homepage
            ? `${t('adult.noTemplate')} (${activeSite.homepage.replace(/^https?:\/\//, '')})`
            : ''}
        accent="#e11d48"
      />
    </div>
  );
};

export default Adult;