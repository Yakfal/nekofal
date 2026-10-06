// Integration coverage for the universal catalog scraper in backends/main.js.
//
// This exercises the REAL exported entry point (executeScrapeFunction) against a
// local fixture server, so no external site and no network is involved.
// @vitest-environment node
//
// Why this matters: backends/main.js shipped two live defects.
//
// 1. extractCategoryFromContext() only ever received an ELEMENT selection but
//    tried to run a document-wide `$('body')` lookup, so every call that fell
//    past the per-element context selectors threw ReferenceError. All three call
//    sites hit that path, which meant category extraction blew up mid-scrape.
//
// 2. generateVideoId() hashed `Buffer.from(key).toString('hex').substring(0,12)`,
//    i.e. the hex of only the FIRST 6 BYTES - the leading characters of the page
//    URL. Every video on a site therefore got the same id, so distinct videos
//    collided in favorites/history/dedup.
//
// A bundler cannot see either one, and both only appear on real pages, which is
// exactly what this suite exists to lock down.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { executeScrapeFunction } from '../../backends/main.js';

// An <article> grid is one of the universal strategies the scraper auto-detects.
// Deliberately give the cards NO per-element category hooks, which forces the
// page-level fallback - the branch that used to throw.
const FIXTURE_HTML = `<!doctype html>
<html>
  <head><title>Fixture Catalog</title></head>
  <body>
    <h1>Streaming Documentaries about nature and science</h1>
    <article>
      <a href="/watch/alpha"><img src="/thumb/alpha.jpg" alt="" /></a>
      <h3>Deep Ocean Explorers</h3>
    </article>
    <article>
      <a href="/watch/beta"><img src="/thumb/beta.jpg" alt="" /></a>
      <h3>Wildlife of the North</h3>
    </article>
  </body>
</html>`;

let server;
let origin;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('executeScrapeFunction (backends/main.js)', () => {
  // The real contract is `{ success, inserted, videos }` - electron/main.js
  // consumes it as `scraped?.videos`.
  const scrape = (maxPages = 1) =>
    executeScrapeFunction({ url: `${origin}/`, timeout: 10000, maxPages });

  it('resolves without throwing on a catalog page', async () => {
    // The regression: this threw ReferenceError: $ is not defined.
    let result;
    let threw = null;
    try {
      result = await scrape();
    } catch (e) {
      threw = e;
    }
    expect(threw === null, `scraper threw: ${threw && threw.message}`).toBe(true);
    expect(result).toBeTruthy();
    expect(Array.isArray(result.videos)).toBe(true);
  });

  it('extracts the fixture videos with usable fields', async () => {
    const { videos } = await scrape();
    expect(videos.length).toBeGreaterThanOrEqual(2);

    for (const v of videos) {
      expect(typeof v.title).toBe('string');
      expect(v.title.length).toBeGreaterThan(0);
      // Video URLs must be absolute and resolvable, not bare relative paths.
      expect(String(v.videoUrl || '')).toMatch(/^https?:\/\//);
    }
  });

  it('resolves page-level categories instead of aborting extraction', async () => {
    // Fixture body text mentions "Documentaries"; with the element-context
    // selectors defeated, only the page-level fallback can find it. Before the
    // fix this branch threw and no videos came back at all.
    const { videos } = await scrape();
    const categories = videos.map((v) => String(v.category || ''));
    expect(categories.some((c) => c.toLowerCase().includes('documentar'))).toBe(true);
  });

  it('gives every video on the page a DISTINCT id', () => {
    // The regression: ids were derived from the first 6 bytes of the page URL,
    // so two different cards from one listing page produced the same id and
    // would collide in favorites/history.
    return scrape().then(({ videos }) => {
      expect(videos.length).toBeGreaterThanOrEqual(2);
      const ids = videos.map((v) => v.id);
      expect(new Set(ids).size, `duplicate ids: ${JSON.stringify(ids)}`).toBe(ids.length);
    });
  });

  it('honours maxPages so it cannot loop forever', async () => {
    const t0 = Date.now();
    const { videos } = await scrape(1);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(Array.isArray(videos)).toBe(true);
  });
});
