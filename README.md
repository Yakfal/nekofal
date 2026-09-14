# 🎬 PersonalMediaHub

**A self-hosted desktop media library — IPTV, web and YouTube catalog scraping, and an HLS-smart playback engine — packed into a single Windows application.**

[![Electron](https://img.shields.io/badge/Electron-28+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![SQLite](https://img.shields.io/badge/SQLite-sql.js-044A64?logo=sqlite&logoColor=white)](https://sql.js.org/)
[![License](https://img.shields.io/badge/License-ISC-blue)](./LICENSE)

---

## About

PersonalMediaHub unifies **live IPTV**, **YouTube**, and **web video catalogs**
into one searchable, offline database. It scrapes thousands of channels and
videos, plays them through a smart playback engine that routes around CORS,
geo-blocks and anti-hotlinking — and lets you download any of them natively,
right from the app.

- **Discover** — search YouTube and the web, browse scraped catalogs, save everything to your library.
- **Adult** — dedicated catalog with the same tooling.
- **IPTV** — folder-based channel hierarchy, tuned for 5,000+ live channels.

## ✨ Features

- **IPTV category folder hierarchy** — nested folders, thousands of channels,
  playlist-driven playback (HLS) with graceful fallbacks. 5,000+ channels load and filter smoothly.
- **Web & YouTube catalog scraping** — yt-dlp powers extraction/search; custom
  Cheerio scrapers keep specific sites available even when they resist automation.
- **Smart playback engine** — HLS.js for segmented streams, direct CDN playback
  when a URL is safe, and a local Node/Express **stream proxy** that forwards
  needed headers (cookies, Referer, Range) to defeat CORS/hotlink blocks.
- **Native Windows "Save As" download manager** — yt-dlp with live progress,
  ETA and speed, merging video/audio with bundled ffmpeg.
- **Hotkey controls** — space (play/pause), ←/→ (seek), ↑/↓ (volume), F (fullscreen), M (mute), S (speed).
- **Format quality switching** — yt-dlp format re-extraction lets you swap
  resolutions on the fly.
- **Custom scraper templates** — backend scraper definitions in `backends/`.
- **Local SQLite library** — favorites, watch history, resume positions and
  tags, persisted in the OS user-data folder.

## 🧰 Tech Stack

| Layer        | Technology |
| ------------ | ---------- |
| Desktop shell| [Electron](https://www.electronjs.org/) 28 (main + preload, contextIsolation) |
| UI           | [React](https://react.dev/) 19 — Vite + Tailwind CSS |
| Database     | [SQLite](https://sql.js.org/) via **sql.js** (WASM), a single `media.db` file |
| Stream proxy | Node.js + [Express](https://expressjs.com/) local server (dynamic port) |
| Extraction   | [yt-dlp](https://github.com/yt-dlp/yt-dlp) (+ bundled ffmpeg) |
| HLS playback | [hls.js](https://github.com/video-dev/hls.js) |

## 🚀 Getting Started (Development)

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
> - The stream proxy listens on port **5001** (ports 5001–5010 tried in order);
>   if all are busy it falls back to an OS-chosen free port and tells the
>   renderer the real base URL.

## 📦 Building a Standalone Executable

### Locally (Windows)

```powershell
# Make sure the bundled binaries exist first (optional but recommended)
#   Place yt-dlp.exe and ffmpeg.exe inside .\resources — see resources/README.md
#   for exact download commands.

# Build the renderer + create NSIS installer and portable exe
npm run dist
```

Output:

- `dist/PersonalMediaHub Setup 1.0.0.exe` — NSIS installer (custom install dir allowed)
- `dist/PersonalMediaHub 1.0.0.exe` — portable (single-file) build

The installer/portable bundle includes `yt-dlp.exe` and `ffmpeg.exe` from
`resources/` as extra resources; the SQLite database is never bundled and is
always created in the OS user-data folder (`%APPDATA%\personalmadiahub\media.db`).

### Via GitHub Releases (CI/CD)

The repository ships a GitHub Actions workflow (`.github/workflows/release.yml`)
that triggers on version tags:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The workflow checks out the code, installs dependencies, downloads fresh
`yt-dlp.exe`/`ffmpeg.exe` into `resources/`, runs `npm run dist`, and publishes
the generated `.exe` files as a GitHub Release.

> Ensure `package-lock.json` is committed (`npm ci` requires it) and the repo is
> pushed to GitHub before tagging.

## 🗄️ Data & Configuration

| Item                      | Location                                     |
| ------------------------- | -------------------------------------------- |
| SQLite database           | `%APPDATA%\personalmadiahub\media.db`        |
| Downloads (default)       | whatever folder the user picks in "Save As"  |
| Bundled binaries (packaged)| `<install>\resources\yt-dlp.exe`, `ffmpeg.exe` |
| Playback preferences      | `localStorage` (`pmh-preferences`)           |

## 🧩 How It Works

1. **Scrape** — sources are enumerated by `backends/` scrapers (Cheerio) and
   yt-dlp; results are normalized and upserted into the local SQLite store.
2. **Search / Browse** — the Discover, Adult and IPTV pages query the store and
   live yt-dlp search (`ytsearchN:`).
3. **Play** — the player resolves a watch page to a direct media URL via
   `yt-dlp` (30 s timeout). URLs needing special headers are proxied through the
   local Express server — which also rewrites HLS playlist URIs so segmented
   streams survive redirects. Resolutions are switchable on the fly.
4. **Download** — yt-dlp runs natively with a Save dialog; progress is streamed
   back to the UI.

## 📄 License

ISC — see [LICENSE](./LICENSE).