import React, { Suspense, lazy } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import AppLayout from './components/AppLayout.jsx';
import MediaLibrary from './pages/MediaLibrary.jsx';
import PlaybackOverlay from './components/PlaybackOverlay.jsx';
import Favorites from './pages/Favorites.jsx';
import Settings from './pages/Settings.jsx';
import Discover from './pages/Discover.jsx';
import Adult from './pages/Adult.jsx';
import AdultGate from './components/AdultGate.jsx';
import IPTV from './pages/IPTV.jsx';
import Playlists from './pages/Playlists.jsx';
import LiveRadio from './pages/LiveRadio.jsx';
import Cinema from './pages/Cinema.jsx';
import MiniPlayer from './pages/MiniPlayer.jsx';
import { SearchProvider } from './contexts/SearchContext.jsx';
import { AppSettingsProvider } from './contexts/AppSettingsContext.jsx';
import { PlaylistsProvider } from './contexts/PlaylistsContext.jsx';
import { PlaybackProvider } from './contexts/PlaybackContext.jsx';

const VideoPlayer = lazy(() => import('./components/VideoPlayer.jsx'));

export default function App() {
  return (
    <AppSettingsProvider>
      <HashRouter>
        <SearchProvider>
          <PlaylistsProvider>
            <PlaybackProvider>
              <PlaybackOverlay />
              <Suspense fallback={null}>
                <Routes>
                <Route path="/miniplayer" element={<MiniPlayer />} />
                <Route path="/" element={<AppLayout />}>
                  <Route index element={<Navigate to="/discover" replace />} />
                  <Route path="discover" element={<Discover />} />
                  <Route path="adult" element={<AdultGate />} />
                  <Route path="iptv" element={<IPTV />} />
                  <Route path="library" element={<MediaLibrary />} />
                  <Route path="favorites" element={<Favorites />} />
                  <Route path="playlists" element={<Playlists />} />
                  <Route path="radio" element={<LiveRadio />} />
                  <Route path="cinema" element={<Cinema />} />
                  <Route path="settings" element={<Settings />} />
                  <Route path="video/:videoUrl" element={<VideoPlayer />} />
                  <Route path="*" element={<Navigate to="/discover" replace />} />
                </Route>
              </Routes>
              </Suspense>
            </PlaybackProvider>
          </PlaylistsProvider>
        </SearchProvider>
      </HashRouter>
    </AppSettingsProvider>
  );
}