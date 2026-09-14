import React, { Suspense, lazy } from 'react';
import { usePlayback } from '../contexts/PlaybackContext.jsx';

const VideoPlayer = lazy(() => import('./VideoPlayer.jsx'));

export default function PlaybackOverlay() {
  const { activeVideo, activeChannels, activeChannelIndex, close, zapTo } = usePlayback();

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