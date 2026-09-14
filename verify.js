const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join('H:\\MyownX', 'electron/main.js'), 'utf8');
const preload = fs.readFileSync(path.join('H:\\MyownX', 'electron/preload.js'), 'utf8');
const db = fs.readFileSync(path.join('H:\\MyownX', 'db/database.js'), 'utf8');

const ipcHandlers = [
  'db:getVideoCategories',
  'db:getVideos',
  'db:getVideosCount',
  'scrapers:extractStream',
  'scrapers:run',
  'iptv:addSource',
  'iptv:getSources',
  'iptv:removeSource',
  'db:setFavorite',
  'db:getFavorites',
  'db:removeFavorite',
  'db:toggleFavorite',
  'db:checkIsFavorite',
  'db:setHistory',
  'db:getHistory',
  'db:clearAll',
  'db:getScrapers',
  'db:saveScrapers',
  'scrapers:ytDlpBulk',
];

console.log('=== IPC Handler Verification ===');
ipcHandlers.forEach(handler => {
  const inMain = main.includes('ipcMain.handle("' + handler + '")');
  const inPreload = preload.includes(handler);
  const status = inMain && inPreload ? 'OK' : (inMain ? 'WARN preload missing' : 'MISSING main');
  console.log(status + ' ' + handler);
});

console.log('');
console.log('=== DB Function Verification ===');
const dbFunctions = [
  'getVideoCategories',
  'bulkInsertVideos',
  'getVideos',
  'getVideosCount',
  'addIptvSource',
  'getIptvSources',
  'removeIptvSource',
  'updateIptvSource',
];
dbFunctions.forEach(fn => {
  const inDb = db.includes(fn);
  const inExports = db.includes(fn + ',') || db.includes(fn + ': ' + fn);
  const status = inDb && inExports ? 'OK' : (inDb ? 'WARN not exported' : 'MISSING');
  console.log(status + ' ' + fn);
});

console.log('');
console.log('=== Type Column in Videos Table ===');
const hasTypeCol = db.includes('type TEXT');
console.log(hasTypeCol ? 'OK type column added' : 'MISSING type column');

console.log('');
console.log('=== Universal Catalog Scraper ===');
const be = fs.readFileSync(path.join('H:\\MyownX', 'backends/main.js'), 'utf8');
console.log(be.includes('parseCatalogElement') ? 'OK parseCatalogElement' : 'MISSING');
console.log(be.includes('extractCategoryFromContext') ? 'OK extractCategoryFromContext' : 'MISSING');
console.log(be.includes('detectContentType') ? 'OK detectContentType' : 'MISSING');
console.log(be.includes('bulkInsertVideos') ? 'OK bulkInsertVideos call' : 'MISSING');

console.log('');
console.log('=== DRM Detection ===');
console.log(main.includes('DRM_PROTECTED') ? 'OK DRM_PROTECTED handling' : 'MISSING');
console.log(main.includes('is_drm') || main.includes('hasDRM') ? 'OK DRM detection logic' : 'MISSING');

console.log('');
console.log('=== WebView Fallback ===');
const vp = fs.readFileSync(path.join('H:\\MyownX', 'src/components/VideoPlayer.jsx'), 'utf8');
console.log(vp.includes('isDRM') ? 'OK isDRM state' : 'MISSING');
console.log(vp.includes('webview') ? 'OK webview element' : 'MISSING');
console.log(vp.includes('drmWebUrl') ? 'OK drmWebUrl state' : 'MISSING');

console.log('');
console.log('=== Dynamic Filter Pills ===');
const ml = fs.readFileSync(path.join('H:\\MyownX', 'src/pages/MediaLibrary.jsx'), 'utf8');
console.log(ml.includes('getVideoCategories') ? 'OK getVideoCategories call' : 'MISSING');
console.log(ml.includes('filterPills') ? 'OK filterPills logic' : 'MISSING');
console.log(ml.includes('categoryFilter') ? 'OK categoryFilter state' : 'MISSING');
console.log(ml.includes('typeFilter') ? 'OK typeFilter state' : 'MISSING');