/**
 * Example Scraper Template
 * 
 * This is a starter template for creating custom scrapers.
 * Copy this file to ./backends/ and rename it (e.g., site-name-scraper.js)
 * then customize the selector methods based on the target website.
 */

const axios = require('axios');
const cheerio = require('cheerio');

async function executeScraper(params) {
  const { url, timeout = 30000 } = params;

  try {
    new URL(url);
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }

  // Custom extraction logic for this specific site
  return await extractSiteSpecificVideos(url, timeout);
}

async function extractSiteSpecificVideos(url, timeout) {
  const videos = [];

  try {
    const response = await axios.get(url, {
      timeout: parseInt(timeout),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': url
      }
    });

    const $ = cheerio.load(response.data);

    // ============================================================
    // CUSTOMIZE THESE SELECTORS FOR YOUR TARGET SITE
    // ============================================================

    // Select all video containers (find elements containing videos)
    const videoCards = $('.your-video-class-selector, .movie-grid-item');
    
    videoCards.each((index, el) => {
      const $card = $(el);
      
      // Extract thumbnail URL
      let thumbnailUrl = '';
      const thumbEl = $card.find('.your-thumbnail-selector img[src], .thumbnail img[src]');
      if (thumbEl.length) {
        thumbnailUrl = trimQuotes(thumbEl.attr('src'));
      }

      // Extract title from the card
      let title = '';
      const titleLabel = $card.find('.your-title-selector, h2, h3.title');
      if (titleLabel.length) {
        title = trimText(titleLabel.text()).substring(0, 100);
      } else {
        // Fallback: use the card's text content
        title = trimText($card.text()).substring(0, 100);
      }

      // Extract video URL (direct stream link)
      let videoUrl = '';
      
      // Check for common patterns
      const videoLink = $card.find('a[href*="mp4"], a[href*="m3u8"], [data-video-url]');
      if (videoLink.length) {
        videoUrl = trimQuotes(videoLink.attr('href') || videoLink.attr('data-video-url'));
      } else {
        // Look for data attributes or JS sources
        const sourceEl = $card.find('[data-src], [src$=".m3u8"], [src*="mp4"]');
        if (sourceEl.length) {
          videoUrl = trimQuotes(sourceEl.attr('src') || sourceEl.attr('data-src'));
        }
      }

      // Only add if we have essential info
      if (url && thumbnailUrl && (!videoUrl || title)) {
        videos.push({
          id: `example-${Date.now()}-${index}`,
          sourceSite: 'example-site',
          externalId: null,
          urlSource: true,
          videoTitle: title || 'Unknown Title',
          videoUrl: videoUrl || '', // Can be empty if not scraped directly
          thumbnailUrl: thumbnailUrl || '',
          tags: [],
          description: '',
          duration: 0,
          quality: null,
          isHLS: !!(videoUrl && (/\.m3u8/.test(videoUrl) || /\.hls/.test(videoUrl))),
          scrapedAt: new Date().toISOString()
        });
      }
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    throw new Error(`Failed to scrape example site: ${error.message}`);
  }

  return videos;
}

/**
 * Helper function - trim quotes from URL strings
 * Handles double & single quotes, spaces before/after brackets
 */
function trimQuotes(str) {
  if (typeof str !== 'string') {
    return '';
  }

  return str
    .trim()
    .replace(/^[\(\[]|[\)\]]$/g, '')      // Remove parentheses/brackets
    .replace(/^['"]|['"]$/g, '');          // Remove quotes
}

/**
 * Helper function - trim whitespace from text
 */
function trimText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.trim();
}

/**
 * ============================================
 * ADAPT THIS FOR OTHER SITES
 * 
 * Common patterns to look for:
 * 
 * Video containers: .video-card, .movie-item, [class*="post"]
 * Thumbnails: .thumbnail img[src], img.poster, picture img[data-src]
 * Titles: h2 a[href], .title-text, [property="og:title"]
 * Direct links: data-video-url, src$=".mp4", href$=".m3u8"
 * 
 * For dynamic/JavaScript-heavy sites, use Puppeteer instead!
 * ===========================================================
 */
