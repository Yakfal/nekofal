import React, { useState, useEffect, useRef, useCallback } from 'react';
import { bindMediaKey, unbindMediaKey } from '../utils/mediaKeys.js';
import { autoSync, favoritePayloadFor, getMediaId } from '../services/dbAdapter.js';
import { useLanguage } from '../i18n/LanguageContext.jsx';
import './LiveRadio.css';

const RADIO_API = 'https://de1.api.radio-browser.info/json/stations/topclick';

const LiveRadio = () => {
  const { t } = useLanguage();
  const [stations, setStations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState('');
  const audioRef = useRef(null);
  const audioRetryRef = useRef(0);
  const audioTimerRef = useRef(null);
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());
  const [togglingId, setTogglingId] = useState(null);

  // Load favorite ids once (radio stations id == stationuuid) so stars reflect
  // real DB state and toggle immediately through the shared db:toggleFavorite.
  const loadFavorites = useCallback(() => {
    const api = window.api || window.electronAPI;
    if (!api?.getFavorites) return;
    api.getFavorites()
      .then((res) => {
        if (res?.success && Array.isArray(res.data)) {
          setFavoriteSet(new Set(res.data.map(r => getMediaId(r)).filter(Boolean)));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadFavorites();
  }, [loadFavorites]);

  const handleToggleFavorite = async (station) => {
    const key = getMediaId(station);
    if (!key) return;
    setTogglingId(key);
    try {
      const api = window.api || window.electronAPI;
      const payload = favoritePayloadFor(station);
      if (!payload.type || payload.type === 'video') payload.type = 'Radio';
      const res = await api.toggleFavorite(payload);
      if (res?.success) {
        const favorited = res.data ? res.data.favorited : res.favorited;
        setFavoriteSet((prev) => {
          const next = new Set(prev);
          if (favorited) next.add(key);
          else next.delete(key);
          return next;
        });
        autoSync();
      }
    } catch (err) {
      console.warn('[Radio] favorite toggle failed:', err.message);
    } finally {
      setTogglingId(null);
    }
  };

  const loadStations = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(RADIO_API, { headers: { 'User-Agent': 'Nekofal/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const rows = (Array.isArray(data) ? data : []).map((s, i) => ({
        id: s.stationuuid || ('radio-' + i),
        name: s.name || 'Unnamed Station',
        streamUrl: s.url_resolved || s.url || '',
        favicon: s.favicon || '',
        tags: (s.tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 4),
        country: s.country || '',
        language: s.language || '',
        bitrate: s.bitrate || 0,
        codec: s.codec || '',
        clickcount: s.clickcount || 0
      })).filter(s => s.streamUrl);
      setStations(rows);
    } catch (err) {
      console.error('[Radio] failed to load stations:', err);
      setError('Could not reach the radio directory: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStations();
  }, [loadStations]);

  const stopPlayback = useCallback(() => {
    if (audioTimerRef.current) {
      clearTimeout(audioTimerRef.current);
      audioTimerRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    audioRetryRef.current = 0;
    setPlaying(false);
    setCurrent(null);
  }, []);

  useEffect(() => {
    return () => stopPlayback();
  }, [stopPlayback]);

  const playStation = (station) => {
    if (!audioRef.current) return;
    if (current?.id === station.id && playing) {
      audioRef.current.pause();
      setPlaying(false);
      return;
    }
    if (current?.id === station.id && !playing) {
      audioRef.current.play().catch(() => setError('Playback blocked for this stream'));
      setPlaying(true);
      return;
    }
    setCurrent(station);
    setPlaying(true);
  };

  useEffect(() => {
    if (audioRef.current && current) {
      audioRetryRef.current = 0;
      // Direct playback: Electron's session injects the stream User-Agent and
      // Referer natively (main.js webRequest), no local proxy relay needed.
      audioRef.current.src = current.streamUrl;
      audioRef.current.play().catch((err) => {
        console.warn('[Radio] play error:', err.message);
        setError('Could not play this stream (may be geo/format blocked)');
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Retry a live station after a temporary network blip (works with most
  // mp3/aac/ogg relays) before giving up after 4 attempts.
  const retryPlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !current) return;
    if (audioRetryRef.current >= 4) {
      setPlaying(false);
      return;
    }
    const attempt = audioRetryRef.current + 1;
    audioRetryRef.current = attempt;
    const delay = [600, 1200, 2400, 4800][Math.min(attempt - 1, 3)];
    console.warn(`[Radio] playback blip, retry ${attempt}/4 in ${delay}ms`);
    if (audioTimerRef.current) clearTimeout(audioTimerRef.current);
    audioTimerRef.current = setTimeout(() => {
      audioTimerRef.current = null;
      if (!audio || !current) return;
      const pos = audio.currentTime || 0;
      audio.src = current.streamUrl;
      if (pos > 0) { try { audio.currentTime = pos; } catch {} }
      audio.play().catch((err) => {
        console.warn('[Radio] retry play error:', err.message);
        setError('Could not play this stream (may be geo/format blocked)');
        setPlaying(false);
      });
    }, delay);
  }, [current]);

  const resetBlip = useCallback(() => {
    audioRetryRef.current = 0;
  }, []);

  const floatToMini = useCallback(async () => {
    if (!current) return;
    const api = window.api || window.electronAPI;
    const payload = {
      mode: 'audio',
      title: 'Radio · ' + current.name,
      streamUrl: current.streamUrl,
      streamHls: false,
      poster: current.favicon || '',
      currentTime: 0,
      volume: audioRef.current ? audioRef.current.volume : 1,
      muted: audioRef.current ? audioRef.current.muted : false,
      videoId: null
    };
    const res = await api?.openMiniPlayer?.(payload);
    if (res?.success) stopPlayback();
  }, [current, stopPlayback]);

  // Hardware media keys control the active station while on the radio page
  useEffect(() => {
    const stepToggle = () => { if (current) playStation(current); };
    bindMediaKey('playpause', stepToggle);
    bindMediaKey('stop', () => stopPlayback());
    return () => {
      unbindMediaKey('playpause');
      unbindMediaKey('stop');
    };
  });

  const filtered = stations.filter(s =>
    !search.trim() ||
    (s.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (s.tags || []).join(' ').toLowerCase().includes(search.toLowerCase()) ||
    (s.country || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="radio-page">
      <div className="radio-header">
        <h1 className="page-title">{t('nav.liveRadio')}</h1>
        <p className="radio-subtitle">Top-clicked stations from the radio-browser directory. Click any station to tune in.</p>
      </div>

      <div className="radio-toolbar">
        <input
          className="radio-search"
          placeholder="Search stations, genres, countries…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="radio-refresh" onClick={loadStations}>⟳ Refresh</button>
      </div>

      {loading ? (
        <div className="radio-loading">Loading stations…</div>
      ) : error && stations.length === 0 ? (
        <div className="radio-empty">
          <p>{error}</p>
          <button className="radio-refresh" onClick={loadStations}>Try again</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="radio-empty"><p>No stations match "{search}".</p></div>
      ) : (
        <div className="radio-grid">
          {filtered.map(s => {
            const isActive = current?.id === s.id;
            const favKey = getMediaId(s);
            const isFav = favoriteSet.has(favKey);
            return (
              <div
                key={s.id}
                className={`radio-station ${isActive ? 'active' : ''}`}
                onClick={() => playStation(s)}
                title={s.name}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') playStation(s); }}
              >
                <button
                  className={`radio-fav-btn ${isFav ? 'active' : ''}`}
                  title={isFav ? 'Remove from favorites' : 'Add to favorites'}
                  aria-pressed={isFav}
                  disabled={togglingId === favKey}
                  onClick={(e) => { e.stopPropagation(); handleToggleFavorite(s); }}
                >
                  {isFav ? '★' : '☆'}
                </button>
                <div className="radio-station-cover">
                  {s.favicon ? (
                    <img src={s.favicon} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  ) : null}
                  {isActive ? (
                    <span className="radio-eq">
                      <span></span><span></span><span></span><span></span>
                    </span>
                  ) : (
                    <span className="radio-play-badge">▶</span>
                  )}
                </div>
                <div className="radio-station-info">
                  <div className="radio-station-name">{s.name}</div>
                  <div className="radio-station-meta">
                    {[s.bitrate ? s.bitrate + 'k' : null, s.codec, s.country, s.language].filter(Boolean).join(' · ')}
                  </div>
                  {s.tags.length > 0 && (
                    <div className="radio-station-tags">{s.tags.join(', ')}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <audio ref={audioRef} onError={retryPlay} onStalled={retryPlay} onPlaying={resetBlip} onEnded={() => setPlaying(false)} />

      {current && (
        <div className="radio-nowplaying">
          <div className="radio-nowplaying-info">
            {playing ? '● LIVE' : 'Paused'} — {current.name}
          </div>
          <button className="radio-nowplaying-toggle" onClick={() => playStation(current)}>
            {playing ? '⏸' : '▶'}
          </button>
          <button className="radio-nowplaying-float" onClick={floatToMini} title="Float in mini player">
            ⁝
          </button>
          <button className="radio-nowplaying-stop" onClick={stopPlayback}>✕</button>
        </div>
      )}
    </div>
  );
};

export default LiveRadio;