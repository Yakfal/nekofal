const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');
const lines = content.split('\n');
// Keep first 794 lines (0-indexed: 0-793)
const firstPart = lines.slice(0, 794).join('\n');

const ending = `
  });

  // Initialize database FIRST, then create window
  app.whenReady().then(async () => {
    await initializeAppDatabase();
    await ensureYtDlpBinary();
    
    createWindow();
    startVideoServer();
    setupWebRequestHeaders();
    ensureDirectories();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
      videoServer?.destroy();
    }
  });

  // Prevent window from opening twice
  app.whenReady().then(() => {
    if (!mainWindow && process.env.NODE_ENV === 'development') {
      createWindow();
    }
  });
`;

fs.writeFileSync('electron/main.js', firstPart + '\n' + ending);
console.log('File updated successfully');