# Bundled CLI binaries

This folder is copied into the packaged app as **extra resources**
(`process.resourcesPath`) by `electron-builder`. Both files are optional at
runtime — playback works without them — but downloads/merging are better with
them bundled. In development the app falls back to the copy in `userData` or a
binary on `PATH`.

| File          | Purpose                                              |
| ------------- | ---------------------------------------------------- |
| `yt-dlp.exe`  | Video/stream extraction, search and downloading      |
| `ffmpeg.exe`  | Merging separate video/audio streams on download     |

## How to build offline (Windows)

```powershell
Invoke-WebRequest -Uri https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile resources\yt-dlp.exe
```

ffmpeg is a multi-file archive — download from
<https://www.gyan.dev/ffmpeg/builds/> (the `ffmpeg-release-essentials.zip`
build) and extract **only** the `bin/ffmpeg.exe` here:

```powershell
Invoke-WebRequest -Uri https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip -OutFile $env:TEMP\ffmpeg.zip
Expand-Archive -Path $env:TEMP\ffmpeg.zip -DestinationPath $env:TEMP\ffmpeg -Force
Copy-Item $env:TEMP\ffmpeg\*\bin\ffmpeg.exe .\resources\ffmpeg.exe
```

If the files are missing, `electron-builder` still succeeds (the folder is
empty) but `npm run dist` logs a warning that downloads can't merge streams.