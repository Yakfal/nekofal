const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');

// ============================================
// SCRAPERS - Modular Backend Functions
// ============================================

/**
 * Execute a scraping function with error handling and retry logic
 */
async function executeScraper(params) {
  const { url, timeout = 30000, maxPages = 5 } = params;
  
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid URL provided');
  }

  // Validate URL format
  try {
    new URL(url);
  } catch (err) {
    throw new Error(`Invalid URL format: ${err.message}`);
  }

  let videos = [];
  let page = 1;

  while (page <= maxPages && !videos.some(v => v.id === 'MAX_PAGES_REACHED')) {
    try {
      // Fetch content with timeout
      const response = await axios.get(url, {
        timeout: parseInt(timeout),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5'
        }
      });

      const $ = cheerio.load(response.data, {
        decodeEntities: false,
        xmlMode: true,
      });

      // Extract video list based on scraper-specific CSS selectors
      const extractedVideos = videosInPage($);

      if (extractedVideos.length === 0) {
        throw new Error(`No videos found on page ${page}`);
      }

      // Check if we've reached the end of available content
      const hasMoreContent = checkHasMorePages($);

      extractedVideos.forEach(video => {
        if (shouldAddVideo(video)) {
          video.id = generateVideoId(
            url, 
            video.title || 'Untitled', 
            page
          );
          videos.push(video);
        }
      });

      // If more pages available, continue scraping
      // Note: Dynamic pagination (like JavaScript menus) would require puppeteer here
      
      if (!hasMoreContent) {
        break;
      }

      page++;
    } catch (error) {
      console.error(`Page ${page} error:`, error.message);
      
      if (page >= maxPages) {
        throw new Error(
          `Failed to scrape pages. Last page error: ${error.message}. ` +
          'Consider adjusting CSS selectors or increasing timeout.'
        );
      }
    }
  }

  return videos.length === 0 
    ? { success: false, error: 'No videos found after maximum pages' }
    : videos;
}

/**
 * Base function for extracting videos from specific sites
 * Override this in your site-specific scrapers
 */
function videosInPage($) {
  // This is a TEMPLATE - override per scraper file!
  const videos = [];
  
  // Example pattern - replace with actual selectors for target sites:
  const videoElements = $('.video-item, .movie-card, [class*="video"]');
  
  videoElements.each((_, el) => {
    videos.push({ id: 'PLACEHOLDER-' + Math.random() });
  });

  return videos;
}

/**
 * Custom scraper for a specific website
 * Create new files in ./backends/ for each site!
 */

// ============================================
// Scraper Factory - Creates modular scrapers
// ============================================

function createScraper(options) {
  return class Scraper {
    constructor() {
      this.siteName = options.name || 'unnamed';
      this.selectors = options.selectors || {};
      this.baseUrl = options.baseUrl || '';
    }

    // Override these as needed for each site:
    get videoTitleSelector() { return this.selectors.title || '$[title]'; }
    get thumbnailSelector() { return this.selectors.thumbnail || '$[img]' };
    get videoUrlSelector() { return this.selectors.videoUrl || '$[src|data-src|href]'; }
  };

}

module.exports = executeScraper;
