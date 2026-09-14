/**
 * Nekofal - Express Gateway & Proxy Engine.
 *
 * Routes:
 *   GET  /api/health                          health probe
 *   GET  /api/proxy/stream?url=<ENCODED_URL>  stream relay w/ custom headers (Range-aware)
 *   POST /api/scrape/hanime                   server-side Hanime search fallback
 *   POST /api/scrape/video                    server-side video search fallback (yt-dlp substitute)
 *   GET  /api/iptv/parse?url=<M3U_URL>        remote M3U parser -> structured JSON
 */
const express = require("express");
const cors = require("cors");
const http = require("http");
const https = require("https");
const { URL } = (() => { try { return require("url"); } catch { return { URL: require("url").URL }; } })();

const PORT = process.env.PORT || 3000;
const STD_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_REDIRECTS = 4;
const MAX_M3U_BYTES = 20 * 1024 * 1024;
const MAX_SEARCH_BYTES = 6 * 1024 * 1024;

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "http:" || u.protocol === "https:") && /^[^\s\x00]+$/.test(u.toString());
  } catch {
    return false;
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "yakfal-hub-backend", uptime: process.uptime(), ts: Date.now() });
});

/* ------------------------------------------------------------------ */
/* 1. Stream relay with custom User-Agent / Referer                    */
/*    ?url=ENCODED&referer=ENCODED&ua=ENCODED&origin=ENCODED           */
/* ------------------------------------------------------------------ */
app.get("/api/proxy/stream", (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl || !isHttpUrl(streamUrl)) {
    return res.status(400).json({ success: false, error: "Invalid or missing ?url=" });
  }

  const referer = req.query.referer ? String(req.query.referer) : undefined;
  const ua = req.query.ua ? String(req.query.ua) : STD_UA;
  const origin = req.query.origin ? String(req.query.origin) : undefined;

  let redirects = 0;
  let current = streamUrl;

  const resolve = (target, cb, attempt) => {
    let u;
    try { u = new URL(target); } catch {
      return res.status(400).json({ success: false, error: "Malformed stream URL" });
    }
    if (!(u.protocol === "http:" || u.protocol === "https:")) {
      return res.status(400).json({ success: false, error: "Unsupported protocol" });
    }

    const headers = {
      "User-Agent": ua,
      "Accept-Encoding": "identity",
      "Accept": "*/*",
    };
    if (referer) headers.Referer = referer;
    if (origin) headers.Origin = origin;
    if (req.headers.range) headers.Range = req.headers.range;

    const transport = u.protocol === "https:" ? https : http;
    const upstreamReq = transport.get(u, { headers }, (upstream) => {
      const status = upstream.statusCode || 500;

      if (status >= 300 && status < 400 && upstream.headers.location) {
        upstream.resume();
        if (++redirects > MAX_REDIRECTS) {
          return res.status(502).json({ success: false, error: "Too many redirects" });
        }
        return resolve(new URL(upstream.headers.location, current).toString(), cb, attempt + 1);
      }

      if (status >= 400) {
        upstream.resume();
        return cb(new Error(`Upstream ${status}`), upstream);
      }

      const type = upstream.headers["content-type"];
      if (type) res.setHeader("Content-Type", type);
      if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
      if (upstream.headers["accept-ranges"]) res.setHeader("Accept-Ranges", upstream.headers["accept-ranges"]);
      if (upstream.headers["content-range"]) res.setHeader("Content-Range", upstream.headers["content-range"]);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.writeHead(status);
      upstream.pipe(res);
      upstream.on("error", (err) => {
        if (!res.headersSent) res.status(502).json({ success: false, error: err.message });
        else res.destroy();
      });
    });

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) res.status(502).json({ success: false, error: `Upstream: ${err.message}` });
    });
  };

  resolve(current, (err) => {
    if (!res.headersSent) res.status(502).json({ success: false, error: err.message });
  }, 0);
});

/* ------------------------------------------------------------------ */
/* 2. Server-side fallback for Hanime search                            */
/*    POST /api/scrape/hanime  { search_text, tags?, page?, order_by? } */
/* ------------------------------------------------------------------ */
app.post("/api/scrape/hanime", async (req, res) => {
  const { search_text, tags, page, order_by, ordering } = req.body || {};
  if (!search_text || !String(search_text).trim()) {
    return res.json({ success: false, error: "search_text is required" });
  }

  const body = {
    search_text: String(search_text),
    tags: Array.isArray(tags) ? tags : [],
    tags_match: "or",
    keyword: String(search_text),
    page: typeof page === "number" ? page : Number(page) || 0,
    order_by: order_by || "",
    ordering: ordering || "desc",
    c_type_filter: "",
    is_bunny: true,
  };

  try {
    const upstream = await fetch("https://search.htv-services.com/", {
      method: "POST",
      redirect: "follow",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": STD_UA,
        "Origin": "https://hanime.tv",
        "Referer": "https://hanime.tv/",
      },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    res.json({ success: true, status: upstream.status, query: body, total: data.hits_total || 0, data });
  } catch (err) {
    res.json({ success: false, error: `Hanime upstream unreachable: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ */
/* 3. Remote M3U parser -> { success, source, groups[], channels[] }   */
/*    GET /api/iptv/parse?url=<M3U_URL>                                */
/* ------------------------------------------------------------------ */
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  const groups = [];
  let current = null;
  let group = "All";

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const meta = line.slice("#EXTINF".length);
      const comma = meta.indexOf(",");
      const attrsStr = comma >= 0 ? meta.slice(0, comma) : meta;
      const title = comma >= 0 ? meta.slice(comma + 1).trim() : "Untitled";
      const attrs = {};
      for (const m of attrsStr.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
      const grp = attrs["group-title"] || attrs["group_title"] || group;
      if (!groups.includes(grp)) groups.push(grp);
      current = {
        name: title || "Untitled",
        group: grp,
        tvgId: attrs["tvg-id"] || "",
        tvgName: attrs["tvg-name"] || "",
        tvgLogo: attrs["tvg-logo"] || "",
        tvgCountry: attrs["tvg-country"] || "",
        url: "",
      };
      continue;
    }

    if (line.startsWith("#EXTGRP:")) {
      const g = line.slice("#EXTGRP:".length).trim();
      if (g && !groups.includes(g)) groups.push(g);
      group = g || "All";
      continue;
    }

    if (line.startsWith("#")) continue;

    if (current) {
      current.url = line;
      if (!current.group) current.group = group;
      channels.push(current);
      current = null;
    } else {
      channels.push({ name: "Untitled", group, tvgId: "", tvgName: "", tvgLogo: "", tvgCountry: "", url: line });
    }
  }

  return { groups, channels };
}

app.get("/api/iptv/parse", async (req, res) => {
  const m3uUrl = req.query.url;
  if (!m3uUrl || !isHttpUrl(m3uUrl)) {
    return res.status(400).json({ success: false, error: "Invalid or missing ?url=" });
  }
  try {
    const upstream = await fetch(m3uUrl, {
      headers: { "User-Agent": STD_UA, "Accept": "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(60000),
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, error: `Upstream ${upstream.status}` });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_M3U_BYTES) {
      return res.status(413).json({ success: false, error: "M3U too large" });
    }
    const { groups, channels } = parseM3U(buf.toString("utf8"));
    res.json({
      success: true,
      source: m3uUrl,
      groupCount: groups.length,
      channelCount: channels.length,
      groups,
      channels,
    });
  } catch (err) {
    res.status(502).json({ success: false, error: `M3U fetch failed: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ */
/* 4. Server-side video search fallback (yt-dlp substitute)             */
/*    POST /api/scrape/video  { query, mode?, siteUrl?, count? }        */
/*    The desktop app hits this endpoint when its local yt-dlp binary   */
/*    is missing or broken, or when yt-dlp returns no results.          */
/* ------------------------------------------------------------------ */
function extractYouTubeResults(html) {
  const MARK = "var ytInitialData =";
  const start = html.indexOf(MARK);
  if (start === -1) return null;
  const scriptEnd = html.indexOf("</script>", start);
  let jsonText = (scriptEnd === -1 ? html.slice(start) : html.slice(start, scriptEnd))
    .slice(MARK.length)
    .replace(/^\s*;?\s*/, "");
  const end = jsonText.lastIndexOf("}");
  if (end === -1) return null;
  let data;
  try { data = JSON.parse(jsonText.slice(0, end + 1)); } catch { return null; }

  const sections =
    data &&
    data.contents &&
    data.contents.twoColumnSearchResultsRenderer &&
    data.contents.twoColumnSearchResultsRenderer.primaryContents &&
    data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer &&
    data.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents;
  if (!Array.isArray(sections)) return null;

  const videos = [];
  const seen = new Set();
  for (const section of sections) {
    const items = section && section.itemSectionRenderer && section.itemSectionRenderer.contents;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const vr = item && item.videoRenderer;
      if (!vr || !vr.videoId) continue;
      if (seen.has(vr.videoId)) continue;
      seen.add(vr.videoId);
      const titleText = (vr.title && (vr.title.runs ? vr.title.runs.map((r) => r.text || "").join("") : vr.title.simpleText)) || "";
      const thumb = (vr.thumbnail && vr.thumbnail.thumbnails && vr.thumbnail.thumbnails[0] && vr.thumbnail.thumbnails[0].url) || "";
      let duration = 0;
      if (vr.lengthText && vr.lengthText.simpleText) {
        const parts = String(vr.lengthText.simpleText).split(":").map(Number);
        duration = parts.reduce((acc, part) => acc * 60 + (Number(part) || 0), 0);
      }
      videos.push({
        id: `yt-${vr.videoId}`,
        title: String(titleText).substring(0, 200),
        videoUrl: `https://www.youtube.com/watch?v=${vr.videoId}`,
        thumbnailUrl: thumb.replace(/\/default\.(jpg|webp)$/i, "/hqdefault.jpg"),
        duration,
        category: "YouTube",
        sourceSite: "youtube.com",
        extractor: "gateway",
      });
    }
  }
  return videos.length > 0 ? videos : null;
}

function titleFromAnchorHtml(inner) {
  const emphasized = inner.match(/<em[^>]*>([\s\S]*?)<\/em>/i);
  const text = (emphasized ? emphasized[1] : inner)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
  return text || "Untitled";
}

function extractGenericVideos(html, baseUrl, maxItems) {
  const videos = [];
  const seen = new Set();
  let hostname = "";
  try { hostname = new URL(baseUrl).hostname; } catch {}
  const mediaExt = /\.(mp4|webm|m3u8|ogg|ogv|mkv|mov)([?#]|$)/i;

  const add = (videoUrl, title, thumb, duration) => {
    if (!videoUrl || videos.length >= maxItems) return;
    let u;
    try { u = new URL(videoUrl, baseUrl).href; } catch { return; }
    if (seen.has(u)) return;
    seen.add(u);
    videos.push({
      id: "gw-" + Buffer.from(u).toString("hex").slice(0, 16),
      title: String(title || "Untitled").substring(0, 200),
      videoUrl: u,
      thumbnailUrl: String(thumb || ""),
      duration: Math.floor(Number(duration) || 0),
      category: "Video",
      sourceSite: hostname || new URL(u).hostname,
      extractor: "gateway",
    });
  };

  for (const m of html.matchAll(/<video[^>]+?poster="([^"]*)"[^>]*?src="([^"]+)"[^>]*>/gi)) add(m[2], "", m[1], 0);
  for (const m of html.matchAll(/<video[^>]*?\ssrc="([^"]+)"[^>]*>/gi)) add(m[1], "", "", 0);
  for (const m of html.matchAll(/<meta[^>]+property=["']og:video(?::url|:secure_url|:type)?["'][^>]+content=["']([^"']+)["']/gi)) add(m[1], "", "", 0);
  for (const m of html.matchAll(/<iframe[^>]+src="([^"]+)"[^>]*>/gi)) add(m[1], "", "", 0);

  // Anchors pointing straight at media or obvious player pages. Extension
  // checks run against the path (before any ?/query) so URLs that merely
  // mention ".mp4"/".webm" inside query params are not misclassified.
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*?>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const title = titleFromAnchorHtml(m[2]);
    const pathPart = href.split(/[?#]/)[0];
    const low = href.toLowerCase();
    const lowPath = pathPart.toLowerCase();
    if (mediaExt.test(lowPath) || low.includes("watch?v=") || low.includes("/video/")) {
      add(low, title, "", 0);
    }
  }
  return videos;
}

app.post("/api/scrape/video", async (req, res) => {
  const { query, mode, siteUrl, count } = req.body || {};
  const q = String(query || "").trim();
  const want = Math.min(Math.max(Number(count) || 25, 1), 60);
  if (!q) return res.json({ success: false, error: "query is required" });

  let target = q;
  if (mode === "site" && siteUrl && String(siteUrl).includes("{query}")) {
    target = String(siteUrl).replace(/\{query\}/g, encodeURIComponent(q));
  } else if (!/^https?:\/\//i.test(target)) {
    target = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
  }
  if (!isHttpUrl(target)) return res.json({ success: false, error: "Bad target URL" });

  let html;
  try {
    const upstream = await fetch(target, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: { "User-Agent": STD_UA, "Accept-Language": "en-US,en;q=0.9" },
    });
    if (!upstream.ok) return res.status(502).json({ success: false, error: `Upstream ${upstream.status}` });
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_SEARCH_BYTES) return res.status(413).json({ success: false, error: "Page too large" });
    html = buf.toString("utf8");
  } catch (err) {
    return res.json({ success: false, error: `Fetch failed: ${err.message}` });
  }

  let videos = [];
  let source = "gateway:html";
  if (/youtube\.com|youtu\.be/i.test(target)) {
    const yt = extractYouTubeResults(html);
    if (yt) { videos = yt; source = "gateway:youtube"; }
  }
  if (videos.length === 0) {
    videos = extractGenericVideos(html, target, want);
    source = "gateway:html";
  }

  if (videos.length === 0) {
    return res.json({ success: false, error: "No videos found on the target page", target });
  }
  res.json({ success: true, source, target, count: videos.slice(0, want).length, videos: videos.slice(0, want) });
});

app.use((_req, res) => res.status(404).json({ success: false, error: "Not found" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[nekofal] gateway listening on 0.0.0.0:${PORT}`);
});