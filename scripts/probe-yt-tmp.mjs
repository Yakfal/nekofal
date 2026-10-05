import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
require(path.join(__dirname, '..', 'electron', 'main.js'));

let win;
const timer = setTimeout(() => { console.log('GLOBAL TIMEOUT'); app.exit(3); }, 300000);

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    }
  });
  await win.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
  const call = (s, ms) => win.webContents.executeJavaScript(s).catch((e) => ({ __err: String(e) }));
  const url = process.env.NEKOFAL_TEST_YT_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const res = await call(`(async () => await window.electronAPI.extractStream(${JSON.stringify(url)}))()`, 240000);
  if (!res || res.success !== true) {
    console.log('EXTRACT FAILED:', JSON.stringify(res).slice(0, 400));
    clearTimeout(timer);
    app.exit(1);
    return;
  }
  const formats = (res.data && res.data.formats) || [];
  const qualityLevels = (res.data && res.data.qualityLevels) || [];
  console.log('--- envelope ---');
  console.log('streamUrl:', (res.data && res.data.videoUrl) || res.streamUrl);
  console.log('isHLS:', res.data && res.data.isHLS);
  console.log('qualityLevels count:', qualityLevels.length, '->', qualityLevels.map((q) => q.label).join(','));
  console.log('formats rows count:', formats.length);
  for (const f of formats) console.log(`  [${f.formatId}] h=${f.height} hasAudio=${f.hasAudio} proto=${f.protocol}`);
  const master = (res.data && res.data.videoUrl) || res.streamUrl;
  if (/m3u8/i.test(master)) {
    const head = await call(`(async () => {
      const r = await fetch(${JSON.stringify(master)});
      const buf = await r.arrayBuffer();
      const t = new TextDecoder('utf-8').decode(buf.slice(0, 262144));
      return { status: r.status, head: t };
    })().catch((e) => ({ err: String(e) }))`, 60000);
    console.log('--- HLS master head (status ' + (head && head.status) + ') ---');
    const txt = String((head && head.head) || (head && head.err ? 'fetch error: ' + head.err : JSON.stringify(head)));
    console.log(txt.slice(0, 3500));
  }
  clearTimeout(timer);
  app.exit(0);
}).catch((e) => { console.log('SETUP ERROR', e); clearTimeout(timer); app.exit(2); });