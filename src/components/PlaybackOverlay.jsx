import { usePlayback } from '../contexts/PlaybackContext.jsx';
import VideoPlayer from './VideoPlayer.jsx';

export default function PlaybackOverlay() {
  const { activeVideo, activeChannels, activeChannelIndex, close, zapTo } = usePlayback();

  if (!activeVideo) return null;

  return (
    <VideoPlayer
      video={activeVideo}
      onClose={close}
      channelList={activeChannels}
      channelIndex={activeChannelIndex}
      onZapTo={zapTo}
    />
  );
}