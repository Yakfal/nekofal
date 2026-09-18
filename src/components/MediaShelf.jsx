import React, { useRef } from 'react';
import MediaCard from './MediaCard.jsx';
import './MediaShelf.css';

// Horizontal, snap-scrolling shelf used by the Home feed. Renders nothing when
// empty (unless a loading flag is set) so a shelf with no data never leaves a
// blank gap on the page.
const MediaShelf = ({
  title,
  subtitle,
  items = [],
  loading = false,
  onSelectVideo,
  onToggleFavorite,
  emptyHint = ''
}) => {
  const trackRef = useRef(null);

  const scrollByDir = (dir) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.85, 320), behavior: 'smooth' });
  };

  if (!loading && (!items || items.length === 0)) {
    if (!emptyHint) return null;
    return (
      <section className="shelf">
        <div className="shelf-head">
          <h2 className="shelf-title">{title}</h2>
        </div>
        <p className="shelf-empty">{emptyHint}</p>
      </section>
    );
  }

  return (
    <section className="shelf">
      <div className="shelf-head">
        <div className="shelf-head-text">
          <h2 className="shelf-title">{title}</h2>
          {subtitle && <p className="shelf-sub">{subtitle}</p>}
        </div>
        <div className="shelf-nav">
          <button type="button" onClick={() => scrollByDir(-1)} aria-label={`Scroll ${title} left`}>‹</button>
          <button type="button" onClick={() => scrollByDir(1)} aria-label={`Scroll ${title} right`}>›</button>
        </div>
      </div>
      <div className="shelf-track" ref={trackRef}>
        {loading
          ? [...Array(6)].map((_, i) => (
              <div className="shelf-item" key={`sk-${i}`} aria-hidden="true">
                <div className="shelf-skeleton-card">
                  <div className="shelf-skeleton-thumb skeleton" />
                  <div className="shelf-skeleton-line skeleton" />
                  <div className="shelf-skeleton-line skeleton short" />
                </div>
              </div>
            ))
          : items.map((v) => (
              <div className="shelf-item" key={v.id || v.pageUrl || v.videoUrl}>
                <MediaCard
                  video={v}
                  onSelectVideo={onSelectVideo}
                  onToggleFavorite={onToggleFavorite}
                  initialIsFavorite={false}
                />
              </div>
            ))}
      </div>
    </section>
  );
};

export default MediaShelf;
