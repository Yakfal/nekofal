// Verifies a RESOLVED HAnime master playlist is genuinely PLAYABLE, not merely
// resolvable.
//
// scripts/test-all-sources.mjs only asserts that extraction returns a URL, so a
// manifest that 404s on every segment would still "pass" the gate. This test
// closes that gap by walking the whole chain with the headers the app's proxy
// stamps:
//
//   master playlist -> (tiers come from the v11 handshake, so this is usually a
//                      MEDIA playlist with no #EXT-X-STREAM-INF) ->
//   EXT-X-KEY (hanime serves a DYNAMIC AES-128 key endpoint, not a static key)
//   -> a real media segment
//
// Note: segment bodies are AES-128 encrypted, so they will NOT begin with the
// 0x47 MPEG-TS sync byte. Non-zero length over HTTP 200 is the proof that bytes
// came down.
//
// Usage:
//   node tests/e2e/hanime-stream.e2e.mjs <resolved-master-url>
//   HANIME_MASTER=<url> node tests/e2e/hanime-stream.e2e.mjs
//
// Exit: 0 = playable, 1 = not playable (or no URL supplied).

const MASTER = process.argv[2] || process.env.HANIME_MASTER || '';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed += 1; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

if (!MASTER) {
  console.error('usage: node tests/e2e/hanime-stream.e2e.mjs <resolved-master-url>');
  process.exit(1);
}

// Same headers electron/main.js stamps for hanime.tv / *.htv-* hosts.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';
const H = { Referer: 'https://hanime.tv/', Origin: 'https://hanime.tv', 'User-Agent': UA };

const abs = (u, base) => new URL(u, base).toString();

async function get(url) {
  const res = await fetch(url, { headers: H, redirect: 'follow' });
  return { status: res.status, type: res.headers.get('content-type'), buf: Buffer.from(await res.arrayBuffer()) };
}

console.log(`master: ${MASTER.slice(0, 120)}`);

const m = await get(MASTER);
check('master playlist responds 200', m.status === 200, `HTTP ${m.status}`);
check('master is served as an HLS playlist', /mpegurl|m3u8/i.test(m.type || ''), `content-type=${m.type}`);
if (m.status !== 200) { console.log(m.buf.toString('utf8').slice(0, 300)); process.exit(1); }

const masterText = m.buf.toString('utf8');
check('master is a valid #EXTM3U playlist', masterText.startsWith('#EXTM3U'));

const lines = masterText.split(/\r?\n/).map((l) => l.trim());
const variants = [];
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) variants.push({ meta: lines[i], url: abs(uri, MASTER) });
  }
}

// hanime serves ONE MEDIA playlist per tier (the tier list comes from the v11
// handshake `sources`), so a master with no #EXT-X-STREAM-INF is normal.
let playlistUrl = MASTER;
let playlistText = masterText;
if (variants.length) {
  console.log(`  master has ${variants.length} variant(s); using the top one`);
  const vr = await get(variants[0].url);
  check('top variant responds 200', vr.status === 200, `HTTP ${vr.status}`);
  playlistUrl = variants[0].url;
  playlistText = vr.buf.toString('utf8');
} else {
  console.log('  master is a media playlist (tiers come from the v11 handshake)');
}

const plines = playlistText.split(/\r?\n/).map((l) => l.trim());
const segCount = plines.filter((l) => l.startsWith('#EXTINF')).length;
check('playlist declares media segments', segCount > 0, `${segCount} #EXTINF entries`);

const keyLine = plines.find((l) => l.startsWith('#EXT-X-KEY'));
if (keyLine && /METHOD=AES-128/.test(keyLine)) {
  const keyMatch = /URI="([^"]+)"/.exec(keyLine);
  check('AES-128 key URI is declared', !!keyMatch, keyLine.slice(0, 90));
  if (keyMatch) {
    const k = await get(abs(keyMatch[1], playlistUrl));
    check('AES-128 key endpoint responds 200 with 16 bytes', k.status === 200 && k.buf.length === 16, `HTTP ${k.status} ${k.buf.length}b`);
  }
} else {
  console.log('  (no AES-128 key declared)');
}

const seg = plines.find((l) => l && !l.startsWith('#'));
check('playlist contains a segment URI', !!seg, seg ? seg.slice(0, 90) : 'none');

if (seg) {
  const sr = await get(abs(seg, playlistUrl));
  check('media segment responds 200', sr.status === 200, `HTTP ${sr.status}`);
  check('media segment carries real bytes (>1 KB)', sr.buf.length > 1024, `${sr.buf.length} bytes`);
  const encrypted = sr.buf[0] !== 0x47;
  console.log(`  first byte 0x${sr.buf[0].toString(16).padStart(2, '0')} (${encrypted ? 'AES-128 encrypted, as expected' : 'plain MPEG-TS'})`);
}

console.log(`\nHAnime stream playable: ${passed}/${passed + failed} assertions passed`);
console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: PASS');
process.exit(failed ? 1 : 0);
