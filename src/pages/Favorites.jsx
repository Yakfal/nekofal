import React, { useState, useEffect } from 'react';
import { useSearchContext } from '../contexts/SearchContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import MediaCard from '../components/MediaCard.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';

const Favorites = () => {
  const [favorites, setFavorites] = useState([]);
  const [loading, setLoading] = useState(true);
  const { searchQuery } = useSearchContext();
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;
  const { playVideo } = usePlayback();

  // Get the correct API namespace (api or electronAPI)
  const getApi = () => window.api || window.electronAPI;

  // Load favorites from database on mount
  useEffect(() => {
    loadFavorites();
  }, []);

  const loadFavorites = async () => {
    try {
      setLoading(true);
      const api = getApi();
      
      if (api?.getFavorites) {
        const result = await api.getFavorites();
        if (result.success && result.data) {
          // Transform database results to match MediaCard expected format.
          // Canonical rows carry a pageUrl (streams rotate) — use it as the
          // playback source so the fresh-stream pipeline re-extracts on play.
          const formatted = result.data.map(item => ({
            id: item.id,
            videoTitle: item.title || item.videoTitle,
            category: item.category || item.sourceSite || 'Demo',
            thumbnailUrl: item.thumbnailUrl,
            videoUrl: item.videoUrl || item.pageUrl || '',
            pageUrl: item.pageUrl || '',
            duration: item.duration || 1125,
            isHLS: item.isHLS || false,
            sourceSite: item.sourceSite || 'Demo'
          }));
          setFavorites(formatted);
          console.log('[Favorites] Loaded ' + formatted.length + ' favorites from database');
        } else {
          console.log('[Favorites] No favorites found in database');
          setFavorites([]);
        }
      }
    } catch (err) {
      console.error('[Favorites] Failed to load favorites:', err);
    } finally {
      setLoading(false);
    }
  };

  // Handle favorite toggle from MediaCard
  const handleToggleFavorite = async (videoId, isFav) => {
    if (isFav === false) {
      // Remove from favorites
      try {
        const api = getApi();
        if (api?.removeFavorite) {
          await api.removeFavorite(videoId);
        }
        setFavorites(prev => prev.filter(v => v.id !== videoId));
        console.log('[Favorites] Removed video ' + videoId + ' from favorites');
      } catch (err) {
        console.error('[Favorites] Failed to remove favorite:', err);
      }
    }
  };

  // Permanently delete a video (removes favorite row too, via db.deleteVideo)
  const handleDeleteVideo = async (videoId) => {
    try {
      const api = getApi();
      if (api?.deleteMedia) {
        await api.deleteMedia(videoId);
      }
      setFavorites(prev => prev.filter(v => v.id !== videoId));
    } catch (err) {
      console.error('[Favorites] Failed to delete video:', err);
    }
  };

  // Filter favorites based on search query and family mode
  const filteredFavorites = favorites.filter((video) => {
    if (familyMode && isAdultMedia(video)) return false;
    if (!searchQuery || searchQuery.trim() === '') return true;
    const query = searchQuery.toLowerCase().trim();
    return (
      video.videoTitle.toLowerCase().includes(query) ||
      video.category.toLowerCase().includes(query)
    );
  });

  return (
    <main className="favorites-page p-6 pb-20">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-white">Your Favorites</h1>
        <span className="text-gray-400 text-sm">{filteredFavorites.length} videos</span>
      </div>

      {searchQuery && (
        <p className="text-gray-400 text-sm mb-4">
          Filtered: {filteredFavorites.length} of {favorites.length} favorites
        </p>
      )}

      {loading ? (
        <div className="media-grid media-grid-loading">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="skeleton-card">
              <div className="skeleton-image skeleton aspect-[16/9]"></div>
              <div className="skeleton-line skeleton w-3/4 mt-3"></div>
              <div className="skeleton-line skeleton small w-1/2 mt-2"></div>
            </div>
          ))}
        </div>
      ) : filteredFavorites.length === 0 ? (
        <div className="text-center py-16">
          <svg className="w-20 h-20 mx-auto mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeWidth="1.5" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>
          </svg>
          <p className="text-xl text-white mb-2">No favorites yet</p>
          <p className="text-gray-400">Click the star icon on any video in the Library to add it to your favorites.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {filteredFavorites.map((video) => (
            <MediaCard 
              key={video.id}
              video={video}
              initialIsFavorite={true}
              onSelectVideo={playVideo}
              onToggleFavorite={handleToggleFavorite}
              onDeleteVideo={handleDeleteVideo}
            />
          ))}
        </div>
      )}
    </main>
  );
};

export default Favorites;