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
//
// Test hooks exposed on window:
//   __loadVideo(src, opts)  remount the player on a DIFFERENT source with a new
//                            video id/key — this is how the E2E suite simulates
//                            "the user opened another video", which is the case
//                            the persistent-volume regression was about.
//   __swallowEvents(type)    stop the media element from delivering `type`
//                            (e.g. 'timeupdate') so a test can prove the timer
//                            still advances from the 250ms polling fallback
//                            alone, with no `timeupdate` help whatsoever.
//   __localVolume()         read the nekofal_user_volume key the component owns.

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

const root = createRoot(document.getElementById('root'));
let nextId = 1;

function mount(nextSrc, opts) {
  const options = opts || {};
  nextId += 1;
  installStubApi({
    videoUrl: nextSrc,
    isHLS: options.hls === true,
  });
  const video = {
    id: nextId,
    videoId: nextId,
    videoTitle: options.title || `Harness Clip ${nextId}`,
    // Direct mode advertises the media URL itself; the default (page) mode hands
    // over a non-media page URL so the component must run extractStream first.
    pageUrl: options.direct ? undefined : pageUrl,
    videoUrl: options.direct ? nextSrc : pageUrl,
    sourceSite: 'Harness',
    type: 'Scraped Show',
    thumbnail: '',
  };
  // A fresh key forces a genuine unmount/remount, exactly like navigating from
  // one video to the next.
  root.render(<VideoPlayer key={nextId} video={video} onClose={() => {}} />);
  return nextId;
}

mount(src, { direct });

window.__loadVideo = (nextSrc, opts) => mount(nextSrc, opts);

// Silence a media event type on the live element by intercepting its own
// dispatch. Returns a restore function.
window.__swallowEvents = (type) => {
  const el = document.querySelector('video');
  if (!el) return () => {};
  const original = el.dispatchEvent.bind(el);
  el.dispatchEvent = (event) => {
    if (event && event.type === type) return true;
    return original(event);
  };
  return () => { el.dispatchEvent = original; };
};

window.__localVolume = () => localStorage.getItem('nekofal_user_volume');

window.__harnessReady = true;
