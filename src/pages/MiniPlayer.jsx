import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { bindMediaKey, unbindMediaKey } from '../utils/mediaKeys.js';
import './MiniPlayer.css';

const getApi = () => window.api || window.electronAPI;

const MiniPlayer = () => {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const retryTimerRef = useRef(null);
  const [payload, setPayload] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [manifestMeta, setManifestMeta] = useState(null);

  useEffect(() => {
    const api = getApi();
    if (!api?.onMiniPayload) return;
    const unsub = api.onMiniPayload((data) => setPayload(data));
    return () => { if (unsub) unsub(); };
  }, []);

  const destroyHls = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  };

  useEffect(() => {
    if (!payload) return;
    const video = videoRef.current;
    if (!video) return;

    destroyHls();
    retryAttemptRef.current = 0;
    document.title = payload.title || 'Nekofal Mini Player';

    const tryPlay = () => { video.play().catch(() => {}); };

    // Recover from temporary network blips (live streams hiccup on manifest,
    // segment or native source loads). Retries with backoff, resets on success.
    const scheduleRetry = (kind) => {
      if (retryAttemptRef.current >= 5) {
        destroyHls();
        return;
      }
      const attempt = retryAttemptRef.current + 1;
      retryAttemptRef.current = attempt;
      const delay = [600, 1200, 2400, 4800, 9600][Math.min(attempt - 1, 4)];
      console.warn(`[MiniPlayer] ${kind} stream blip, retry ${attempt}/5 in ${delay}ms`);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        const el = videoRef.current;
        if (!el) return;
        if (kind === 'hls' && hlsRef.current) {
          try { hlsRef.current.startLoad(); } catch {}
          return;
        }
        const pos = el.currentTime || 0;
        const src = el.currentSrc || el.src || payload.streamUrl;
        el.src = src;
        if (pos > 0) { try { el.currentTime = pos; } catch {} }
        el.play().catch(() => {});
      }, delay);
    };

    if (payload.streamHls && Hls.isSupported()) {
      hlsRef.current = new Hls();
      hlsRef.current.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
        retryAttemptRef.current = 0;
        const levels = data.levels || [];
        const current = Math.max(hlsRef.current?.currentLevel || 0, 0);
        setManifestMeta({
          levelCount: levels.length,
          level: current,
          qualLevel: levels[current] ? levels[current].height : 0
        });
      });
      hlsRef.current.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
        const levels = hlsRef.current?.levels || [];
        setManifestMeta({
          levelCount: levels.length,
          level: data.level,
          qualLevel: levels[data.level] ? levels[data.level].height : 0
        });
      });
      hlsRef.current.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          scheduleRetry('hls');
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRef.current) {
          try { hlsRef.current.recoverMediaError(); } catch {}
        } else {
          destroyHls();
        }
      });
      hlsRef.current.loadSource(payload.streamUrl);
      hlsRef.current.attachMedia(video);
    } else {
      video.src = payload.streamUrl;
      video.oncanplay = tryPlay;
      video.onplaying = () => { retryAttemptRef.current = 0; };
      video.onerror = () => scheduleRetry('native');
      video.onstalled = () => scheduleRetry('native');
    }

    video.volume = typeof payload.volume === 'number' ? payload.volume : 1;
    video.muted = !!payload.muted;
    try { video.currentTime = payload.currentTime || 0; } catch (e) {}
    tryPlay();
    setPlaying(!video.paused);
  }, [payload]);

  useEffect(() => () => {
    destroyHls();
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
  }, []);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (video.paused) await video.play();
      else video.pause();
    } catch (e) {}
    setPlaying(!video.paused);
  };

  const close = () => {
    destroyHls();
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    const api = getApi();
    if (api?.closeMiniPlayer) api.closeMiniPlayer();
  };

  // Restore/Expand back into the full player: report the CURRENT playback
  // state (fresh position/volume/mute) to the main process, which resumes the
  // video in the main window's overlay and closes this floating window.
  const restore = () => {
    const videoEl = videoRef.current;
    const api = getApi();
    const state = {
      title: payload?.title || '',
      streamUrl: videoEl?.currentSrc || videoEl?.src || payload?.streamUrl || '',
      streamHls: !!(payload?.streamHls && videoEl?.src?.includes('.m3u8')),
      poster: payload?.poster || '',
      currentTime: videoEl ? videoEl.currentTime || 0 : (payload?.currentTime || 0),
      volume: videoEl ? videoEl.volume : (Number.isFinite(Number(payload?.volume)) ? payload.volume : 1),
      muted: videoEl ? videoEl.muted : !!payload?.muted,
      videoId: payload?.videoId ?? null,
      isLocal: !!payload?.isLocal
    };
    if (api?.restoreMiniPlayer) api.restoreMiniPlayer(state);
    else if (api?.closeMiniPlayer) api.closeMiniPlayer();
  };

  useEffect(() => {
    bindMediaKey('playpause', () => togglePlay());
    bindMediaKey('stop', () => close());
    return () => {
      unbindMediaKey('playpause');
      unbindMediaKey('stop');
    };
  });

  if (!payload) {
    return (
      <div className="mini-wait">
        <div className="mini-spinner" />
        <div className="mini-wait-text">Waiting for content…</div>
      </div>
    );
  }

  return (
    <div className="mini-root">
      <div className="mini-titlebar">
        <span className="mini-title">{payload.title}</span>
      </div>
      <video
        ref={videoRef}
        className="mini-video"
        poster={payload.poster || undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="mini-controls">
        <button className="mini-btn" onClick={togglePlay} title="Play / Pause">
          {playing ? '❚❚' : '▶'}
        </button>
        {manifestMeta && manifestMeta.levelCount > 1 && (
          <span className="mini-quality">
            {manifestMeta.qualLevel ? `${manifestMeta.qualLevel}p` : 'auto'} · {manifestMeta.levelCount} levels
          </span>
        )}
        <button className="mini-btn mini-restore" onClick={restore} title="Restore to full player">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
        <button className="mini-btn mini-close" onClick={close} title="Stop and close">
          ✕
        </button>
      </div>
    </div>
  );
};

export default MiniPlayer;