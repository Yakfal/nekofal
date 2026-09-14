// Node Web IDL polyfill - prevents "File is not defined" crashes in undici/Axios
if (typeof global.File === 'undefined') {
  const { Blob } = require('buffer');
  global.File = class File extends Blob {
    constructor(buffers, name, options = {}) {
      super(buffers, options);
      this.name = name;
      this.lastModified = options.lastModified || Date.now();
    }
  };
}

const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');

/**
 * Create axios instance with realistic browser headers to bypass anti-bot checks
 */
function createScraperAxios(baseUrl) {
  return axios.create({
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: (status) => status < 500,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'Referer': baseUrl,
      'Connection': 'keep-alive'
    }
  });
}

/**
 * Main Scraper - Fetches video feeds from configured sources
 */
async function executeScrapeFunction(params) {
  const { url, timeout = 30000, maxPages = 5 } = params;
  
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL provided');
  }

  try {
    new URL(url);
  } catch (err) {
    throw new Error(`Invalid URL format: ${err.message}`);
  }

  const allVideos = [];
  let page = 1;

  // Create axios instance with proper headers
  const scraperAxios = createScraperAxios(url);

  while (page <= maxPages) {
    try {
      const pageUrl = buildPageUrl(url, page);
      
      const response = await scraperAxios.get(pageUrl, {
        timeout: parseInt(timeout),
      });

      if (response.status >= 400) {
        console.warn(`HTTP ${response.status} for ${pageUrl} - skipping`);
        // Don't break on 403/404, just skip this page and continue
        if (response.status === 403 || response.status === 404) {
          page++;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        break;
      }

      const $ = cheerio.load(response.data);

      // Extract videos using multiple parsing strategies (now includes universal catalog)
      const extractedVideos = await extractVideos($, pageUrl, url);

      const videosArray = Array.isArray(extractedVideos) ? extractedVideos : [];

      // Remove duplicates based on URL
      const uniqueVideos = videosArray.filter(v => {
        return !allVideos.some(existingV => existingV.videoUrl && existingV.videoUrl === v.videoUrl);
      });

      uniqueVideos.forEach(video => {
        if (video.title && (video.thumbnail || video.videoUrl)) {
          video.id = generateVideoId(url, video.title, page);
          video.sourceSite = video.sourceSite || getDomain(url);
          video.isScraped = true;
          video.scrapedAt = new Date().toISOString();
          allVideos.push(video);
        }
      });

      console.log(`[Scraper] Page ${page}: Found ${uniqueVideos.length} new videos (total: ${allVideos.length})`);

      if (uniqueVideos.length === 0 && page > 1) {
        break;
      }

      page++;
      
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      // Check if it's an axios error with response
      if (error.response) {
        const status = error.response.status;
        console.warn(`[Scraper] HTTP ${status} for page ${page} - ${error.message}`);
        
        // Gracefully handle 403/404 - skip this page but continue
        if (status === 403 || status === 404) {
          page++;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      } else {
        console.error(`[Scraper] Error on page ${page}:`, error.message);
      }
      
      if (page >= maxPages) {
        return allVideos.length > 0 
          ? { success: true, inserted: 0, videos: allVideos }
          : { success: false, error: 'Failed to scrape. URL may be inaccessible or changed.', inserted: 0, videos: [] };
      }
    }
  }

  return { success: true, inserted: 0, videos: allVideos };
}

/**
 * Build paginated URL
 */
function buildPageUrl(baseUrl, page) {
  if (page === 1) return baseUrl;
  
  try {
    const url = new URL(baseUrl);
    if (url.searchParams.has('page')) {
      url.searchParams.set('page', page.toString());
    } else if (url.searchParams.has('p')) {
      url.searchParams.set('p', page.toString());
    } else {
      url.searchParams.set('page', page.toString());
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
}

/**
 * Universal Catalog Scraper - auto-detects video grids, cards, articles, and channel listings
 */
async function extractVideos($, pageUrl, baseUrl) {
  const videos = [];
  const pageDomain = getDomain(pageUrl);

  // ===== STRATEGY 1: Universal Catalog Grid Detection =====
  // Detects: <article>, .card, .video-item, .channel-item, .show-card, .movie-card, .episode-card, .program-item
  const catalogSelectors = [
    'article[class*="card"]',
    'article[class*="item"]',
    'article[class*="video"]',
    'article[class*="show"]',
    'article[class*="movie"]',
    'article[class*="episode"]',
    'article[class*="program"]',
    'article[class*="channel"]',
    '.card[class*="video"]',
    '.card[class*="show"]',
    '.card[class*="movie"]',
    '.card[class*="episode"]',
    '.card[class*="channel"]',
    '.video-card',
    '.show-card',
    '.movie-card',
    '.episode-card',
    '.channel-card',
    '.program-card',
    '.content-card',
    '.media-card',
    '.video-item',
    '.show-item',
    '.movie-item',
    '.episode-item',
    '.channel-item',
    '.program-item',
    '.content-item',
    '.media-item',
    '.grid-item',
    '.catalog-item',
    '.playlist-item',
    '[data-video-id]',
    '[data-show-id]',
    '[data-movie-id]',
    '[data-episode-id]',
    '[data-channel-id]',
    'li[class*="video"]',
    'li[class*="show"]',
    'li[class*="movie"]',
    'li[class*="channel"]',
    'div[class*="video"][class*="item"]',
    'div[class*="show"][class*="item"]',
  ];

  for (const selector of catalogSelectors) {
    const elements = $(selector);
    if (elements.length > 0) {
      elements.each((_, el) => {
        const video = parseCatalogElement($, el, pageUrl, pageDomain);
        if (video && video.title && (video.thumbnail || video.videoUrl)) {
          videos.push(video);
        }
      });
      if (videos.length > 0) {
        console.log(`[UniversalCatalog] Strategy 1 (${selector}): Found ${videos.length} items`);
        break;
      }
    }
  }

  // ===== STRATEGY 2: Anchor + Image Pattern (links containing images) =====
  if (videos.length === 0) {
    $('a[href]').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
      
      // Must contain an image
      const img = $el.find('img').first();
      if (!img.length) return;

      const title = extractTitleFromAnchor($el, img);
      const thumbnail = extractThumbnail(img, $el);
      const videoUrl = resolveUrl(href, pageUrl);
      
      if (title && (thumbnail || videoUrl)) {
        const category = extractCategoryFromContext($el, pageDomain);
        videos.push({
          title: title.substring(0, 150),
          thumbnail,
          videoUrl,
          duration: 0,
          category,
          sourceSite: pageDomain,
          type: detectContentType($el, category, videoUrl)
        });
      }
    });
    if (videos.length > 0) {
      console.log(`[UniversalCatalog] Strategy 2 (anchor+img): Found ${videos.length} items`);
    }
  }

  // ===== STRATEGY 3: Semantic HTML5 Article Elements =====
  if (videos.length === 0) {
    $('article').each((_, el) => {
      const $el = $(el);
      const link = $el.find('a[href]').first();
      const img = $el.find('img').first();
      const href = link.attr('href');
      
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      
      const title = $el.find('h1, h2, h3, h4, .title, .heading, [class*="title"]').first().text().trim()
        || link.attr('title') 
        || img.attr('alt') 
        || img.attr('title')
        || $el.attr('aria-label')
        || '';
      
      const thumbnail = img.attr('src') || img.attr('data-src') || img.attr('data-lazy') || img.attr('data-original');
      const videoUrl = resolveUrl(href, pageUrl);
      
      if (title && title.length > 3 && (thumbnail || videoUrl)) {
        const category = extractCategoryFromContext($el, pageDomain);
        videos.push({
          title: title.substring(0, 150),
          thumbnail: thumbnail ? resolveUrl(thumbnail, pageUrl) : null,
          videoUrl,
          duration: 0,
          category,
          sourceSite: pageDomain,
          type: detectContentType($el, category, videoUrl)
        });
      }
    });
    if (videos.length > 0) {
      console.log(`[UniversalCatalog] Strategy 3 (article): Found ${videos.length} items`);
    }
  }

  // ===== STRATEGY 4: YouTube embeds =====
  if (videos.length === 0) {
    const ytbPattern = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/g;
    const pageText = $('html').text();
    const matches = [...pageText.matchAll(ytbPattern)];
    
    matches.slice(0, 20).forEach(match => {
      const videoId = match[1];
      videos.push({
        title: 'YouTube Video',
        thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        duration: 0,
        category: 'YouTube',
        sourceSite: 'YouTube',
        type: 'Scraped Show'
      });
    });
    if (videos.length > 0) {
      console.log(`[UniversalCatalog] Strategy 4 (YouTube): Found ${videos.length} items`);
    }
  }

  // ===== STRATEGY 5: Open Graph / Schema.org meta tags =====
  if (videos.length === 0) {
    const ogTitle = $('meta[property="og:title"]').attr('content');
    const ogImage = $('meta[property="og:image"]').attr('content');
    const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content');
    const ogUrl = $('meta[property="og:url"]').attr('content');
    
    if (ogTitle && (ogVideo || ogUrl)) {
      videos.push({
        title: ogTitle.substring(0, 150),
        thumbnail: ogImage ? resolveUrl(ogImage, pageUrl) : null,
        videoUrl: ogVideo ? resolveUrl(ogVideo, pageUrl) : resolveUrl(ogUrl || pageUrl, pageUrl),
        duration: 0,
        category: 'Video',
        sourceSite: pageDomain,
        type: 'Scraped Show'
      });
    }
  }

  // ===== STRATEGY 6: JSON-LD structured data =====
  if (videos.length === 0) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const items = Array.isArray(data) ? data : [data];
        
        for (const item of items) {
          if (item['@type'] === 'VideoObject' || item['@type'] === 'Movie' || item['@type'] === 'TVSeries' || item['@type'] === 'TVEpisode') {
            const type = item['@type'] === 'TVSeries' ? 'Web TV' : 
                         item['@type'] === 'TVEpisode' ? 'Web TV' : 'Scraped Show';
            videos.push({
              title: item.name || item.headline || 'Video',
              thumbnail: item.thumbnailUrl || item.image ? resolveUrl(Array.isArray(item.image) ? item.image[0] : item.image, pageUrl) : null,
              videoUrl: item.contentUrl || item.embedUrl || item.url ? resolveUrl(item.contentUrl || item.embedUrl || item.url, pageUrl) : pageUrl,
              duration: parseDurationFromISO(item.duration) || 0,
              category: item.genre || 'Video',
              sourceSite: pageDomain,
              type
            });
          }
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    });
    if (videos.length > 0) {
      console.log(`[UniversalCatalog] Strategy 6 (JSON-LD): Found ${videos.length} items`);
    }
  }

  // ===== STRATEGY 7: Generic fallback =====
  if (videos.length === 0) {
    $('[class*="video"], [id*="video"], [data-video], [src*=".mp4"], [src*=".m3u8"], [src*=".webm"]').each((_, el) => {
      const $el = $(el);
      let title = $el.attr('title') || $el.attr('alt') || $el.attr('aria-label') || $el.text().trim().substring(0, 100);
      let thumbnail = $el.attr('src') || $el.attr('data-src') || $el.attr('poster') || $el.attr('data-poster');
      let videoUrl = $el.attr('href') || $el.attr('data-video') || $el.attr('src') || $el.attr('data-src');
      
      if (title && (thumbnail || videoUrl)) {
        videos.push({
          title: title.substring(0, 150),
          thumbnail: thumbnail ? resolveUrl(thumbnail, pageUrl) : null,
          videoUrl: videoUrl ? resolveUrl(videoUrl, pageUrl) : pageUrl,
          duration: 0,
          category: 'Video',
          sourceSite: pageDomain,
          type: 'Scraped Show'
        });
      }
    });
    if (videos.length > 0) {
      console.log(`[UniversalCatalog] Strategy 7 (fallback): Found ${videos.length} items`);
    }
  }

  // Deduplicate by videoUrl
  const seen = new Set();
  const uniqueVideos = videos.filter(v => {
    const key = v.videoUrl || v.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 200); // Increased limit

  // Bulk insert into database
  if (uniqueVideos.length > 0) {
    try {
      const db = require('../db/database.js');
      const insertResult = await db.bulkInsertVideos(uniqueVideos);
      console.log(`[UniversalCatalog] Bulk inserted ${insertResult.inserted || 0} videos into database`);
    } catch (err) {
      console.error('[UniversalCatalog] Failed to bulk insert videos:', err.message);
    }
  }

  return uniqueVideos;
}

/**
 * Parse a catalog element (card, article, grid item)
 */
function parseCatalogElement($, el, pageUrl, pageDomain) {
  const $el = $(el);
  
  // Title extraction - multiple strategies
  let title = '';
  const titleSelectors = [
    'h1, h2, h3, h4, h5, h6',
    '.title, .heading, .name, .label',
    '[class*="title"]',
    '[class*="name"]',
    '[class*="label"]',
    'figcaption',
    '.caption',
    '.description',
    '[aria-label]',
    'img[alt]'
  ];
  
  for (const sel of titleSelectors) {
    const found = $el.find(sel).first().text().trim();
    if (found && found.length > 2) {
      title = found;
      break;
    }
  }
  
  if (!title) title = $el.attr('title') || $el.attr('aria-label') || $el.attr('data-title') || '';
  
  // Thumbnail extraction
  let thumbnail = '';
  const img = $el.find('img').first();
  if (img.length) {
    thumbnail = img.attr('src') 
      || img.attr('data-src')
      || img.attr('data-lazy')
      || img.attr('data-original')
      || img.attr('data-bg')
      || img.attr('data-background')
      || $el.find('[style*="background"]').first().css('background-image')?.replace(/url\(['"]?(.*?)['"]?\)/, '$1')
      || '';
  }
  
  // Video/Page URL extraction
  let videoUrl = '';
  const link = $el.find('a[href]').first();
  if (link.length) {
    videoUrl = link.attr('href');
  } else if ($el.attr('href')) {
    videoUrl = $el.attr('href');
  } else if ($el.attr('data-url')) {
    videoUrl = $el.attr('data-url');
  } else if ($el.attr('data-video')) {
    videoUrl = $el.attr('data-video');
  }
  
  // Category extraction from element context
  const category = extractCategoryFromContext($el, pageDomain);
  
  // Content type detection
  const type = detectContentType($el, category, videoUrl);
  
  // Resolve relative URLs
  if (thumbnail) thumbnail = resolveUrl(thumbnail, pageUrl);
  if (videoUrl) videoUrl = resolveUrl(videoUrl, pageUrl);

  return {
    title: title.substring(0, 150) || 'Untitled',
    thumbnail: thumbnail || null,
    videoUrl: videoUrl || null,
    duration: 0,
    category,
    sourceSite: pageDomain,
    type
  };
}

/**
 * Extract title from anchor context
 */
function extractTitleFromAnchor($el, img) {
  // Try various title sources
  return $el.find('h1, h2, h3, h4, h5, h6, .title, .name, [class*="title"], [class*="name"]').first().text().trim()
    || $el.attr('title')
    || $el.attr('aria-label')
    || $el.attr('data-title')
    || img.attr('alt')
    || img.attr('title')
    || $el.text().trim()
    || '';
}

/**
 * Extract thumbnail from image element
 */
function extractThumbnail(img, $el) {
  return img.attr('src')
    || img.attr('data-src')
    || img.attr('data-lazy')
    || img.attr('data-original')
    || img.attr('data-bg')
    || img.attr('data-background')
    || $el.find('[style*="background"]').first().css('background-image')?.replace(/url\(['"]?(.*?)['"]?\)/, '$1')
    || '';
}

/**
 * Extract category from element context (parent containers, breadcrumbs, etc.)
 */
function extractCategoryFromContext($el, pageDomain) {
  // Check parent containers for category hints
  const contextSelectors = [
    '[class*="category"]',
    '[class*="genre"]',
    '[class*="tag"]',
    '[class*="section"]',
    '[data-category]',
    '[data-genre]',
    '[data-tag]',
    '.breadcrumb',
    '.breadcrumbs',
    'nav[aria-label="breadcrumb"]',
  ];
  
  for (const sel of contextSelectors) {
    const found = $el.closest(sel).find('a, span, li').first().text().trim();
    if (found && found.length > 1 && found.length < 50) {
      return found;
    }
  }
  
  // Check page-level category indicators
  const pageCategories = [
    'Movies', 'TV Shows', 'Live TV', 'Channels', 'Sports', 'News', 
    'Documentaries', 'Kids', 'Anime', 'Drama', 'Comedy', 'Action',
    'Horror', 'Sci-Fi', 'Fantasy', 'Thriller', 'Romance', 'Reality',
    'Music', 'Gaming', 'Tech', 'Education', 'Lifestyle', 'Food',
    'Travel', 'Nature', 'History', 'Science', 'Web TV', 'Free TV'
  ];
  
  const pageText = $('body').text().toLowerCase();
  for (const cat of pageCategories) {
    if (pageText.includes(cat.toLowerCase())) {
      return cat;
    }
  }
  
  return 'Free Web TV';
}

/**
 * Detect content type based on element, category, and URL
 */
function detectContentType($el, category, videoUrl) {
  const text = ($el.text() + ' ' + (videoUrl || '')).toLowerCase();
  const catLower = category.toLowerCase();
  
  // Live TV / Channel indicators
  if (catLower.includes('live') || catLower.includes('channel') || catLower.includes('tv') || 
      text.includes('live') || text.includes('channel') || text.includes('stream') ||
      text.includes('m3u8') || text.includes('hls')) {
    return 'Web TV';
  }
  
  // Show/Series indicators
  if (catLower.includes('show') || catLower.includes('series') || catLower.includes('episode') ||
      text.includes('episode') || text.includes('season') || text.includes('series')) {
    return 'Web TV';
  }
  
  // Movie indicators
  if (catLower.includes('movie') || catLower.includes('film') ||
      text.includes('movie') || text.includes('film')) {
    return 'Scraped Show';
  }
  
  // Default
  return 'Free Web TV';
}

/**
 * Parse duration string to seconds
 */
function parseDuration(text) {
  if (!text) return 0;
  
  const iso = text.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (iso) {
    const h = parseInt(iso[1]) || 0;
    const m = parseInt(iso[2]) || 0;
    const s = parseInt(iso[3]) || 0;
    return h * 3600 + m * 60 + s;
  }
  
  const hms = text.match(/(\d+):(\d+)(?::(\d+))?/);
  if (hms) {
    const h = parseInt(hms[1]) || 0;
    const m = parseInt(hms[2]) || 0;
    const s = parseInt(hms[3]) || 0;
    return h * 3600 + m * 60 + s;
  }
  
  const hm = text.match(/(\d+)h\s*(\d+)m/);
  if (hm) return parseInt(hm[1]) * 3600 + parseInt(hm[2]) * 60;
  
  const min = text.match(/(\d+)\s*min/);
  if (min) return parseInt(min[1]) * 60;
  
  const hours = text.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hours) return Math.round(parseFloat(hours[1]) * 3600);
  
  return 0;
}

function parseDurationFromISO(duration) {
  if (!duration) return 0;
  return parseDuration(duration);
}

/**
 * Resolve relative URLs to absolute
 */
function resolveUrl(url, base) {
  if (!url) return null;
  if (url.startsWith('http')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) {
    try {
      const urlObj = new URL(base);
      return `${urlObj.protocol}//${urlObj.host}${url}`;
    } catch {
      return null;
    }
  }
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'Unknown';
  }
}

function generateVideoId(sourceUrl, title, page) {
  const hash = Buffer.from(`${sourceUrl}-${title}${page}`)
    .toString('hex')
    .substring(0, 12);
  return `vid-${hash}`;
}

function checkHasMorePages($) {
  return $('section').length > (page * 3);
}

module.exports = { executeScrapeFunction };