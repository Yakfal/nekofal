const fs = require('fs');

const content = fs.readFileSync('electron/main.js', 'utf8');

// Fix yt-dlp integration - yt-dlp-wrap doesn't have downloadYtDlp method
// Use yt-dlp-wrap correctly
const fixedContent = content.replace(
  `// Initialize yt-dlp wrapper
const ytDlp = new ytDlpWrap();

async function ensureYtDlpBinary() {
  try {
    await ytDlp.getVersion();
  } catch (err) {
    console.log('yt-dlp binary not found, downloading...');
    await ytDlp.downloadYtDlp();
  }
}`,
`// Initialize yt-dlp wrapper
const ytDlpWrap = require('yt-dlp-wrap').default;
const ytDlp = new ytDlpWrap();

async function ensureYtDlpBinary() {
  try {
    await ytDlp.getVersion();
    console.log('yt-dlp is available');
  } catch (err) {
    console.log('yt-dlp binary not found, attempting to install via npm...');
    try {
      // yt-dlp-wrap auto-installs on first use, but we can also manually install
      const { execSync } = require('child_process');
      execSync('npx yt-dlp --version', { stdio: 'ignore' });
      console.log('yt-dlp is now available');
    } catch (err) {
      console.warn('Could not verify yt-dlp installation:', err.message);
    }
  }
}`
);

fs.writeFileSync('electron/main.js', fixedContent);
console.log('Fixed yt-dlp integration');