const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const ytDlpWrap = require('yt-dlp-wrap').default;

// Initialize database with userData path - runs ONLY in main process
let dbModule = null;
let dbInitialized = false;
let dbInitError = null;

async function initializeAppDatabase() {
  try {
    const db = require('../db/database.js');
    db.setUserDataPath(app.getPath('userData'));
    const result = await db.initializeDatabase();
    if (result.success) {
      dbModule = db;
      dbInitialized = true;
      console.log('Database module initialized successfully');
    } else {
      dbInitError = result.error;
      console.error('Database initialization failed:', dbInitError);
    }
  } catch (err) {
    dbInitError = err.message;
    console.error('Failed to load database module:', err);
  }
}

function getDb() {
  if (!dbInitialized) {
    throw new Error('Database not initialized: ' + (dbInitError || 'Unknown error'));
  }
  return dbModule;
}

function getDbSafe() {
  if (!dbInitialized) {
    return { error: 'Database not initialized: ' + (dbInitError || 'Unknown error'), db: null };
  }
  return { db: dbModule };
}

let mainWindow;
let videoServer;
let isReady = false;

// Initialize yt-dlp wrapper
const ytDlp = new ytDlpWrap();

async function ensureYtDlpBinary() {
  try {
    await ytDlp.getVersion();
  } catch (err) {
    console.log('yt-dlp binary not found, downloading...');
    await ytDlp.downloadYtDlp();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    backgroundColor: '#0f141e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    },
    icon: path.join(__dirname, '../public/icon.png'),
    show: false,
    frame: true,
    titleBarStyle: 'default'
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ URL }) => {
    mainWindow.loadURL(URL);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    require('electron').shell.openExternal(url);
  });

  // Load the app with retry logic for dev server
  if (process.env.NODE_ENV === 'development') {
    loadDevServerWithRetry();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadDevServerWithRetry(maxRetries = 60, retryInterval = 500) {
  let retries = 0;
  
  const attemptLoad = () => {
    mainWindow.loadURL('http://localhost:3000').catch(err => {
      retries++;
      if (retries < maxRetries) {
        console.log(`Dev server not ready, retry ${retries}/${maxRetries}...`);
        setTimeout(attemptLoad, retryInterval);
      } else {
        console.error('Dev server failed to start after max retries');
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
      }
    });
  };
  
  // Wait for the 'did-fail-load' event to trigger retry
  const handleLoadError = (event, errorCode, errorDescription) => {
    if (errorCode !== 0 && retries < maxRetries) {
      retries++;
      console.log(`Dev server load failed (${errorCode}: ${errorDescription}), retry ${retries}/${maxRetries}...`);
      setTimeout(attemptLoad, retryInterval);
    } else if (retries >= maxRetries) {
      console.error('Max retries reached, falling back to production build');
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  };
  
  mainWindow.webContents.once('did-fail-load', handleLoadError);
  
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.removeListener('did-fail-load', handleLoadError);
  });

  attemptLoad();

  // Connect to local dev server for backends
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.url.startsWith('http://localhost')) {
      details.requestHeaders['Origin'] = null;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

function setupWebRequestHeaders() {
  // Intercept all outgoing requests to inject headers for 403 bypass
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);
    const hostname = url.hostname;
    
    // Skip localhost and local network
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.local')) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const headers = { ...details.requestHeaders };
    
    // Standard desktop Chrome User-Agent
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    // Accept headers for video content
    headers['Accept'] = '*/*';
    headers['Accept-Language'] = 'en-US,en;q=0.9';
    headers['Accept-Encoding'] = 'gzip, deflate, br';
    headers['Accept-Charset'] = 'utf-8';
    
    // Set Referer based on the stream origin to bypass anti-hotlinking
    if (details.resourceType === 'media' || details.url.includes('.m3u8') || details.url.includes('.mp4') || details.url.includes('.ts') || details.url.includes('.webm')) {
      // Use the origin as referer
      const origin = `${url.protocol}//${url.host}`;
      headers['Referer'] = origin;
      headers['Origin'] = origin;
    }
    
    // Remove headers that might trigger blocking
    delete headers['Cookie'];
    delete headers['Cookie2'];
    
    // Add range header support for video streaming
    if (details.url.includes('Range')) {
      headers['Range'] = details.requestHeaders['Range'];
    }
    
    callback({ requestHeaders: headers });
  });
  
  // Handle redirects to preserve headers
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    
    // Remove restrictive CORS headers from response
    if (responseHeaders['Access-Control-Allow-Origin']) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
    }
    if (responseHeaders['Access-Control-Allow-Credentials']) {
      responseHeaders['Access-Control-Allow-Credentials'] = ['true'];
    }
    if (responseHeaders['Access-Control-Allow-Methods']) {
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, OPTIONS, HEAD'];
    }
    if (responseHeaders['Access-Control-Allow-Headers']) {
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
    }
    
    // Allow all content to be embedded
    delete responseHeaders['X-Frame-Options'];
    delete responseHeaders['Content-Security-Policy'];
    
    callback({ responseHeaders });
  });
}

function startVideoServer() {
  const appPort = parseInt(process.env.API_PORT) || 5001;
  
  videoServer = express();
  videoServer.use('/video', cors());
  
  videoServer.get('/video/:id/stream', (req, res) => {
    const headers = req.headers;
    
    res.setHeader('Access-Control-Allow-Origin', '*', true);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS', true);
    res.setHeader('Accept-Ranges', 'bytes', true);
    res.setHeader('Cache-Control', 'public, max-age=604800', true);
    
    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    const videoUrl = req.query.src || req.headers['x-video-url'];
    
    if (!videoUrl) {
      return res.status(400).json({ error: 'No video URL provided' });
    }

    const urlObj = new URL(videoUrl);
    let isHLS = /\.m3u8/.test(urlObj.pathname);

    const http = require('http');
    const requestOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': `${urlObj.protocol}//${urlObj.host}`,
        'Origin': `${urlObj.protocol}//${urlObj.host}`,
        'Range': headers.range || undefined,
        'Connection': 'keep-alive'
      }
    };

    const proxyReq = http.get(requestOptions, (httpRes) => {
      // Forward response headers
      Object.keys(httpRes.headers).forEach(key => {
        if (key !== 'content-encoding' && key !== 'transfer-encoding') {
          res.setHeader(key, httpRes.headers[key]);
        }
      });
      
      // Add CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Accept-Ranges', 'bytes');
      
      httpRes.pipe(res);
    }).on('error', (err) => {
      res.status(502).json({ error: 'Video stream error: ' + err.message });
    });
  });

  videoServer.get('*', (req, res) => {
    if (isReady) {
      res.json({ status: 'ready', message: 'PersonalMediaHub is running' });
    } else {
      res.status(503).json({ error: 'Backend not ready yet' });
    }
  });

  videoServer.listen(appPort, () => {
    console.log(`Video server running on port ${appPort}`);
  });
}

// ============================================
// IPC HANDLERS - Secure Communication
// ============================================

ipcMain.handle('app:initialize', async () => {
  if (isReady) return { success: true };
  
  isReady = true;
  createWindow();
  startVideoServer();
  setupWebRequestHeaders();
  ensureDirectories();
  
  return { success: true, message: 'App initialized' };
});

function ensureDirectories() {
  const fs = require('fs');
  
  try {
    if (!fs.existsSync('./backends')) {
      fs.mkdirSync('./backends', { recursive: true });
    }
    
    if (!fs.existsSync('./config')) {
      fs.mkdirSync('./config', { recursive: true });
    }
  } catch (err) {
    console.error('Failed to create directories:', err);
  }
}

// yt-dlp stream extraction IPC handler
ipcMain.handle('scrapers:extractStream', async (event, { url }) => {
  try {
    await ensureYtDlpBinary();
    
    console.log(`[yt-dlp] Extracting stream info for: ${url}`);
    
    // Get video info without downloading
    const info = await ytDlp.getVideoInfo(url);
    
    // Find the best quality stream
    const formats = info.formats || [];
    const videoFormats = formats
      .filter(f => f.vcodec && f.vcodec !== 'none' && f.url)
      .sort((a, b) => {
        // Prefer higher resolution, then higher bitrate
        const aRes = (a.height || 0) * (a.width || 0);
        const bRes = (b.height || 0) * (b.width || 0);
        if (bRes !== aRes) return bRes - aRes;
        return (b.tbr || 0) - (a.tbr || 0);
      });
    
    const bestVideo = videoFormats[0];
    const audioFormats = formats
      .filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none' && f.url)
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));
    
    const bestAudio = audioFormats[0];
    
    // Determine stream URL
    let streamUrl = null;
    let isHLS = false;
    
    if (bestVideo) {
      streamUrl = bestVideo.url;
      isHLS = bestVideo.url.includes('.m3u8') || bestVideo.protocol === 'm3u8_native';
    } else if (info.url) {
      streamUrl = info.url;
      isHLS = info.url.includes('.m3u8');
    }
    
    if (!streamUrl) {
      return { success: false, error: 'No playable stream found' };
    }
    
    const result = {
      success: true,
      data: {
        id: info.id || `video-${Date.now()}`,
        title: info.title || 'Unknown Title',
        videoUrl: streamUrl,
        thumbnailUrl: info.thumbnail || info.thumbnails?.[0]?.url || '',
        duration: info.duration || 0,
        category: info.categories?.[0] || 'Video',
        sourceSite: info.extractor || getDomain(info.webpage_url || info.url),
        isHLS: isHLS,
        formats: {
          video: bestVideo ? {
            url: bestVideo.url,
            format: bestVideo.format,
            resolution: bestVideo.resolution,
            width: bestVideo.width,
            height: bestVideo.height,
            vcodec: bestVideo.vcodec,
            tbr: bestVideo.tbr
          } : null,
          audio: bestAudio ? {
            url: bestAudio.url,
            format: bestAudio.format,
            acodec: bestAudio.acodec,
            abr: bestAudio.abr
          } : null
        }
      }
    };
    
    console.log(`[yt-dlp] Successfully extracted stream for: ${info.title}`);
    return result;
    
  } catch (err) {
    console.error('[yt-dlp] Extraction error:', err);
    return { 
      success: false, 
      error: 'Stream extraction failed', 
      details: err.message 
    };
  }
});

// Helper to extract domain
function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return 'Unknown';
  }
}

// Save to local database (favorites/watch history)
ipcMain.handle('db:setFavorite', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    if (!videoData.id || !videoData.title) {
      return { success: false, error: 'Missing required fields' };
    }

    await db.setFavorite(videoData);
    
    return { success: true, message: 'Added to favorites' };
  } catch (err) {
    console.error('Add favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to add to favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getFavorites', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const favorites = await db.getFavorites();
    
    return { success: true, data: favorites };
  } catch (err) {
    console.error('Get favorites error:', err);
    return { 
      success: false, 
      error: 'Failed to get favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getVideos', async (event, limit = 100, offset = 0) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const videos = await db.getVideos(limit, offset);
    
    return { success: true, data: videos };
  } catch (err) {
    console.error('Get videos error:', err);
    return { 
      success: false, 
      error: 'Failed to get videos',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getVideosCount', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const count = await db.getVideosCount();
    
    return { success: true, count };
  } catch (err) {
    console.error('Get videos count error:', err);
    return { 
      success: false, 
      error: 'Failed to get videos count',
      details: err.message 
    };
  }
});

ipcMain.handle('db:removeFavorite', async (event, videoId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.removeFavorite(videoId);
    
    return { success: true, message: 'Removed from favorites' };
  } catch (err) {
    console.error('Remove favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to remove from favorites',
      details: err.message 
    };
  }
});

ipcMain.handle('db:setHistory', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.setWatchHistory(videoData);
    
    return { success: true, message: 'Added to watch history' };
  } catch (err) {
    console.error('Add history error:', err);
    return { 
      success: false, 
      error: 'Failed to add to history',
      details: err.message 
    };
  }
});

ipcMain.handle('db:getHistory', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const history = await db.getWatchHistory();
    
    return { success: true, data: history };
  } catch (err) {
    console.error('Get history error:', err);
    return { 
      success: false, 
      error: 'Failed to get watch history',
      details: err.message 
    };
  }
});

ipcMain.handle('db:clearAll', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    await db.clearAll();
    
    return { success: true, message: 'Database cleared' };
  } catch (err) {
    console.error('Clear database error:', err);
    return { 
      success: false, 
      error: 'Failed to clear database',
      details: err.message 
    };
  }
});

ipcMain.handle('db:toggleFavorite', async (event, videoData) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const result = await db.toggleFavorite(videoData);
    
    return { success: true, data: result };
  } catch (err) {
    console.error('Toggle favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to toggle favorite',
      details: err.message 
    };
  }
});

ipcMain.handle('db:checkIsFavorite', async (event, videoId) => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const isFav = await db.checkIsFavorite(videoId);
    
    return { success: true, favorited: isFav };
  } catch (err) {
    console.error('Check favorite error:', err);
    return { 
      success: false, 
      error: 'Failed to check favorite',
      details: err.message 
    };
  }
});

  // Scraper: Run configured scrapers and store results in database
ipcMain.handle('scrapers:run', async () => {
  try {
    const { db, error } = getDbSafe();
    if (error) return { success: false, error: 'Database not available: ' + error };
    
    const { executeScrapeFunction } = require('../backends/main.js');
    
    const fs = require('fs');
    const configPath = './config/settings.config.js';
    let settings = { scrapers: [], timeout: 30000, maxPages: 5 };
    
    if (fs.existsSync(configPath)) {
      try {
        settings = require(configPath);
      } catch {}
    }
    
    const scrapers = settings.scrapers || [];
    if (scrapers.length === 0) {
      return { success: false, error: 'No scrapers configured. Add URLs in Settings.' };
    }
    
    let totalInserted = 0;
    const errors = [];
    
    for (const scraper of scrapers) {
      const urls = Array.isArray(scraper.baseUrls) ? scraper.baseUrls : [scraper.baseUrls];
      
      for (const url of urls) {
        try {
          console.log(`Scraping: ${url}`);
          
          const result = await executeScrapeFunction({
            url,
            timeout: settings.timeout || 30000,
            maxPages: settings.maxPages || 5
          });
          
          if (result && Array.isArray(result) && result.length > 0) {
            const videosWithMeta = result.map(v => ({
              ...v,
              sourceSite: scraper.siteName || getDomain(url),
              isScraped: true,
              scrapedAt: new Date().toISOString()
            }));
            
            const insertResult = await db.bulkInsertVideos(videosWithMeta);
            totalInserted += insertResult.inserted || 0;
          }
        } catch (err) {
          console.error(`Scraper error for ${url}:`, err.message);
          errors.push({ url, error: err.message });
        }
      }
    }
    
    const count = await db.getVideosCount();
    
    return { 
      success: true, 
      inserted: totalInserted,
      totalVideos: count,
      errors: errors.length > 0 ? errors : undefined
    };
  } catch (err) {
    console.error('Scrapers run error:', err);
    return { 
      success: false, 
      error: 'Scraper run failed',
      details: err.message 
    };
  }
});

// Get scraping backends list
ipcMain.handle('backends:list', async () => {
  try {
    const fs = require('fs');
    const dir = './backends';
    
    if (!fs.existsSync(dir)) {
      return { success: false, error: 'Backends directory not found' };
    }

    const files = fs.readdirSync(dir);
    const validExtensions = ['.js', '.mjs'];
    const backends = files.filter(f => 
      f.endsWith(validExtensions[0]) || 
      f.endsWith(validExtensions[1])
    ).map(file => file.replace('.js', '').replace('.mjs', ''));

    return { 
      success: true, 
      backends 
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Execute a scraping backend function
ipcMain.handle('backends:execute', async (event, { backendName, url }) => {
  try {
    require('child_process').execSync(`npm run build`, { 
      stdio: 'pipe',
      cwd: path.resolve('.')
    });

    const fs = require('fs');
    const dir = './backends';
    const backendPath = path.join(dir, `${backendName}${url.includes('.js') ? '.js' : '.mjs'}`);
    const configPath = './config/backends.config.js';

    if (!fs.existsSync(backendPath)) {
      return { 
        success: false, 
        error: 'Backend not found',
        details: `Could not find backend: ${backendName}`
      };
    }

    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, "module.exports = {};\n");
    }
    
    const config = require(configPath);
    const { executeScraper } = require(backendPath);

    const result = await executeScraper({ 
      url,
      timeout: config.timeout || 30000,
      maxPages: config.maxPages || 5
    });

    return { 
      success: true, 
      data: result,
      backend: backendName,
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    console.error('Scraper execution error:', err);
    return { 
      success: false, 
      error: 'Scraper execution failed',
      details: err.message
    };
  }
});

// Execute scraping with specific backend
ipcMain.handle('scraper:execute', async () => {
  try {
    const defaultPath = './backends/main.js';
    const fs = require('fs');
    const configPath = './config/scraper.config.js';

    if (!fs.existsSync(defaultPath)) {
      return { 
        success: false, 
        error: 'Default scraper not found',
        details: 'Please add a backend to ./backends/'
      };
    }

    const config = require(configPath);
    
    const { executeScrapeFunction } = require(defaultPath);

    return await executeScrapeFunction({ 
      url: config.defaultScraperUrl || '',
      timeout: 30000,
      maxPages: 5
    });
  } catch (err) {
    console.error('Default scraper error:', err);
    return { 
      success: false, 
      error: 'Failed to execute default scraper',
      details: err.message
    };
  }
});

