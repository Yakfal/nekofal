import React, { useState, useEffect, useMemo } from 'react';
import { useSearchContext } from '../contexts/SearchContext.jsx';
import { useAppSettings } from '../contexts/AppSettingsContext.jsx';
import isAdultMedia from '../utils/contentSafety.js';
import MediaCard from '../components/MediaCard.jsx';
import { usePlayback } from '../contexts/PlaybackContext.jsx';
import { getMediaId } from '../services/dbAdapter.js';

// Fallback mock data - only used if database is empty
const MOCK_VIDEOS = [
  { id: 'mock-1', videoTitle: 'Sample Premium Video #1', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/41/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-2', videoTitle: 'Sample Premium Video #2', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/42/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-3', videoTitle: 'Sample Premium Video #3', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/43/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-4', videoTitle: 'Sample Premium Video #4', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/44/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-5', videoTitle: 'Sample Premium Video #5', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/45/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-6', videoTitle: 'Sample Premium Video #6', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/46/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-7', videoTitle: 'Sample Premium Video #7', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/47/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-8', videoTitle: 'Sample Premium Video #8', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/48/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-9', videoTitle: 'Sample Premium Video #9', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/49/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-10', videoTitle: 'Sample Premium Video #10', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/50/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-11', videoTitle: 'Sample Premium Video #11', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/51/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' },
  { id: 'mock-12', videoTitle: 'Sample Premium Video #12', category: '4K Ultra HD', thumbnailUrl: 'https://picsum.photos/seed/52/400/225', videoUrl: 'http://localhost:3000/demo/trailer.webm', duration: 52, isHLS: false, sourceSite: 'Demo', type: 'Scraped Show' }
];

const MediaLibrary = () => {
  const { searchQuery } = useSearchContext();
  const { settings } = useAppSettings();
  const familyMode = settings.familyMode;
  const { playVideo } = usePlayback();
  const [videos, setVideos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [categories, setCategories] = useState([]);
  const [types, setTypes] = useState([]);
  const [sourceSites, setSourceSites] = useState([]);
  // IPTV folder state
  const [selectedFolder, setSelectedFolder] = useState(null);
  const [iptvGroups, setIptvGroups] = useState({});
  // Favorite ids as a Set (one IPC call for the whole grid, no per-card logging)
  const [favoriteSet, setFavoriteSet] = useState(() => new Set());

  useEffect(() => {
    loadVideos();
    loadCategories();
    loadFavorites();
    
    const handleScrapersSynced = () => {
      loadVideos();
      loadCategories();
    };
    
    window.addEventListener('scrapers-synced', handleScrapersSynced);
    return () => {
      window.removeEventListener('scrapers-synced', handleScrapersSynced);
    };
  }, []);

  const loadFavorites = async () => {
    try {
      const api = window.api || window.electronAPI;
      if (api?.getFavorites) {
        const res = await api.getFavorites();
        if (res?.success && Array.isArray(res.data)) {
          setFavoriteSet(new Set(res.data.map(r => getMediaId(r)).filter(Boolean)));
        }
      }
    } catch (err) {
      console.error('Failed to load favorites:', err);
    }
  };

  const handleToggleFavorite = (videoId, isFav) => {
    setFavoriteSet(prev => {
      const next = new Set(prev);
      if (isFav === true) next.add(videoId);
      else if (isFav === false) next.delete(videoId);
      return next;
    });
  };

  const handleDeleteVideo = async (videoId) => {
    const api = window.api || window.electronAPI;
    if (api?.deleteMedia) {
      await api.deleteMedia(videoId);
    }
    setVideos(prev => prev.filter(v => v.id !== videoId));
    setFavoriteSet(prev => {
      const next = new Set(prev);
      next.delete(videoId);
      return next;
    });
    window.dispatchEvent(new Event('scrapers-synced'));
  };

  const loadCategories = async () => {
    try {
      const api = window.api || window.electronAPI;
      if (api?.getVideoCategories) {
        const result = await api.getVideoCategories();
        if (result.success) {
          setCategories(result.categories || []);
          setTypes(result.types || []);
          setSourceSites(result.sourceSites || []);
        }
      }
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  };

  const handleVideoSelect = (video) => {
    playVideo(video);
  };

  const loadVideos = async () => {
    try {
      setLoading(true);
      
      const api = window.api || window.electronAPI;
      
      if (!api?.getVideos) {
        console.log('IPC not available, using mock data');
        setVideos(MOCK_VIDEOS);
        setUsingMock(true);
        setLoading(false);
        return;
      }

      const result = await api.getVideos(500, 0);
      
      if (result.success && result.data && result.data.length > 0) {
        // Transform database results to match MediaCard format
        const formatted = result.data.map(item => ({
          id: item.id,
          videoTitle: item.title,
          category: item.category || 'Video',
          thumbnailUrl: item.thumbnailUrl,
          videoUrl: item.videoUrl,
          duration: item.duration || 0,
          isHLS: item.isHLS || false,
          sourceSite: item.sourceSite || 'Scraped',
          type: item.type || 'Scraped Show',
          groupTitle: item.category, // For IPTV grouping
          // Include additional stream info if available
          formats: item.formats,
          httpHeaders: item.httpHeaders,
          lastPosition: item.lastPosition || 0,
          isAdult: item.isAdult || 0
        }));
        setVideos(formatted);
        setUsingMock(false);
      } else {
        // Database empty - use mock data
        setVideos(MOCK_VIDEOS);
        setUsingMock(true);
      }
    } catch (err) {
      console.error('Failed to load videos:', err);
      setVideos(MOCK_VIDEOS);
      setUsingMock(true);
    } finally {
      setLoading(false);
    }
  };

  // Build IPTV groups from videos (memoized)
  const iptvGroupsMemo = useMemo(() => {
    const groups = {};
    videos
      .filter(v => familyMode ? !isAdultMedia(v) : true)
      .filter(v => v.sourceSite === 'IPTV' || v.type === 'Web TV')
      .forEach(v => {
        const group = v.groupTitle || v.category || 'Uncategorized';
        if (!groups[group]) {
          groups[group] = [];
        }
        groups[group].push(v);
      });
    return groups;
  }, [videos, familyMode]);

  // Update iptvGroups state when memo changes
  useEffect(() => {
    setIptvGroups(iptvGroupsMemo);
  }, [iptvGroupsMemo]);

  // Filter videos based on search query, source, category, type filters, and family mode
  const filteredVideos = useMemo(() => {
    return videos.filter((video) => {
      // Family mode hides adult-tagged content
      if (familyMode && isAdultMedia(video)) return false;

      // Source filter
      if (sourceFilter === 'iptv' && video.sourceSite !== 'IPTV') return false;
      if (sourceFilter === 'scraped' && video.sourceSite === 'IPTV') return false;
      
      // Category filter
      if (categoryFilter !== 'all' && video.category !== categoryFilter) return false;
      
      // Type filter
      if (typeFilter !== 'all' && video.type !== typeFilter) return false;
      
      // Search query
      if (!searchQuery || searchQuery.trim() === '') return true;
      const query = searchQuery.toLowerCase().trim();
      return (
        video.videoTitle.toLowerCase().includes(query) ||
        video.category.toLowerCase().includes(query) ||
        (video.sourceSite && video.sourceSite.toLowerCase().includes(query)) ||
        (video.type && video.type.toLowerCase().includes(query)) ||
        (video.groupTitle && video.groupTitle.toLowerCase().includes(query))
      );
    });
  }, [videos, sourceFilter, categoryFilter, typeFilter, searchQuery, familyMode]);

  // Get videos for current IPTV folder view
  const getDisplayVideos = () => {
    // If IPTV folder selected, show only that group's channels
    if (selectedFolder && iptvGroups[selectedFolder]) {
      return iptvGroups[selectedFolder].filter(v => {
        if (!searchQuery || searchQuery.trim() === '') return true;
        const query = searchQuery.toLowerCase().trim();
        return (
          v.videoTitle.toLowerCase().includes(query) ||
          v.groupTitle.toLowerCase().includes(query)
        );
      });
    }
    // Otherwise show filtered videos (with all filters applied)
    return filteredVideos;
  };

  const displayVideos = getDisplayVideos();

  // Build dynamic filter pills
  const buildFilterPills = () => {
    const pills = [{ key: 'all', label: `All (${videos.length})` }];
    
    // Source type pills
    const iptvCount = videos.filter(v => v.sourceSite === 'IPTV').length;
    const scrapedCount = videos.filter(v => v.sourceSite !== 'IPTV').length;
    
    if (iptvCount > 0) {
      pills.push({ key: 'iptv', label: `IPTV (${iptvCount})`, group: 'source' });
    }
    if (scrapedCount > 0) {
      pills.push({ key: 'scraped', label: `Web TV & Shows (${scrapedCount})`, group: 'source' });
    }
    
    // Type pills (Web TV, Scraped Show, etc.)
    const typeCounts = {};
    types.forEach(t => {
      const count = videos.filter(v => v.type === t).length;
      if (count > 0) typeCounts[t] = count;
    });
    Object.entries(typeCounts).forEach(([type, count]) => {
      pills.push({ key: `type:${type}`, label: `${type} (${count})`, group: 'type' });
    });
    
    // Category pills (top 8 most common)
    const categoryCounts = {};
    categories.forEach(c => {
      const count = videos.filter(v => v.category === c).length;
      if (count > 0) categoryCounts[c] = count;
    });
    Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .forEach(([cat, count]) => {
        pills.push({ key: `cat:${cat}`, label: `${cat} (${count})`, group: 'category' });
      });
    
    return pills;
  };

  const filterPills = buildFilterPills();

  const handleFilterClick = (pill) => {
    if (pill.group === 'source') {
      setSourceFilter(pill.key);
      setCategoryFilter('all');
      setTypeFilter('all');
      setSelectedFolder(null); // Reset folder when changing source
    } else if (pill.group === 'type') {
      setTypeFilter(pill.key.replace('type:', ''));
      setSourceFilter('all');
      setCategoryFilter('all');
      setSelectedFolder(null);
    } else if (pill.group === 'category') {
      setCategoryFilter(pill.key.replace('cat:', ''));
      setSourceFilter('all');
      setTypeFilter('all');
      setSelectedFolder(null);
    } else {
      setSourceFilter('all');
      setCategoryFilter('all');
      setTypeFilter('all');
      setSelectedFolder(null);
    }
  };

  const handleFolderClick = (folderName) => {
    setSelectedFolder(folderName);
  };

  const handleBackToFolders = () => {
    setSelectedFolder(null);
  };

  return (
    <div className="media-library-page pb-20">
      <div className="library-header flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold text-white">Media Library</h1>
        <div className="flex items-center gap-2">
          {usingMock && (
            <span className="text-xs px-2 py-1 bg-yellow-600/20 text-yellow-400 rounded">
              Using Demo Data
            </span>
          )}
          {!usingMock && videos.length > 0 && (
            <span className="text-xs px-2 py-1 bg-gray-700 text-gray-300 rounded">
              {videos.length} total
            </span>
          )}
        </div>
      </div>

      {/* Dynamic Filter Pills */}
      {!loading && videos.length > 0 && (
        <div className="filter-pills-container mb-6">
          <div className="flex flex-wrap gap-2">
            {filterPills.map((pill) => {
              const isActive = 
                (pill.group === 'source' && sourceFilter === pill.key) ||
                (pill.group === 'type' && typeFilter === pill.key.replace('type:', '')) ||
                (pill.group === 'category' && categoryFilter === pill.key.replace('cat:', '')) ||
                (pill.key === 'all' && sourceFilter === 'all' && typeFilter === 'all' && categoryFilter === 'all');
              
              return (
                <button
                  key={pill.key}
                  onClick={() => handleFilterClick(pill)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-blue-600 text-white shadow-lg'
                      : 'bg-gray-700/50 text-gray-400 hover:bg-gray-700 hover:text-white'
                  }`}
                  title={`Filter by ${pill.label}`}
                >
                  {pill.label}
                </button>
              );
            })}
          </div>
          {(sourceFilter !== 'all' || typeFilter !== 'all' || categoryFilter !== 'all') && (
            <button
              onClick={() => { setSourceFilter('all'); setTypeFilter('all'); setCategoryFilter('all'); setSelectedFolder(null); }}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-600 text-gray-200 hover:bg-gray-500 transition-colors"
            >
              Clear Filters
            </button>
          )}
        </div>
      )}

      {/* IPTV Folder View - Show folder cards when in IPTV mode and no folder selected */}
      {!loading && sourceFilter === 'iptv' && !selectedFolder && Object.keys(iptvGroups).length > 0 && (
        <div className="iptv-folders-view mb-6">
          <div className="folders-header flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-white">IPTV Channels by Category</h2>
            <span className="text-sm text-gray-400">
              {Object.keys(iptvGroups).length} categories · {videos.filter(v => v.sourceSite === 'IPTV').length} total channels
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {Object.entries(iptvGroups)
              .sort((a, b) => b[1].length - a[1].length)
              .map(([groupName, channels]) => (
                <button
                  key={groupName}
                  onClick={() => handleFolderClick(groupName)}
                  className="folder-card group relative bg-gray-800/50 rounded-xl p-4 border border-gray-700 hover:border-blue-500 hover:bg-gray-800 transition-all duration-200"
                >
                  <div className="folder-icon text-4xl mb-2">📁</div>
                  <h3 className="folder-name font-medium text-white truncate">{groupName}</h3>
                  <p className="folder-count text-sm text-gray-400 mt-1">{channels.length} channels</p>
                  <div className="folder-hover-overlay absolute inset-0 bg-blue-600/20 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center">
                    <span className="text-blue-300 font-medium">Open →</span>
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* IPTV Sub-Grid View - Show channels within selected folder */}
      {!loading && selectedFolder && iptvGroups[selectedFolder] && (
        <div className="iptv-subgrid-view mb-6">
          <div className="subgrid-header flex items-center justify-between mb-4">
            <button
              onClick={handleBackToFolders}
              className="breadcrumb-btn flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
            >
              <span>←</span>
              <span>Back to All Folders</span>
            </button>
            <div className="subgrid-info">
              <h2 className="text-xl font-semibold text-white">{selectedFolder}</h2>
              <p className="text-sm text-gray-400">{iptvGroups[selectedFolder].length} channels</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {displayVideos.map((video) => (
              <MediaCard 
                key={video.id}
                video={video}
                initialIsFavorite={favoriteSet.has(video.id)}
                onToggleFavorite={handleToggleFavorite}
                onSelectVideo={handleVideoSelect}
                onDeleteVideo={handleDeleteVideo}
              />
            ))}
          </div>
          {displayVideos.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-xl">No channels found in this category</p>
            </div>
          )}
        </div>
      )}

      {/* Results count */}
      {searchQuery && (
        <p className="text-gray-400 text-sm mb-4">
          Showing {displayVideos.length} of {videos.length} videos for "{searchQuery}"
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
      ) : (!selectedFolder || sourceFilter !== 'iptv') ? (
        <>
          {/* Regular Video Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {displayVideos.map((video) => (
              <MediaCard 
                key={video.id}
                video={video}
                initialIsFavorite={favoriteSet.has(video.id)}
                onToggleFavorite={handleToggleFavorite}
                onSelectVideo={handleVideoSelect}
                onDeleteVideo={handleDeleteVideo}
              />
            ))}
          </div>

          {/* Empty state */}
          {displayVideos.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-xl">No videos found</p>
              <p className="mt-2">
                {usingMock ? 'Add scraper URLs in Settings to load real content' : 'Try a different search term or filter'}
              </p>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};

export default MediaLibrary;