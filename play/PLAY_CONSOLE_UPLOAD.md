# Google Play Console — Internal Testing Upload Pack (v1.0.59)

All assets are staged in this directory (`play/`) except where noted. Screen
dimensions have been verified with System.Drawing (exact pixel sizes required by Play).

## 1. Signed bundle to upload (Internal testing track)

| Item | Path / URL |
| ---- | ---------- |
| Signed AAB (v1.0.59, versionCode 59) | `https://github.com/Yakfal/nekofal/actions/runs/36343043672/artifacts/10939666584` (Download `app-release.aab`) |

Upload via Play Console → **Testing → Internal testing → Create release → Upload**.
Then copy the opt-in via the "Manage testers" link on the Internal testing page
so testers install directly from Play without sideloading.

## 2. Store assets (already generated)

| Asset | Requirement | File | Size verified |
| ----- | ----------- | ---- | ------------- |
| App icon | 512×512 PNG | `play/app-icon-512.png` | 512×512 ✓ |
| Feature graphic | 1024×500 PNG | `play/feature-graphic-1024x500.png` | 1024×500 ✓ |
| Android TV banner | 320×180 or 640×360 PNG (launcher) | `play/tv-banner-640x360.png` | 640×360 ✓ |
| TV listing banner | 1280×720 PNG (Play TV listing, optional) | `play/tv-listing-1280x720.png` | 1280×720 ✓ |

### Android TV launcher banner → replace in-app placeholder
`android/app/src/main/res/drawable/tv_banner.xml` is still the blue placeholder
vector. Replace it with the branded 640×360 PNG:
- Convert `play/tv-banner-640x360.png` → `android/app/src/main/res/drawable-xhdpi/tv_banner.png`
- Remove or replace `drawable/tv_banner.xml` (keep one resource of that name).
- Optional: add `drawable-mdpi` (320×180) and `drawable-xxxhdpi` (primary 213,
  213: tv banner maps to xxxhdpi on 4K TVs).

## 3. Screenshots (you must capture on device)

Play requires 2+ real screenshots (JPEG/PNG). Suggested from the TV build:

| Type | Size guidance | How to capture |
| ---- | ------------- | -------------- |
| Phone portrait | ~1080×1920 (or min 320px, aspect ≤2:1) | Install `nekofal-android-1.0.59` debug/release APK on a phone; `adb exec-out screencap -p > phone.png` |
| TV landscape | 1280×720 (16:9) | On TV/emulator: `adb exec-out screencap -p > tv.png` or screenshot via emulator |

Capture: (a) home grid w/ category pills & cards, (b) a playing stream with
controls, (c) Settings/language modal showing the trapped focus ring.

## 4. Privacy Policy (hosted)

| Item | File |
| ---- | ---- |
| Markdown source | `docs/privacy-policy.md` |
| Self-contained HTML | `docs/privacy-policy.html` |

Hosting options (need a public, stable URL):
- **GitHub Pages**: push `docs/` then Settings → Pages → Deploy from branch `main` `/docs`. URL becomes
  `https://Yakfal.github.io/nekofal/privacy-policy.html`.
- **Raw GitHub** (works but not ideal): `https://raw.githubusercontent.com/Yakfal/nekofal/main/docs/privacy-policy.md`
- Any static host (Netlify/Vercel/your own server).

Enter the URL in Play Console → **App content → Privacy policy**.

## 5. Data safety questionnaire answers

Declare in Play Console → **App content → Data safety**:

| Question | Answer |
| -------- | ------ |
| Does the app collect/share user data? | No shared data. Data is **not collected** by Nekofal (all data stays on-device). |
| Data types — Personal info | **Not collected.** |
| Location | Not collected. |
| App activity (search, browsing, in-app purchases) | Not collected — bookmarks/history stay on-device. |
| Financial info | Not collected. |
| Health/fitness | Not collected. |
| Messages / photos & videos / audio files | Not collected. |
| Files/docs | Not collected. |
| Device or other IDs | Not collected. |
| Data shared with third parties | **None.** |
| Data encrypted in transit | Yes, where a selected stream uses HTTPS/HTTPS-protected sources. |
| Data deletion | Users clear local data by clearing app storage / uninstalling. |

> Because data never leaves the device, the entire Data Safety form can be
> answered with "not collected / not shared", and the app is treated as
> on-device only. When PocketBase sync ships in a later version, update this
> form to reflect the user-controlled server sync and update the privacy policy
> section 4 then.

## 6. Play Console listing text (drafts)

- **App name:** Nekofal
- **Short description:** Self-hosted media streaming hub for Android TV & phone.
- **Full description draft:** Nekofal is a local, self-hosted media hub that
  streams live TV, radio, and video from sources you choose. TV-first design
  with full remote D-Pad navigation, favorites and watch history that persist
  on your device, and no account or subscription required.
  - Browse categories and media cards with your TV remote
  - Stream live channels, radio, and on-demand video
  - Save favorites; progress and history stored locally on your device
  - Optional, fully client-side configuration for advanced/custom sources
- **Category:** Entertainment · **Tags:** TV, streaming, media player

## 7. Pre-upload checklist (before hitting "Send for review")

- [ ] Upload `app-release.aab` to Internal testing and add ≥1 tester via opt-in URL
- [ ] Fill in the listing fields (short/full description, category) — drafts in §6
- [ ] Upload icon (`app-icon-512.png`) and feature graphic
- [ ] Upload ≥2 real screenshots captured from the TV build (§3)
- [ ] Provide the hosted privacy policy URL (§4, from `docs/privacy-policy.html`)
- [ ] Complete the Data safety questionnaire (§5)
- [ ] Set Content rating questionnaire (submit; likely "Unrated"/Everyone 12+ given the optional adult section — confirm)
- [ ] Complete Target audience & App access (no login needed unless custom servers; declare if you gate content)
- [ ] Set the app as a TV app (it already declares `LEANBACK_LAUNCHER` + banner so Play will expose a TV app form)
- [ ] Send to review; note Google runs Pre-Launch Reports automatically on every upload

## 8. Post-upload expectations (Pre-Launch Report)

After the first AAB upload, Google's bots install the app on physical devices
and TV emulators and capture screenshots/reports. Watch the Pre-launch report
in Play Console for: Leanback LTV crashes, WebView crashes, ANRs, or target API
warnings. Report any crash fixes back here for a 1.0.60 tag.

---
Generated by the dev pipeline. Assets in `play/` use the standard Nekofal logo
(SVG source `src/assets/logo.svg`).