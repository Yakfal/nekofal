import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'production';
require(path.join(__dirname, '..', 'electron', 'main.js'));

let win = null;
async function callWindow(script, ms) {
  const t = Date.now();
  try {
    const v = await win.webContents.executeJavaScript(script);
    console.log(`CALL ok (${Date.now() - t}ms): ${String(v).slice(0, 120)}`);
    return v;
  } catch (e) {
    console.log(`CALL REJECT (${Date.now() - t}ms): ${String((e && e.message) || e).slice(0, 200)}`);
    throw e;
  }
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false }
  });
  win.webContents.on('console-message', (ev, l, m) => {
    const level = typeof ev === 'object' ? ev.level : l;
    const msg = typeof ev === 'object' ? String(ev.message || '') : String(m || '');
    console.log(`PG l${level}: ${msg.slice(0, 220)}`);
  });
  await win.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
  await new Promise((r) => setTimeout(r, 3000));
  try { await callWindow(`typeof window.electronAPI?.extractStream`, 10000); } catch (_e) {}
  try { await callWindow(`window.localStorage.setItem('nekofal_onboarded','true'); window.localStorage.setItem('nekofal_app_lang','en'); window.localStorage.setItem('pmh-preferences','{}'); 'seeded-store'`, 10000); } catch (e) { console.log('LsCALL failed: ' + e.message); }
  try { await callWindow(`location.hash = '#/discover'; 'hash-set'`, 10000); } catch (e) { console.log('HashCALL failed: ' + e.message); }
  await new Promise((r) => setTimeout(r, 2500));
  try { await callWindow(`!!document.querySelector('.vss-searchbar') ? 'searchbar-present' : 'no-searchbar'`, 10000); } catch (e) { console.log('qCALL failed: ' + e.message); }

  // XHR vs fetch through the app's own interceptor surface on a real YT master.
  try {
    const res = await win.webContents.executeJavaScript(
      `window.electronAPI.extractStream('https://www.youtube.com/watch?v=dQw4w9WgXcQ').then((r) => (r.data && r.data.videoUrl) || r.streamUrl || null)`, 150000);
    console.log('MASTER URL: ' + String(res).slice(0, 120));
    const probe = await win.webContents.executeJavaScript(`(async () => {
      const url = ${JSON.stringify(res)};
      const out = { url: String(url).slice(0, 110) };
      try {
        const f = await fetch(url, { credentials: 'omit' });
        out.fetchStatus = f.status;
        out.fetchCtype = String(f.headers.get('content-type') || '').slice(0, 40);
      } catch (e) { out.fetchError = String((e && e.message) || e); }
      const doXhr = (label, referer) => new Promise((resolve) => {
        const x = new XMLHttpRequest();
        let settRef = true;
        x.open('GET', url, true);
        try { if (referer) x.setRequestHeader('Referer', referer); } catch (e) { settRef = false; }
        x.onload = () => resolve({ label, settRef, xhrStatus: x.status, ctype: String(x.getResponseHeader('content-type') || '').slice(0, 40) });
        x.onerror = () => resolve({ label, settRef, xhrStatus: 0, err: String(x.statusText || 'network-error') });
        x.onabort = () => resolve({ label, settRef, xhrStatus: 0, err: 'aborted' });
        x.timeout = 20000;
        x.send();
      });
      out.xhrRef = await doXhr('xhr+referer', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      out.xhrPlain = await doXhr('xhr-plain', null);
      return out;
    })()`, 60000);
    console.log('PROBE RESULT: ' + JSON.stringify(probe).slice(0, 900));
  } catch (e) { console.log('PROBE ERROR: ' + String((e && e.message) || e).slice(0, 300)); }
  app.exit(0);
});