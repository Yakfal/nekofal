# 💚 Nekofal

**Emerald Green / Deep Black.**
A self-hosted desktop media hub with a dark, neon-emerald UI — universal scraping,
4K-capable smart playback, and a stealth anti-bot layer, packed into a single
Windows application.

[![Electron](https://img.shields.io/badge/Electron-28+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-sql.js-044A64?logo=sqlite&logoColor=white)](https://sql.js.org/)
[![PocketBase](https://img.shields.io/badge/PocketBase-sync-B833FF)](https://pocketbase.io/)
[![License](https://img.shields.io/badge/License-MIT-brightgreen)](./LICENSE)

---

## About

Nekofal unifies **live IPTV**, **YouTube**, and **web video catalogs** into one
searchable media hub. It scrapes thousands of channels and videos, plays them
through a smart playback engine that routes around CORS, geo-blocks,
anti-hotlinking and bot detection — and lets you download any of them natively
from the app.

Everything is themed around an **Emerald Green accent on a Deep Black canvas**:
a clean cyber look across the Home, Discover, Cinema, IPTV, Radio, Library and
Settings screens.

## ✨ Key Features

- **Universal Scraping** — `yt-dlp` powers extraction and YouTube search while
  custom Cheerio backends (`backends/`) keep specific catalogs available even
  when they resist automation. Normalized results are upserted into the local
  store.
- **4K Playback** — HLS.js segmented-stream playback, on-the-fly resolution
  switching via yt-dlp format re-extraction, direct CDN playback when safe, and
  quality that scales up to 4K where the source provides it.
- **Stealth Anti-Bot Layer** — a local Node/Express stream proxy forwards
  cookies, `Referer` and `Range` headers, rotates request identity and rewrites
  HLS playlist URIs so segmented streams survive redirects and anti-bot rules.
- **Local SQLite + PocketBase sync** — offline-first library (sql.js WASM, a
  single `media.db`), with optional cloud sync/backup to a self-hosted
  PocketBase backend: favorites, scrapers and IPTV sources stay in sync across
  devices.
- **IPTV folder hierarchy** — nested channel folders tuned for 5,000+ live
  channels with playlist-driven HLS playback and graceful fallbacks.
- **Native download manager** — yt-dlp with live progress, ETA and speed,
  merging video/audio with bundled ffmpeg.
- **Hotkey controls** — space (play/pause), ←/→ (seek), ↑/↓ (volume), F (fullscreen), M (mute), S (speed).
- **Add-ons** — custom scraper templates, Family Mode with passcode, and a
  secure vault for API keys (OS-encrypted).
- **Auto-updates** — signed-free GitHub Releases feed pulled automatically,
  with an in-app "Restart & install" prompt.

## 🧰 Tech Stack

| Layer          | Technology |
| -------------- | ---------- |
| Desktop shell  | [Electron](https://www.electronjs.org/) 28 (main + preload, contextIsolation) |
| UI             | [React](https://react.dev/) 19 — Vite + Tailwind CSS |
| Database       | [SQLite](https://sql.js.org/) via **sql.js** (WASM), a single `media.db` file |
| Cloud sync     | [PocketBase](https://pocketbase.io/) backend (`backend/`), optional |
| Stream proxy   | Node.js + [Express](https://expressjs.com/) local server (dynamic port) |
| Extraction     | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (+ bundled ffmpeg) |
| HLS playback   | [hls.js](https://github.com/video-dev/hls.js) |
| Updates        | [electron-updater](https://www.electron.build/auto-update) — GitHub Releases |

## 📥 Installation

### Packaged (recommended)

1. Download the latest installer from the
   [releases page](https://github.com/Yakfal/nekofal/releases):
   - `Nekofal-Setup-*.exe` — NSIS installer (custom install directory allowed)
   - `Nekofal-*.exe` — portable single-file build
2. Run the installer. No admin rights required for the portable build.
3. Optionally sign in to your PocketBase cloud to sync your library.

Updates are delivered automatically: when a new version is released, Nekofal
downloads it in the background and prompts you to **Restart & install**.

### Development

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Provide CLI binaries for local dev/downloads
#    Place yt-dlp.exe (and optionally ffmpeg.exe) in ./resources, or let the
#    app auto-download yt-dlp into the user-data folder on first launch.

# 3. Start the dev environment (Vite dev server + Electron with HMR)
npm run dev
```

> **Dev vs packaged paths**
> - In development the app loads `http://localhost:3000` (Vite).
> - When running `electron .` without `NODE_ENV=development`, or from a package,
>   it loads the production renderer from `build/index.html`.
> - `yt-dlp`/`ffmpeg` resolve to `process.resourcesPath\*.exe` when packaged and
>   to a `userData`/PATH binary in development.
> - The stream proxy listens on port **5001** (5001–5010 tried in order);
>   if all are busy it falls back to an OS-chosen free port and tells the
>   renderer the real base URL.

## 📦 Building a Release

### Locally (Windows)

```powershell
# build + package (no GitHub upload)
npm run dist:local

# build + package + publish to GitHub Releases (feed for auto-updates)
npm run dist:publish
```

Output goes to `dist/`:

- `dist/Nekofal-Setup-1.0.0.exe` — NSIS installer (custom install dir allowed)
- `dist/Nekofal 1.0.0.exe` — portable single-file build
- `dist/latest.yml` — the auto-update feed manifest

`dist:publish` loads `GH_TOKEN` from the gitignored `.env` file (see
`.env.example`) and uploads assets to a GitHub Release at tag `v${version}`.

### Via GitHub Actions (CI/CD)

The repository ships a workflow (`.github/workflows/release.yml`) that triggers
on version tags:

```bash
git tag v1.0.1
git push origin v1.0.1
```

The workflow checks out the code, installs dependencies, downloads fresh
`yt-dlp.exe`/`ffmpeg.exe` into `resources/`, runs `npm run dist`, and publishes
the generated `.exe` files as a GitHub Release.

## 🗄️ Data & Configuration

| Item                      | Location                                      |
| ------------------------- | --------------------------------------------- |
| SQLite database           | `%APPDATA%\yakfal-hub\media.db`               |
| Secure key vault          | `%APPDATA%\yakfal-hub\secrets.json` (DPAPI-encrypted) |
| Downloads (default)       | whatever folder the user picks in "Save As"   |
| Bundled binaries (packaged)| `<install>\resources\yt-dlp.exe`, `ffmpeg.exe` |
| Playback preferences      | `localStorage` (`pmh-preferences`)            |

## 🧩 How It Works

1. **Scrape** — sources are enumerated by `backends/` scrapers (Cheerio) and
   yt-dlp; results are normalized and upserted into the local SQLite store.
2. **Search / Browse** — the Discover, Adult and IPTV pages query the store and
   live yt-dlp search (`ytsearchN:`).
3. **Play** — the player resolves a watch page to a direct media URL via
   yt-dlp (30 s timeout). URLs needing special headers are proxied through the
   local Express server — which also rewrites HLS playlist URIs so segmented
   streams survive redirects and anti-bot rules. Resolutions switch on the fly.
4. **Sync** — with PocketBase enabled, favorites, scrapers and IPTV sources
   sync automatically (or on demand) to your cloud instance.
5. **Download** — yt-dlp runs natively with a Save dialog; progress is streamed
   back to the UI.

## ⚠️ Legal Disclaimer

*Nekofal is a local media player and scraping client. It does not host, stream,
store, or index copyrighted media files. Users are solely responsible for
providing their own media streams and ensuring compliance with local laws and
content provider Terms of Service.*

## 📄 License

Released under the [MIT License](./LICENSE). Copyright © 2026 Yakfal.