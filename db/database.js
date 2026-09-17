const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { isAdultMedia } = require('../electron/contentSafety.cjs');

// Get userData directory from Electron app (passed from main process)
let userDataPath = null;

/**
 * Set the userData path (called from main process)
 */
function setUserDataPath(p) {
  userDataPath = p;
}

// Database file path - kept strictly inside Electron's userData directory so it
// persists across installs/updates and works when packaged (read-only asar).
function getDbFilePath() {
  if (!userDataPath) {
    try {
      const { app } = require('electron');
      userDataPath = app ? app.getPath('userData') : null;
    } catch (err) {
      userDataPath = null;
    }
  }
  if (!userDataPath) {
    throw new Error('userData path is not configured; cannot resolve media.db');
  }
  return path.join(userDataPath, 'media.db');
}

// Explicit WASM file path - must be accessible from main process
const WASM_FILE = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

let db = null;
let isInitialized = false;
let initError = null;

/**
 * Initialize the SQLite database (SQL.js with WASM)
 * Runs ONLY in main process
 */
async function initializeDatabase() {
  if (isInitialized && db) return { success: true };
  if (initError) return { success: false, error: initError };

  try {
    const SQL = await initSqlJs({
      locateFile: () => WASM_FILE
    });

    const DB_FILE = getDbFilePath();
    
    // Load existing database or create new one
    let filebuffer;
    try {
      filebuffer = fs.readFileSync(DB_FILE);
    } catch (e) {
      filebuffer = new Uint8Array(0); // Empty database
    }

    db = new SQL.Database(filebuffer);

    // Create tables if they don't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        videoUrl TEXT,
        thumbnailUrl TEXT,
        duration INTEGER DEFAULT 0,
        category TEXT,
        sourceSite TEXT,
        type TEXT DEFAULT 'Scraped Show',
        externalId TEXT,
        description TEXT,
        scrapedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        isScraped INTEGER DEFAULT 1,
        httpHeaders TEXT,
        lastPosition INTEGER DEFAULT 0,
        isAdult INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        title TEXT,
        url TEXT,
        path TEXT,
        sizeBytes INTEGER DEFAULT 0,
        completedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS favorites (
        id TEXT PRIMARY KEY,
        videoTitle TEXT NOT NULL,
        videoUrl TEXT,
        pageUrl TEXT,
        thumbnailUrl TEXT,
        tags TEXT DEFAULT '[]',
        sourceSite TEXT,
        externalId TEXT,
        description TEXT,
        duration INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        isAdult INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS watch_history (
        id TEXT PRIMARY KEY,
        videoTitle TEXT NOT NULL,
        videoUrl TEXT,
        pageUrl TEXT,
        thumbnailUrl TEXT,
        watchedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_videos_sourceSite ON videos(sourceSite);
      CREATE INDEX IF NOT EXISTS idx_videos_scrapedAt ON videos(scrapedAt);
      CREATE INDEX IF NOT EXISTS idx_favorites_externalId ON favorites(externalId);
      CREATE INDEX IF NOT EXISTS idx_history_watchedAt ON watch_history(watchedAt);

      CREATE TABLE IF NOT EXISTS scrapers (
        id TEXT PRIMARY KEY,
        siteName TEXT NOT NULL,
        baseUrls TEXT NOT NULL DEFAULT '[]',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_scrapers_siteName ON scrapers(siteName);

      CREATE TABLE IF NOT EXISTS iptv_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        channelCount INTEGER DEFAULT 0,
        lastRefreshed DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_videos_externalId ON videos(externalId);

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS playlist_items (
        id TEXT PRIMARY KEY,
        playlist_id TEXT NOT NULL,
        video_id TEXT,
        title TEXT NOT NULL,
        videoUrl TEXT,
        thumbnailUrl TEXT,
        duration INTEGER DEFAULT 0,
        sourceSite TEXT,
        category TEXT,
        isAdult INTEGER DEFAULT 0,
        addedAt DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id);
      CREATE INDEX IF NOT EXISTS idx_playlist_items_video ON playlist_items(video_id);
    `);

    // Migration: Add 'type' column if it doesn't exist (for existing databases)
    try {
      db.run(`ALTER TABLE videos ADD COLUMN type TEXT DEFAULT 'Scraped Show';`);
    } catch (migrationErr) {
      // Column already exists, ignore error
      console.log('[DB] Type column migration skipped:', migrationErr.message);
    }

    // Migration: Add 'httpHeaders' column if it doesn't exist
    try {
      db.run(`ALTER TABLE videos ADD COLUMN httpHeaders TEXT;`);
    } catch (migrationErr) {
      console.log('[DB] httpHeaders column migration skipped:', migrationErr.message);
    }

    // Migration: Add 'lastPosition' column if it doesn't exist (for resume playback)
    try {
      db.run(`ALTER TABLE videos ADD COLUMN lastPosition INTEGER DEFAULT 0;`);
    } catch (migrationErr) {
      console.log('[DB] lastPosition column migration skipped:', migrationErr.message);
    }

    // Migration: Add 'isAdult' column if it doesn't exist (family mode tagging)
    try {
      db.run(`ALTER TABLE videos ADD COLUMN isAdult INTEGER DEFAULT 0;`);
    } catch (migrationErr) {
      console.log('[DB] isAdult column migration skipped:', migrationErr.message);
    }

    // Migration: Add 'isAdult' to favorites for family-mode filtering
    try {
      db.run(`ALTER TABLE favorites ADD COLUMN isAdult INTEGER DEFAULT 0;`);
    } catch (migrationErr) {
      console.log('[DB] favorites isAdult migration skipped:', migrationErr.message);
    }

    // Migration: Add 'media_id' to favorites (standardized cloud payload key)
    // so the IPC can upsert/delete with the canonical { media_id, title, url,
    // thumbnail, type, isAdult } shape PocketBase uses.
    try {
      db.run(`ALTER TABLE favorites ADD COLUMN media_id TEXT;`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_favorites_mediaId ON favorites(media_id);`);
    } catch (migrationErr) {
      console.log('[DB] favorites media_id migration skipped:', migrationErr.message);
    }

    // Migration: Add 'pageUrl' to favorites and watch_history. The canonical
    // web page (watch page / search-result page) survives stream rotation so a
    // saved item can re-extract a fresh CDN URL later instead of pinning an
    // ephemeral stream.
    try {
      db.run(`ALTER TABLE favorites ADD COLUMN pageUrl TEXT;`);
    } catch (migrationErr) {
      console.log('[DB] favorites pageUrl migration skipped:', migrationErr.message);
    }
    try {
      db.run(`ALTER TABLE watch_history ADD COLUMN pageUrl TEXT;`);
    } catch (migrationErr) {
      console.log('[DB] watch_history pageUrl migration skipped:', migrationErr.message);
    }

    // Migration: Backfill isAdult for existing rows so Family Mode works on old data
    try {
      const scan = db.prepare(`SELECT id, title, videoUrl, category, sourceSite FROM videos WHERE isAdult = 0`);
      const upd = db.prepare(`UPDATE videos SET isAdult = ? WHERE id = ?`);
      while (scan.step()) {
        const row = scan.getAsObject();
        if (isAdultMedia(row)) {
          upd.run([1, row.id]);
        }
      }
      scan.free();
      upd.free();
    } catch (migrationErr) {
      console.log('[DB] isAdult backfill migration skipped:', migrationErr.message);
    }

    // Migration: Legacy CDN link sanitizer. Old app versions persisted
    // googlevideo CDN stream URLs (or redirected pages) as favorites/history/
    // library rows. Signed CDN links rotate and die, so every stored
    // googlevideo.com URL is rebuilt into its canonical youtube.com/watch?v=
    // page (from the docid/id query parameter) — the item then re-extracts a
    // fresh stream on play instead of throwing a media format error.
    // Favorites/watch_history may hold it in pageUrl or videoUrl; the videos
    // (library) table has only videoUrl, with externalId backfilled when empty.
    try {
      let fixed = 0;
      const sanCdn = (value) => {
        const s = String(value || '');
        if (!/googlevideo\.com/i.test(s)) return null;
        // Strict 11-char video ID only — long CDN hash ids (o-…, base64) are
        // not video IDs and must not be recovered into a bogus watch page.
        const vid = s.match(/[?&]docid=([a-zA-Z0-9_-]{11})(?![\w-])/)
          || s.match(/[?&]id=(?!o-)([a-zA-Z0-9_-]{11})(?![\w-])/);
        return vid ? `https://www.youtube.com/watch?v=${vid[1]}` : null;
      };
      // Strip appended query tokens from canonical watch pages so stored rows
      // keep exactly https://www.youtube.com/watch?v=<11_char_id>.
      const sanWatch = (value) => {
        const s = String(value || '');
        if (!/youtube\.com\/watch\?/i.test(s)) return s;
        const vid = s.match(/[?&]v=([a-zA-Z0-9_-]{11})(?![\w-])/);
        return vid ? `https://www.youtube.com/watch?v=${vid[1]}` : s;
      };
      const fixRow = (row) => {
        const watch = sanCdn(row.pageUrl) || sanCdn(row.videoUrl);
        return watch;
      };
      const favScan = db.prepare(`SELECT rowid, id, pageUrl, videoUrl FROM favorites WHERE pageUrl LIKE '%googlevideo.com%' OR videoUrl LIKE '%googlevideo.com%'`);
      const favUpd = db.prepare(`UPDATE favorites SET pageUrl = COALESCE(?, pageUrl), videoUrl = ? WHERE rowid = ?`);
      while (favScan.step()) {
        const row = favScan.getAsObject();
        const watch = fixRow(row);
        if (!watch) continue;
        const keepPage = /youtube\.com|youtu\.be/i.test(String(row.pageUrl || '')) ? row.pageUrl : watch;
        favUpd.run([keepPage, null, row.rowid]);
        fixed++;
      }
      favScan.free();
      favUpd.free();

      const histScan = db.prepare(`SELECT rowid, id, pageUrl, videoUrl FROM watch_history WHERE pageUrl LIKE '%googlevideo.com%' OR videoUrl LIKE '%googlevideo.com%'`);
      const histUpd = db.prepare(`UPDATE watch_history SET pageUrl = COALESCE(?, pageUrl), videoUrl = ? WHERE rowid = ?`);
      while (histScan.step()) {
        const row = histScan.getAsObject();
        const watch = fixRow(row);
        if (!watch) continue;
        const keepPage = /youtube\.com|youtu\.be/i.test(String(row.pageUrl || '')) ? row.pageUrl : watch;
        histUpd.run([keepPage, null, row.rowid]);
        fixed++;
      }
      histScan.free();
      histUpd.free();

      const libScan = db.prepare(`SELECT id, videoUrl, externalId FROM videos WHERE videoUrl LIKE '%googlevideo.com%'`);
      const libUpd = db.prepare(`UPDATE videos SET videoUrl = ?, externalId = COALESCE(?, externalId) WHERE id = ?`);
      while (libScan.step()) {
        const row = libScan.getAsObject();
        const watch = sanCdn(row.videoUrl);
        if (!watch) continue;
        libUpd.run([watch, row.externalId || row.id.split('|')[0] || null, row.id]);
        fixed++;
      }
      libScan.free();
      libUpd.free();

      // Canonical-page pass (non-CDN rows): strip appended query tokens/params
      // from stored YouTube watch pages. pageUrl is rebuilt to exactly
      // https://www.youtube.com/watch?v=<11_char_id>; videoUrl is left alone —
      // non-CDN rows can hold live stream URLs that must not be nulled.
      const stripQueryTokens = (table) => {
        const scan = db.prepare(`SELECT rowid, pageUrl FROM ${table} WHERE pageUrl LIKE '%youtube.com/watch%' AND pageUrl NOT LIKE '%googlevideo.com%'`);
        const upd = db.prepare(`UPDATE ${table} SET pageUrl = ? WHERE rowid = ?`);
        while (scan.step()) {
          const row = scan.getAsObject();
          const clean = sanWatch(row.pageUrl);
          if (!clean || clean === row.pageUrl) continue;
          upd.run([clean, row.rowid]);
          fixed++;
        }
        scan.free();
        upd.free();
      };
      stripQueryTokens('favorites');
      stripQueryTokens('watch_history');

      if (fixed > 0) {
        saveDatabase();
        console.log(`[DB] Legacy CDN link & YouTube URL sanitizer: ${fixed} row(s) rebuilt into canonical youtube.com/watch?v=<11-char-id> pages`);
      }
    } catch (migrationErr) {
      console.log('[DB] Legacy CDN link sanitizer migration skipped:', migrationErr.message);
    }

    isInitialized = true;
    initError = null;
    console.log('Database initialized successfully at:', DB_FILE);
    return { success: true };
  } catch (err) {
    initError = err.message;
    console.error('Failed to initialize database:', err);
    return { success: false, error: initError };
  }
}

/**
 * Save database to file
 */
function saveDatabase() {
  if (!db) return false;
  try {
    const DB_FILE = getDbFilePath();
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_FILE, buffer);
    return true;
  } catch (err) {
    console.error('Failed to save database:', err);
    return false;
  }
}

/**
 * Get all videos from the scraped videos table
 */
async function getVideos(limit = 100, offset = 0) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      SELECT id, 
             title, 
             videoUrl, 
             thumbnailUrl, 
             duration,
             category,
             sourceSite,
             type,
             externalId,
             description,
             scrapedAt,
             httpHeaders,
             lastPosition,
             isAdult
      FROM videos
      ORDER BY scrapedAt DESC
      LIMIT ? OFFSET ?
    `);

    const results = [];
    stmt.bind([limit, offset]);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  } catch (error) {
    console.error('Failed to get videos:', error);
    throw error;
  }
}

/**
 * Get videos count
 */
async function getVideosCount() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare('SELECT COUNT(*) as count FROM videos');
    const result = stmt.getAsObject();
    stmt.free();
    return result?.count || 0;
  } catch (error) {
    console.error('Failed to get videos count:', error);
    return 0;
  }
}

/**
 * Insert or update a video in the scraped videos table
 */
async function setVideo(videoData) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const sanitized = sanitizeVideoForInsert(videoData);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO videos 
      (id, title, videoUrl, thumbnailUrl, duration, category, sourceSite, type, externalId, description, scrapedAt, isScraped, httpHeaders, lastPosition, isAdult)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run([
      sanitized.id,
      sanitized.title,
      sanitized.videoUrl,
      sanitized.thumbnailUrl,
      sanitized.duration,
      sanitized.category,
      sanitized.sourceSite,
      sanitized.type,
      sanitized.externalId,
      sanitized.description,
      sanitized.scrapedAt,
      sanitized.isScraped,
      sanitized.httpHeaders,
      sanitized.lastPosition,
      sanitized.isAdult
    ]);

    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to set video:', error);
    throw error;
  }
}

/**
 * Sanitize video object for SQLite insertion - replaces undefined with null/defaults
 */
function sanitizeVideoForInsert(video) {
  return {
    id: video.id || `vid-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    title: video.title?.trim() || 'Untitled Video',
    videoUrl: video.videoUrl || video.url || video.link || '',
    thumbnailUrl: video.thumbnailUrl || video.thumbnail || video.poster || '',
    duration: video.duration || null,
    category: video.category || video.groupTitle || 'General',
    sourceSite: video.sourceSite || video.siteName || 'Web Scraper',
    type: video.type || 'Scraped Show',
    externalId: video.externalId || null,
    description: video.description || null,
    scrapedAt: video.scrapedAt || new Date().toISOString(),
    isScraped: video.isScraped ? 1 : 0,
    httpHeaders: video.httpHeaders ? JSON.stringify(video.httpHeaders) : null,
    lastPosition: video.lastPosition || 0,
    isAdult: video.isAdult ? 1 : (isAdultMedia(video) ? 1 : 0)
  };
}

/**
 * Bulk insert videos (for scraping)
 */
async function bulkInsertVideos(videos) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    // Sanitize all videos before insertion
    const sanitizedVideos = videos
      .map(sanitizeVideoForInsert)
      .filter(v => Boolean(v.videoUrl)); // Only insert videos with a URL
    
    if (sanitizedVideos.length === 0) {
      return { success: true, inserted: 0 };
    }
    
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO videos 
      (id, title, videoUrl, thumbnailUrl, duration, category, sourceSite, type, externalId, description, scrapedAt, isScraped, httpHeaders, lastPosition, isAdult)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    let inserted = 0;
    for (const video of sanitizedVideos) {
      stmt.run([
        video.id,
        video.title,
        video.videoUrl,
        video.thumbnailUrl,
        video.duration,
        video.category,
        video.sourceSite,
        video.type,
        video.externalId,
        video.description,
        video.scrapedAt,
        video.isScraped,
        video.httpHeaders,
        video.lastPosition,
        video.isAdult
      ]);
      inserted++;
    }
    
    saveDatabase();
    return { success: true, inserted };
  } catch (error) {
    console.error('Failed to bulk insert videos:', error);
    throw error;
  }
}

/**
 * Clear scraped videos table
 */
async function clearVideos() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    db.exec(`DELETE FROM videos;`);
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to clear videos:', error);
    throw error;
  }
}

/**
 * Add a video to favorites
 */
async function setFavorite(videoData) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO favorites 
      (id, media_id, videoTitle, videoUrl, pageUrl, thumbnailUrl, tags, sourceSite, externalId, createdAt, description, duration, isAdult)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const tagsArray = typeof videoData.tags === 'string' 
      ? JSON.parse(videoData.tags)
      : [];

    const duration = videoData.duration || 0;
    const externalId = videoData.externalId || null;
    const mediaId = String(videoData.media_id || videoData.externalId || videoData.id || '').trim();
    
    stmt.run([
      videoData.id,
      mediaId || null,
      videoData.title,
      videoData.videoUrl,
      videoData.pageUrl || null,
      videoData.thumbnailUrl,
      JSON.stringify(tagsArray),
      videoData.sourceSite,
      externalId,
      new Date().toISOString(),
      videoData.description || '',
      duration,
      isAdultMedia({ title: videoData.title, category: videoData.category, videoUrl: videoData.videoUrl, sourceSite: videoData.sourceSite }) ? 1 : 0
    ]);

    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to add favorite:', error);
    throw error;
  }
}

/**
 * Get all favorites
 */
async function getFavorites() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      SELECT id,
             media_id,
             videoTitle as title, 
             videoUrl, 
             pageUrl,
             thumbnailUrl, 
             json_extract(tags, '$') as tags,
             sourceSite, 
             sourceSite, 
             externalId, 
             description,
             duration,
             isAdult,
             createdAt as favoriteAt
      FROM favorites
      ORDER BY favoriteAt DESC
    `);

    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  } catch (error) {
    console.error('Failed to get favorites:', error);
    throw error;
  }
}

// A favorite is keyed by its own id (PK) or the canonical media_id alias used
// by the cloud payload — covers both paths listed in the IPC: the canonical
// { media_id, title, url, thumbnail, type, isAdult } shape and legacy rows.
// NOTE: sql.js getAsObject() returns a truthy {} on an EMPTY result set, so the
// probe must check a real column value (aliased here as `found`), not truthiness
// of the row object, or every lookup would falsely report a favorite.
function findFavorite(videoId, mediaId) {
  if (videoId) {
    const stmt = db.prepare('SELECT 1 AS found FROM favorites WHERE id = ? LIMIT 1');
    const hit = stmt.getAsObject([videoId]);
    stmt.free();
    if (hit && hit.found) return true;
  }
  if (mediaId) {
    const stmt = db.prepare('SELECT 1 AS found FROM favorites WHERE media_id = ? LIMIT 1');
    const hit = stmt.getAsObject([mediaId]);
    stmt.free();
    if (hit && hit.found) return true;
  }
  return false;
}

/**
 * Check if a video is favorited
 */
async function checkIsFavorite(videoId, mediaId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    return findFavorite(videoId, mediaId);
  } catch (error) {
    console.error('Failed to check favorite:', error);
    return false;
  }
}

/**
 * Remove a favorite by ID
 */
async function removeFavorite(videoId, mediaId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    // DELETE FROM favorites WHERE id = ? OR media_id = ?
    const stmt = db.prepare('DELETE FROM favorites WHERE id = ? OR (media_id IS NOT NULL AND media_id = ?)');
    const result = stmt.run([videoId || null, mediaId || null]);
    stmt.free();
    saveDatabase();
    return result;
  } catch (error) {
    console.error('Failed to remove favorite:', error);
    throw error;
  }
}

/**
 * Toggle favorite (insert or delete)
 * Writes DIRECTLY to local SQLite: INSERT OR REPLACE INTO favorites when the
 * video is not yet saved, DELETE FROM favorites when it already is. No remote
 * I/O on this path — cloud sync happens separately and non-blocking.
 */
async function toggleFavorite(videoData) {
  const mediaId = String(videoData.media_id || '').trim();
  const isFav = findFavorite(videoData.id, mediaId);
  
  if (isFav) {
    await removeFavorite(videoData.id, mediaId);
    return { success: true, favorited: false };
  } else {
    await setFavorite(videoData);
    return { success: true, favorited: true };
  }
}

/**
 * Add to watch history
 */
async function setWatchHistory(videoData) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO watch_history 
      (id, videoTitle, videoUrl, pageUrl, thumbnailUrl, watchedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run([
      videoData.id,
      videoData.title,
      videoData.videoUrl,
      videoData.pageUrl || null,
      videoData.thumbnailUrl,
      new Date().toISOString()
    ]);
    
    saveDatabase();
    return result;
  } catch (error) {
    console.error('Failed to add to history:', error);
    throw error;
  }
}

/**
 * Get watch history
 */
async function getWatchHistory() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      SELECT id, 
             videoTitle as title, 
             videoUrl, 
             pageUrl,
             thumbnailUrl, 
             watchedAt
      FROM watch_history
      ORDER BY watchedAt DESC
    `);

    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();

    return results;
  } catch (error) {
    console.error('Failed to get history:', error);
    throw error;
  }
}

/**
 * Clear the entire database
 */
async function clearAll() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    db.exec(`DELETE FROM favorites; DELETE FROM watch_history; DELETE FROM videos; DELETE FROM playlist_items; DELETE FROM playlists;`);
    saveDatabase();
  } catch (error) {
    console.error('Failed to clear database:', error);
    throw error;
  }
}

/**
 * Get all saved scrapers
 */
async function getScrapers() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    const stmt = db.prepare(`
      SELECT id, siteName, baseUrls, createdAt
      FROM scrapers
      ORDER BY createdAt DESC
    `);

    const results = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      row.baseUrls = JSON.parse(row.baseUrls);
      results.push(row);
    }
    stmt.free();

    return results;
  } catch (error) {
    console.error('Failed to get scrapers:', error);
    throw error;
  }
}

/**
 * Save scrapers to database
 */
async function saveScrapers(scrapers) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    // Clear existing scrapers
    db.exec(`DELETE FROM scrapers;`);
    
    // Insert new scrapers
    const stmt = db.prepare(`
      INSERT INTO scrapers (id, siteName, baseUrls, createdAt)
      VALUES (?, ?, ?, ?)
    `);
    
    for (const scraper of scrapers) {
      stmt.run([
        scraper.id || `scraper-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        scraper.siteName,
        JSON.stringify(scraper.baseUrls),
        scraper.createdAt || new Date().toISOString()
      ]);
    }
    
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to save scrapers:', error);
    throw error;
  }
}

/**
 * IPTV Sources
 */
async function addIptvSource(source) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const stmt = db.prepare(`INSERT INTO iptv_sources (id, name, url, channelCount, lastRefreshed) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, channelCount = excluded.channelCount, lastRefreshed = excluded.lastRefreshed`);
  stmt.run([source.id, source.name, source.url, source.channelCount || 0, new Date().toISOString()]);
  stmt.free();
  saveDatabase();
  return { success: true };
}

async function getIptvSources() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const stmt = db.prepare('SELECT * FROM iptv_sources ORDER BY lastRefreshed DESC');
  const results = [];
  while (stmt.step()) { results.push(stmt.getAsObject()); }
  stmt.free();
  return results;
}

async function getIptvSourceByUrl(url) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const stmt = db.prepare('SELECT * FROM iptv_sources WHERE url = ? LIMIT 1');
  stmt.bind([url]);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}

async function removeIptvSource(sourceId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run('DELETE FROM iptv_sources WHERE id = ?', [sourceId]);
  db.run("DELETE FROM videos WHERE externalId = ? AND sourceSite = 'IPTV'", [sourceId]);
  saveDatabase();
  return { success: true };
}

async function updateIptvSource(sourceId, channelCount) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run('UPDATE iptv_sources SET channelCount = ?, lastRefreshed = ? WHERE id = ?', [channelCount, new Date().toISOString(), sourceId]);
  saveDatabase();
}

/**
 * Get all videos from a given source (e.g. all IPTV channels) with no limit
 */
async function getVideosBySource(sourceSite, limit = 20000) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  try {
    const stmt = db.prepare(`
      SELECT id, title, videoUrl, thumbnailUrl, duration, category, sourceSite, type,
             externalId, description, scrapedAt, httpHeaders, lastPosition, isAdult
      FROM videos
      WHERE sourceSite = ?
      ORDER BY title ASC
      LIMIT ?
    `);
    stmt.bind([sourceSite, limit]);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (error) {
    console.error('Failed to get videos by source:', error);
    throw error;
  }
}

/**
 * Delete all videos belonging to an IPTV source (used when refreshing a playlist)
 */
async function deleteVideosByExternalId(sourceId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run("DELETE FROM videos WHERE externalId = ?", [sourceId]);
  saveDatabase();
  return { success: true };
}

/**
 * Permanently delete a single video plus any references to it (favorites,
 * playlist items). Used by the MediaCard trash button.
 */
async function deleteVideo(videoId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  if (!videoId) return { success: false, error: 'Missing video id' };

  db.run('DELETE FROM videos WHERE id = ?', [videoId]);
  db.run('DELETE FROM favorites WHERE id = ?', [videoId]);
  db.run('DELETE FROM playlist_items WHERE video_id = ?', [videoId]);
  saveDatabase();
  return { success: true };
}

/**
 * Playlists
 */
async function createPlaylist(name, description) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const id = `pl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  db.run(
    'INSERT INTO playlists (id, name, description, createdAt) VALUES (?, ?, ?, ?)',
    [id, String(name || 'New Playlist').trim().substring(0, 120), String(description || '').trim(), new Date().toISOString()]
  );
  saveDatabase();
  return { success: true, playlist: { id, name: String(name || 'New Playlist').trim().substring(0, 120), description: String(description || '').trim(), createdAt: new Date().toISOString() } };
}

async function getPlaylists() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const stmt = db.prepare(`
    SELECT p.id, p.name, p.description, p.createdAt,
           COUNT(pi.id) as itemCount
    FROM playlists p
    LEFT JOIN playlist_items pi ON pi.playlist_id = p.id
    GROUP BY p.id
    ORDER BY p.createdAt DESC
  `);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

async function deletePlaylist(playlistId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run('DELETE FROM playlist_items WHERE playlist_id = ?', [playlistId]);
  db.run('DELETE FROM playlists WHERE id = ?', [playlistId]);
  saveDatabase();
  return { success: true };
}

async function addToPlaylist(playlistId, video) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  if (!playlistId) return { success: false, error: 'Missing playlist id' };

  const title = video.title || video.videoTitle || 'Untitled';
  const videoUrl = video.videoUrl || '';
  if (!videoUrl) return { success: false, error: 'Video has no playback URL' };

  // Don't duplicate the same video in the same playlist
  const dup = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND video_id = ? LIMIT 1');
  dup.bind([playlistId, video.id || null]);
  const already = dup.step();
  dup.free();
  if (already) return { success: true, alreadyAdded: true };

  const id = `pli-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  db.run(
    `INSERT INTO playlist_items (id, playlist_id, video_id, title, videoUrl, thumbnailUrl, duration, sourceSite, category, isAdult, addedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      playlistId,
      video.id || null,
      title,
      videoUrl,
      video.thumbnailUrl || video.thumbnail || '',
      video.duration || 0,
      video.sourceSite || '',
      video.category || '',
      video.isAdult || isAdultMedia(video) ? 1 : 0,
      new Date().toISOString()
    ]
  );
  saveDatabase();
  return { success: true, id };
}

async function removeFromPlaylist(itemId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run('DELETE FROM playlist_items WHERE id = ?', [itemId]);
  saveDatabase();
  return { success: true };
}

async function getPlaylistItems(playlistId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  const stmt = db.prepare(`
    SELECT id, playlist_id, video_id, title as videoTitle, videoUrl, thumbnailUrl, duration, sourceSite, category, isAdult, addedAt
    FROM playlist_items
    WHERE playlist_id = ?
    ORDER BY addedAt DESC
  `);
  stmt.bind([playlistId]);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

/**
 * Remove legacy IPTV rows that used the old colliding id scheme (id NOT LIKE 'iptv-ch-%').
 * Covers the one-time migration from the broken importer so re-adding playlists
 * doesn't leave stale one-channel-per-list leftovers.
 */
async function deleteLegacyIptv() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  db.run("DELETE FROM videos WHERE sourceSite = 'IPTV' AND id NOT LIKE 'iptv-ch-%'");
  db.run("DELETE FROM iptv_sources WHERE id NOT LIKE 'iptv-src-%'");
  saveDatabase();
  return { success: true };
}

/**
 * Get unique categories and types from videos table for dynamic filtering
 */
async function getVideoCategories() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  
  try {
    // Get unique categories
    const catStmt = db.prepare('SELECT DISTINCT category FROM videos WHERE category IS NOT NULL AND category != "" ORDER BY category');
    const categories = [];
    while (catStmt.step()) {
      categories.push(catStmt.getAsObject().category);
    }
    catStmt.free();
    
    // Get unique types
    const typeStmt = db.prepare('SELECT DISTINCT type FROM videos WHERE type IS NOT NULL AND type != "" ORDER BY type');
    const types = [];
    while (typeStmt.step()) {
      types.push(typeStmt.getAsObject().type);
    }
    typeStmt.free();
    
    // Get unique sourceSites
    const sourceStmt = db.prepare('SELECT DISTINCT sourceSite FROM videos WHERE sourceSite IS NOT NULL AND sourceSite != "" ORDER BY sourceSite');
    const sourceSites = [];
    while (sourceStmt.step()) {
      sourceSites.push(sourceStmt.getAsObject().sourceSite);
    }
    sourceStmt.free();
    
    return { categories, types, sourceSites };
  } catch (error) {
    console.error('Failed to get video categories:', error);
    return { categories: [], types: [], sourceSites: [] };
  }
}

/**
 * Save playback position for a video (used for resume support)
 */
async function setVideoPosition(videoId, lastPosition) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  try {
    const pos = Math.max(0, Math.floor(Number(lastPosition) || 0));
    db.run('UPDATE videos SET lastPosition = ? WHERE id = ?', [pos, videoId]);
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to save video position:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Record a completed download
 */
async function addDownload(download) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO downloads (id, title, url, path, sizeBytes, completedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run([
      download.id || `dl-${Date.now()}`,
      download.title || 'Download',
      download.url || '',
      download.path || '',
      download.sizeBytes || 0,
      download.completedAt || new Date().toISOString()
    ]);
    stmt.free();
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to record download:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get completed downloads (most recent first)
 */
async function getDownloads() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  try {
    const stmt = db.prepare('SELECT * FROM downloads ORDER BY completedAt DESC');
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
  } catch (error) {
    console.error('Failed to get downloads:', error);
    return [];
  }
}

/**
 * Remove a completed download record
 */
async function removeDownload(downloadId) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  try {
    db.run('DELETE FROM downloads WHERE id = ?', [downloadId]);
    saveDatabase();
    return { success: true };
  } catch (error) {
    console.error('Failed to remove download:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Export data for backup/restore: playlists (+ items), favorites, IPTV sources.
 */
async function exportData() {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);

  const playlists = await getPlaylists();
  const playlistItems = [];
  for (const p of playlists) {
    const items = await getPlaylistItems(p.id);
    playlistItems.push(...items);
  }

  const favorites = await getFavorites();
  const iptvSources = await getIptvSources();

  return {
    app: 'nekofal',
    version: 1,
    exportedAt: new Date().toISOString(),
    playlists,
    playlistItems,
    favorites,
    iptvSources
  };
}

/**
 * Import a backup payload. Uses INSERT OR IGNORE so existing data wins; the
 * original ids are preserved so playlist references stay intact.
 */
async function importData(data) {
  const init = await initializeDatabase();
  if (!init.success) throw new Error(init.error);
  if (!data || typeof data !== 'object') throw new Error('Invalid backup data');
  if (!['nekofal', 'yakfal-hub'].includes(data.app) || !Array.isArray(data.playlists)) {
    return { success: false, error: 'Not a nekofal backup payload' };
  }

  const now = new Date().toISOString();
  const counts = { playlists: 0, playlistItems: 0, favorites: 0, iptvSources: 0 };

  for (const p of (data.playlists || [])) {
    if (!p || !p.id || !p.name) continue;
    db.run(
      'INSERT OR IGNORE INTO playlists (id, name, description, createdAt) VALUES (?, ?, ?, ?)',
      [p.id, String(p.name).trim().substring(0, 120), p.description || '', p.createdAt || now]
    );
    counts.playlists++;
  }

  for (const it of (data.playlistItems || [])) {
    if (!it || !it.playlist_id || !it.id) continue;
    db.run(
      `INSERT OR IGNORE INTO playlist_items
        (id, playlist_id, video_id, title, videoUrl, thumbnailUrl, duration, sourceSite, category, isAdult, addedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        it.id,
        it.playlist_id,
        it.video_id || '',
        it.videoTitle || it.title || 'Untitled',
        it.videoUrl || '',
        it.thumbnailUrl || '',
        it.duration || 0,
        it.sourceSite || '',
        it.category || '',
        it.isAdult || (isAdultMedia(it) ? 1 : 0),
        it.addedAt || now
      ]
    );
    counts.playlistItems++;
  }

  for (const f of (data.favorites || [])) {
    if (!f || !f.id || (!f.videoUrl && !f.pageUrl)) continue;
    db.run(
      `INSERT OR IGNORE INTO favorites
        (id, videoTitle, videoUrl, pageUrl, thumbnailUrl, tags, sourceSite, externalId, createdAt, description, duration, isAdult)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id,
        f.videoTitle || f.title || 'Untitled',
        f.videoUrl || null,
        f.pageUrl || null,
        f.thumbnailUrl || '',
        JSON.stringify(f.tags || []),
        f.sourceSite || '',
        f.externalId || null,
        f.createdAt || f.favoriteAt || now,
        f.description || '',
        f.duration || 0,
        f.isAdult || (isAdultMedia(f) ? 1 : 0)
      ]
    );
    counts.favorites++;
  }

  for (const s of (data.iptvSources || [])) {
    if (!s || !s.id || !s.url) continue;
    db.run(
      `INSERT OR IGNORE INTO iptv_sources (id, name, url, channelCount, lastRefreshed)
       VALUES (?, ?, ?, ?, ?)`,
      [s.id, s.name || 'IPTV', s.url, s.channelCount || 0, s.lastRefreshed || now]
    );
    counts.iptvSources++;
  }

  saveDatabase();
  return { success: true, counts };
}

/**
 * Export functions for main process
 */
module.exports = {
  setUserDataPath,
  initializeDatabase,
  // Videos table (scraped content)
  getVideos,
  getVideosBySource,
  getVideosCount,
  getVideoCategories,
  setVideo,
  bulkInsertVideos,
  clearVideos,
  deleteVideo,
  // Playlists
  createPlaylist,
  getPlaylists,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  getPlaylistItems,
  // Scrapers
  getScrapers,
  saveScrapers,
  // IPTV
  addIptvSource,
  getIptvSources,
  getIptvSourceByUrl,
  removeIptvSource,
  deleteVideosByExternalId,
  deleteLegacyIptv,
  updateIptvSource,
  // Favorites
  setFavorite,
  getFavorites,
  checkIsFavorite,
  removeFavorite,
  toggleFavorite,
  // History
  setWatchHistory,
  getWatchHistory,
  // Playback position (resume)
  setVideoPosition,
  // Downloads
  addDownload,
  getDownloads,
  removeDownload,
  // Backup / restore
  exportData,
  importData,
  // Admin
  clearAll
};