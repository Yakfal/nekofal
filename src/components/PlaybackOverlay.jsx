import React, { Suspense, lazy } from 'react';
import { usePlayback } from '../contexts/PlaybackContext.jsx';

const VideoPlayer = lazy(() => import('./VideoPlayer.jsx'));

export default function PlaybackOverlay() {
  const { activeVideo, activeChannels, activeChannelIndex, close, zapTo, resolving } = usePlayback();

  // Pre-mount re-extraction indicator (fresh stream being resolved for a saved
  // item that carries canonical page metadata instead of a live stream URL).
  if (resolving) {
    return (
      <div className="playback-resolving-overlay">
        <div className="loading-spinner"></div>
        <p>Fetching fresh stream&hellip;</p>
        {resolving.title && <span className="playback-resolving-title">{resolving.title}</span>}
      </div>
    );
  }

  if (!activeVideo) return null;

  return (
    <Suspense fallback={null}>
      <VideoPlayer
        video={activeVideo}
        onClose={close}
        channelList={activeChannels}
        channelIndex={activeChannelIndex}
        onZapTo={zapTo}
      />
    </Suspense>
  );
}