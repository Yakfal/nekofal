import React from 'react';
import VideoSearchSection from '../components/VideoSearchSection.jsx';

const Discover = () => {
  return (
    <VideoSearchSection
      title="Discover"
      subtitle="Search the web like YouTube — type any video name, or paste a link to fetch a whole page/playlist/channel."
      placeholder="Search any video, or paste a YouTube / video page URL…"
      hint="Names search YouTube (and anything yt-dlp can reach). Pasting a URL pulls every video on that page, playlist or channel."
      tags={{ category: 'YouTube', sourceSite: 'YouTube', type: 'Web Video' }}
      accent="#3b82f6"
    />
  );
};

export default Discover;