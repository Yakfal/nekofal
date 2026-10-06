# ADULT CONTENT SCRAPERS — LOCKED / FROZEN

> DO NOT MODIFY ANY ADULT CONTENT RESOLVERS (HAnime, XVideos, XNXX, Pornhub). ALL ADULT SCRAPERS ARE FROZEN AND PASSING.

**Locked in release:** v1.0.88 (commit `0605b6e`)
**Re-verified:** release gate `npx electron scripts/test-all-sources.mjs` → **5/5 sources passed — gate CLEARED**

---

## Why this file exists

The four adult resolvers are the highest-value, most fragile code in the
repository. They are reverse-engineered against live sites that actively change
their payloads, so every one of them encodes hard-won, currently-working detail:

| Resolver | Engine | Fragile detail that must not be disturbed |
|---|---|---|
| **HAnime** | v11 handshake (`POST https://auth.hanime.tv/api/v11/handshake`) | AES-256-GCM envelope (`SHA-256("htv-insecure-handshake-v1")`, AAD `"htv-insecure-v1"`), `window.ssignature` from site/server WASM, `x-signature-version: web2`, `x-csrf-token: null`, `x-time`. Response `sources` must have the `kind:"promotion"` empty-`src` entry filtered out; the remaining relative `/hls/<id>/<token>` tiers are resolved against `https://hanime.tv`. Handshake **must** run in the page context — it returns 401 from Node. HLS is a per-tier **media** playlist (no `#EXT-X-STREAM-INF`), segments are AES-128 encrypted with a dynamic key at `https://ct.htv-services.com/sign.bin`. |
| **XVideos** | inline `html5player` parse | ad-host stripping, `.mp4` tier normalisation |
| **XNXX** | inline `html5player` parse | ad-host stripping, `.mp4` tier normalisation |
| **Pornhub** | inline `mediaDefinitions` parse | ad-host stripping, HLS master→variant→segment chain, header-gated CDN manifests |

## Frozen surface

Do not edit, refactor, "tidy", rename, reformat or re-order any of:

- `src/services/customScraper.js` (adult resolver ladder + helpers)
- any adult-specific service module under `src/services/`
- `electron/main.js` sections that serve these sources (extractor ladder, HAnime
  stealth/persistent-window engine, stream sniffers, the video proxy's
  host allow-list / ad-host filtering)

## How to verify you have not broken the freeze

```powershell
# must print nothing
git diff v1.0.88 -- src/services/ electron/ scripts/test-all-sources.mjs

# must exit 0 with "5/5 sources passed - gate CLEARED"
npx electron scripts/test-all-sources.mjs
```

HAnime must additionally survive **two consecutive** extractions in the same
session (never cleared), because the Cloudflare clearance cookie is the thing
that silently expires.

## Working on YouTube / player controls instead

YouTube is **not** covered by this freeze. The player-side fix surface is
`src/components/VideoPlayer.jsx`, and the relevant gates are:

```powershell
node tests/e2e/youtube-timer.e2e.mjs      # real googlevideo stream, real controls
node tests/e2e/player-v1088.e2e.mjs       # timer / click / volume regressions
npx electron scripts/test-youtube-controls.mjs   # real extract -> real proxy -> real hls.js
```

If a change is genuinely required in a frozen file, it must be scoped as its own
commit with a failing adult-source gate attached as justification, and this
file's "Locked in release" line must be updated.
