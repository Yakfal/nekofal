// Minimal static file server for the browser E2E suite.
//
// Serves the built harness (tests/.harness-dist) plus the media fixtures
// (tests/fixtures) from ONE origin, and implements HTTP Range on media files.
// Range matters: without it Chromium treats the MP4 as a non-seekable resource
// and a duration/currentTime assertion would be testing the server, not the
// player.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const HARNESS_DIR = path.join(REPO, 'tests', '.harness-dist');
const FIXTURES_DIR = path.join(REPO, 'tests', 'fixtures');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function resolveRequestPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  if (clean === '/' || clean === '/index.html') {
    return path.join(HARNESS_DIR, 'index.html');
  }
  if (clean.startsWith('/fixtures/')) {
    const rel = clean.slice('/fixtures/'.length);
    const abs = path.join(FIXTURES_DIR, rel);
    // Contain the fixtures dir: no traversal out of the sandbox.
    if (!abs.startsWith(FIXTURES_DIR)) return null;
    return abs;
  }
  const abs = path.join(HARNESS_DIR, clean);
  if (!abs.startsWith(HARNESS_DIR)) return null;
  return abs;
}

async function serveFile(req, res, filePath) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      } else if (start !== null && end === null) {
        end = stat.size - 1;
      }
      if (start !== null && end !== null && start <= end && start < stat.size) {
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Cache-Control': 'no-store',
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

export function startStaticServer(port = 0) {
  const server = http.createServer((req, res) => {
    const target = resolveRequestPath(req.url || '/');
    if (!target) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    serveFile(req, res, target);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        server,
        port: actual,
        origin: `http://127.0.0.1:${actual}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}