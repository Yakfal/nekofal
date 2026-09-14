import React from 'react';
import MediaCard from './MediaCard.jsx';
import { v4 as uuidv4 } from 'uuid';
import { getMediaId } from '../services/dbAdapter.js';
import './MediaGrid.css';

const MediaGrid = ({ 
  videos, 
  isLoading, 
  emptyStateMessage = 'No videos found',
  showSkeleton = true,
  pageSize = 12,
  favorites = null,
  onToggleFavorite = () => {}
}) => {
  const [visibleCount, setVisibleCount] = React.useState(0);
  const [pageErrors, setPageErrors] = React.useState([]);
  // Favorite ids as a Set so each card only does an O(1) membership check
  // (no per-card IPC lookups, no logging in the render loop).
  const [favoriteSet, setFavoriteSet] = React.useState(() => new Set(favorites || []));

  // Load favorites ONCE per grid (not once per card) and merge with the set
  // the parent passed down.
  React.useEffect(() => {
    let alive = true;
    const api = window.api || window.electronAPI;
    if (api && api.getFavorites) {
      api.getFavorites().then((rows) => {
        if (!alive) return;
        const merged = new Set(favorites || []);
        (Array.isArray(rows) ? rows : []).forEach(r => { const k = getMediaId(r); if (k) merged.add(k); });
        setFavoriteSet(merged);
      }).catch(() => {});
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge in a freshly provided parent set (e.g. after a toggle elsewhere)
  React.useEffect(() => {
    if (favorites) {
      setFavoriteSet(prev => {
        const merged = new Set(favorites);
        prev.forEach(id => merged.add(id));
        return merged;
      });
    }
  }, [favorites]);

  // Infinite scroll observer
  React.useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && visibleCount < videos.length - pageSize) {
          setVisibleCount(prev => prev + pageSize);
        }
      });
    }, { threshold: 0.1 });

    const loadMoreElements = document.querySelectorAll('.lazy-load-trigger');
    loadMoreElements.forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, [videos.length, visibleCount, pageSize]);

  // Skeleton Loader Component
  const SkeletonCard = () => (
    <div className="skeleton-card">
      <div className="skeleton-image skeleton" style={{ '--size': '200px' }}></div>
      <div className="skeleton-line skeleton" style={{ '--width': `${Math.random() * 60 + 40}%` }}></div>
      <div className="skeleton-line skeleton small" style={{ '--width': `${Math.random() * 80 + 20}%` }}></div>
    </div>
  );

  if (!videos || videos.length === 0) {
    return (
      <div className="empty-state">
        <svg viewBox="0 0 64 64" fill="none" stroke="#374151" className="empty-icon">
          <rect x="8" y="8" width="48" height="48" rx="8" strokeWidth="2"/>
          <circle cx="28" cy="30" r="8" strokeWidth="2.5"/>
          <path d="M6 39h10l5 7v-7" strokeWidth="2.5" strokeLinecap="round"/>
        </svg>
        <p className="empty-text">{emptyStateMessage}</p>
      </div>
    );
  }

  // Show skeleton while loading first batch
  if (isLoading) {
    return (
      <div className="media-grid media-grid-loading">
        {[...Array(Math.min(pageSize * 2, 12))].map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  return (
    <div className="media-grid">
      {videos.map((video, index) => {
        const showError = pageErrors.includes(index);
        
        if (showError) {
          return (
            <div key={`error-${index}`} className="loading-placeholder" data-id={uuidv4()}>
              <p>Failed to load some videos. Please try again.</p>
            </div>
          );
        }

        const isFavorite = favoriteSet.has(video.id);

        return (
          <MediaCard 
            key={video.externalId || video.id}
            video={video}
            initialIsFavorite={isFavorite}
            onToggleFavorite={onToggleFavorite}
          />
        );
      })}
      
      {/* Lazy Load Triggers */}
      {visibleCount < videos.length && <div className="lazy-load-trigger" />}
      {isLoading && <SkeletonCard />}
    </div>
  );
};

export default MediaGrid;