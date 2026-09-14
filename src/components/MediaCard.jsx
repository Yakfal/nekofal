import React, { useState, useEffect } from 'react';
import { autoSync, favoritePayloadFor, getMediaId } from '../services/dbAdapter.js';
import PlaylistMenu from './PlaylistMenu.jsx';
import './MediaCard.css';

const MediaCard = ({ 
  video, 
  initialIsFavorite = false,
  onToggleFavorite,
  onSelectVideo,
  onDeleteVideo
}) => {
  const [isFavorite, setIsFavorite] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [favError, setFavError] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Explicit, validated payload for the favorites tables (local + cloud sync):
  //   { id, title, url, type, thumbnail, isAdult }
  // Electron's db:toggleFavorite normalizes it into the SQLite columns
  // (url -> videoUrl, type -> sourceSite, thumbnail -> thumbnailUrl).
  // Built through the shared dbAdapter helper so every card type (IPTV,
  // radio, archive.org item, search result) uses one canonical key/payload.
  const buildFavoritePayload = () => favoritePayloadFor(video);

  // Favorite state is driven by the parent via `initialIsFavorite`.

  // Sync with parent's initialIsFavorite prop changes
  useEffect(() => {
    if (initialIsFavorite !== undefined) {
      setIsFavorite(initialIsFavorite);
    }
  }, [initialIsFavorite]);

  const handleCardClick = (e) => {
    e.preventDefault();
    if (onSelectVideo) {
      onSelectVideo(video);
    }
  };

  const handleFavoriteToggle = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    
    if (isToggling) return;
    setIsToggling(true);
    setFavError(false);

    try {
      const api = window.api || window.electronAPI;
      const payload = buildFavoritePayload();
      if (!payload.id || !payload.url) {
        setFavError(true);
        return;
      }
      if (api?.toggleFavorite) {
        const result = await api.toggleFavorite(payload);
        if (result && result.success && result.data) {
          setIsFavorite(result.data.favorited);
          autoSync();
          if (onToggleFavorite) {
            onToggleFavorite(getMediaId(video), result.data.favorited);
          }
        } else {
          setFavError(true);
          if (onToggleFavorite) onToggleFavorite(getMediaId(video), null);
        }
      }
    } catch (err) {
      console.error('[MediaCard] Failed to toggle favorite:', err);
      setFavError(true);
      if (onToggleFavorite) onToggleFavorite(getMediaId(video), null);
    } finally {
      setIsToggling(false);
    }
  };

  const handleDelete = async (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!onDeleteVideo || isDeleting) return;
    if (!window.confirm(`Delete "${video.videoTitle || video.title || 'this item'}" permanently?`)) return;

    setIsDeleting(true);
    try {
      await onDeleteVideo(video.id);
    } catch (err) {
      console.error('[MediaCard] Delete failed:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleImageError = () => {
    setImageError(true);
  };

  const getPlaceholderImage = () => {
    return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 400"%3E%3Crect fill="%231f2937" width="600" height="400"/%3E%3Ccircle cx="300" cy="200" r="80" fill="%23374151"/%3E%3Ctext x="300" y="200" text-anchor="middle" fill="%236b7280" font-family="Arial" font-size="40"%3EVideo%20Thumb%3C/text%3E%3C/svg%3E';
  };

  return (
    <div 
      className="media-card group"
      onClick={handleCardClick}
      data-id={video.id}
    >
      {/* Thumbnail Image */}
      <div className="card-image-container relative">
        {video.thumbnailUrl && !imageError ? (
          <>
            <img 
              src={video.thumbnailUrl} 
              alt={video.videoTitle}
              className="poster-image w-full aspect-[16/9] object-cover transition-all duration-300 group-hover:scale-105"
              loading="lazy"
              onError={handleImageError}
            />
            {/* Play Overlay on Hover */}
            <div className="play-overlay absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
              <span className="text-4xl text-white drop-shadow-lg">▶</span>
            </div>
            
            {/* Extracting indicator */}
            {isExtracting && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <div className="flex flex-col items-center gap-2 text-white">
                  <div className="animate-spin rounded-full h-8 w-8 border-4 border-blue-500 border-t-transparent"></div>
                  <span className="text-sm">Extracting stream...</span>
                </div>
              </div>
            )}
            
            {/* Category Badge - Top Left */}
            {video.category && (
              <span className="absolute top-2 left-2 px-2 py-1 text-xs font-semibold rounded bg-black/80 backdrop-blur-sm text-white">
                {video.category}
              </span>
            )}
            
            {/* Status Badge */}
            {video.isHLS && (
              <span className="absolute top-2 right-2 badge hls-badge px-2 py-1 text-xs font-semibold rounded bg-red-600 text-white">
                HLS
              </span>
            )}
            
            {/* Duration Badge - Bottom Right */}
            {video.duration > 0 && (
              <span className="duration-badge absolute bottom-2 right-2 px-2 py-1 text-xs font-mono font-medium rounded bg-black/90 backdrop-blur-sm text-white">
                {formatDuration(video.duration)}
              </span>
            )}

            {/* Resume Badge - Bottom Left */}
            {video.lastPosition > 5 && (
              <span className="resume-badge">
                <span className="resume-icon">▶</span>
                <span>Resume {formatDuration(video.lastPosition)}</span>
              </span>
            )}
          </>
        ) : (
          <div className="poster-placeholder w-full aspect-[16/9] bg-gray-800 flex items-center justify-center">
            <img 
              src={getPlaceholderImage()} 
              alt={video.videoTitle}
              className="w-full h-full object-cover"
            />
          </div>
        )}
      </div>

      {/* Card Content - Appears on Hover */}
      <div className="card-content p-3 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {/* Title & Action Buttons */}
        <div className="title-row flex items-start justify-between gap-2">
          <h3 className="video-title text-white font-medium text-sm line-clamp-2" title={video.videoTitle}>
            {video.videoTitle || 'Untitled Video'}
          </h3>
          <div className="card-actions flex items-center gap-1 flex-shrink-0">
            {/* Add to playlist (portal dropdown, never clipped by the card) */}
            <PlaylistMenu video={video} />
            {/* Favorite/trash */}
            {onDeleteVideo ? (
              <button
                className={`favorite-btn trash-btn ${isDeleting ? 'opacity-50 cursor-wait' : 'text-gray-400 hover:text-red-400'} transition-colors`}
                onClick={handleDelete}
                disabled={isDeleting}
                aria-label="Delete video"
                title="Delete video"
              >
                🗑
              </button>
            ) : null}
            <button 
              className={`favorite-btn flex-shrink-0 ${isFavorite ? 'active text-yellow-400' : 'text-gray-400 hover:text-yellow-400'} transition-colors ${isToggling ? 'opacity-50 cursor-wait' : ''}`}
              onClick={handleFavoriteToggle}
              disabled={isToggling}
              aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={isFavorite}
            >
              {isFavorite ? '★' : '☆'}
            </button>
          </div>
        </div>

        {/* Favorite error hint */}
        {favError && (
          <p className="card-error-text text-[10px] text-red-400 mt-0.5">
            Could not update favorite
          </p>
        )}

        {/* Source/Quality Badge */}
        {(video.sourceSite || video.category) && (
          <p className="card-subtitle text-gray-400 text-xs mt-1 truncate">
            {video.sourceSite || video.category || 'HD'}
          </p>
        )}
      </div>
    </div>
  );
};

export default MediaCard;