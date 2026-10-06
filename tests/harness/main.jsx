// Browser harness entry: mounts the REAL src/components/VideoPlayer.jsx in a
// plain Chromium page. No component logic is re-implemented or mocked here —
// the only substitutions are the Electron IPC bridge (see stub-api.js) and
// PlaybackContext, whose createContext default already provides a no-op
// setMediaSession, so the component renders without a provider.
//
// Query params:
//   ?page=<url>  pageUrl handed to the player (non-media, so the component
//                exercises its real extractStream branch). Default /fixtures/page.html
//   ?src=<url>   URL that extractStream resolves to. Default /fixtures/sample.mp4
//   ?hls=1       report the extracted stream as HLS (drives the hls.js path)
//   ?direct=1    put the raw media URL in videoUrl so the direct-stream branch
//                is taken and extractStream is bypassed entirely

import React from 'react';
import { createRoot } from 'react-dom/client';
import { installStubApi } from './stub-api.js';
import VideoPlayer from '../../src/components/VideoPlayer.jsx';

const params = new URLSearchParams(window.location.search);
const direct = params.get('direct') === '1';
const pageUrl = params.get('page') || '/fixtures/page.html';
const src = params.get('src') || '/fixtures/sample.mp4';

installStubApi({ videoUrl: src, isHLS: params.get('hls') === '1' });

// Surface anything the component throws so a failing run leaves evidence.
window.__harnessErrors = [];
window.addEventListener('error', (e) => window.__harnessErrors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__harnessErrors.push(String(e.reason)));

const video = {
  id: 1,
  videoId: 1,
  videoTitle: 'Harness Clip',
  // Direct mode advertises the media URL itself; the default (page) mode hands
  // over a non-media page URL so the component must run extractStream first.
  pageUrl: direct ? undefined : pageUrl,
  videoUrl: direct ? src : pageUrl,
  sourceSite: 'Harness',
  type: 'Scraped Show',
  thumbnail: '',
};

createRoot(document.getElementById('root')).render(
  <VideoPlayer video={video} onClose={() => {}} />
);

window.__harnessReady = true;