# Nekofal Privacy Policy

**Effective date:** September 27, 2026
**Version:** 1.0

## 1. Overview

Nekofal ("the app", "we") is a local, self-hosted media streaming hub for
Android TV, Android phone/tablet, and Desktop (Electron). This policy explains
what data the app stores, what it sends over the network, and the choices you
have.

The short version: **Nekofal does not collect, sell, or share any personal
data.** All bookmarks, favorites, watch history, language preferences, and
settings are stored **only on your own device**.

## 2. Data stored on your device

The app keeps the following information locally, on the device you are using:

| Data | Where it is stored | Purpose |
| ---- | ------------------ | ------- |
| Favorites, watch history, bookmarks | IndexedDB / localStorage (WebView storage) | Restore your lists and progress on relaunch |
| Language and UI preferences | localStorage | Remember how you configured the app |
| Media server connection details | localStorage | Connect to your own server/instance |
| Adult-content site configuration | localStorage | Home URLs and settings for the optional adult section |
| Desktop secrets vault | Electron safeStorage (OS keychain) | Store credentials you enter on Desktop only |

On Android, data lives inside the app's private WebView storage. Deleting the
app clears this data. On Desktop, data lives in the Electron user-data folder;
uninstalling it removes it. We do not back it up anywhere else.

## 3. Data sent over the network

When you actively use a feature, the app makes network requests **only to
destinations you trigger or that you have configured**:

- **Streams & playlists**: IPTV playlist sources (e.g. iptv-org), radio
  directories (e.g. radio-browser.info), public archives (e.g. archive.org),
  and any stream URL you open. The app fetches exactly the URLs the current
  feature requires.
- **Custom servers**: If you configure a self-hosted server URL (PocketBase or
  your own media server), the app communicates with that server using the
  credentials you supply. Those are sent only to the server you configured.
- **Optional adult section**: Only when you enable and use it, the app loads
  the adult site URLs you have defined.

Nekofal itself runs **no analytics, no advertising SDKs, no third-party
tracking, and no crash-reporting service**. It does not phone home. There is no
central Nekofal account or Nekofal-operated server.

## 4. Cloud sync (if enabled in future)

If cloud sync is enabled in a future version, it will sync your favorites,
watch progress, and history to a **server you run yourself** using your own
credentials. Sync is optional and is off by default. Data synced to your own
server is governed by your control of that server; Nekofal will not operate a
cloud service.

## 5. Children

Nekofal is not directed at children. The app may surface links to third-party
streaming/web content, including an adult section that is disabled by default
and requires explicit user configuration to enable. The app does not
knowingly collect information from children.

## 6. Third-party content

Media thumbnails, streamed video/audio, and playlists are served by third
parties you choose to load. Those third parties may collect data under their
own privacy policies. Nekofal cannot control, and is not responsible for, the
privacy practices of those sites.

## 7. Security

- Data stays on your device and is not transmitted unless you use a feature
  that requires it.
- Secrets entered in Desktop mode are protected by the operating system
  keychain (Electron `safeStorage`).
- We recommend you use your own server with HTTPS if you enable sync.

## 8. Your choices

- Clear favorites/history within the app or by clearing app data in your OS
  settings.
- Uninstall the app to remove all locally stored data.
- Disable or refrain from enabling the optional adult section.
- Control sync (when available) by simply not configuring a server.

## 9. Changes to this policy

We may update this policy as features evolve. Material changes will be
reflected by an updated version number and effective date at the top of this
document.

## 10. Contact

For questions about this policy: open an issue in the project repository
(Yakfal/nekofal).