# Nekofal — Code Signing Policy

This document defines how Nekofal's Windows binaries are code signed. It is the
policy required by [SignPath Foundation](https://signpath.org/) (a free
code-signing provider for qualifying open-source projects, used by projects such
as LocalSend and SQLiteBrowser) and governs the signing request workflow in
`.github/workflows/build.yml`.

## 1. Project identity

- **Repository:** https://github.com/Yakfal/nekofal (public, MIT licensed)
- **Product:** Nekofal — desktop media streaming hub
- **Package:** `Yakfal.Nekofal` / `com.yakfal.nekofal`
- **Maintainers:** Repository maintainers with write access to the `main`
  branch and release tags.

## 2. Certificate & key handling

- Signing is performed by **SignPath Foundation** with their free OSS
  certificate; the private key is generated and held on SignPath's Hardware
  Security Module (HSM). No private key material ever exists in this repository
  or any build agent.
- The certificate links the published binary to this repository, allowing
  users to verify the binary was built from the Nekofal source tree.

## 3. What may be signed

Only artifacts produced by the canonical CI build of this repository may be
signed:

| Artifact | Policy |
| --- | --- |
| `Nekofal-Setup-<version>.exe` (NSIS installer) | release-signing |
| `Nekofal-<version>.exe` (portable) | release-signing |
| `latest.yml` (auto-update feed) | publish alongside signed installer |

No other binaries, DLLs or helper executables are signed.

## 4. Build trust — how artifacts are produced

- Signed builds must run on GitHub-hosted `windows-latest` runners inside this
  repository's Actions, on the `main` branch or a `v*` release tag.
- The build is fully deterministic and reproducible from the checked-out source
  with `npm ci`; no modify-after-build steps are permitted between packaging
  and signing.
- The packaging command is `npm run dist` (renderer → electron-builder → NSIS).
- Runtime dependencies of the build (yt-dlp, ffmpeg) are pinned via versioned
  release URLs; any change to those URLs is a normal code review.

## 5. Signing policies

- **`test-signing`** — applied to any run that is **not** a `v*` tag push
  (pull requests, `workflow_dispatch`, pushes to `main`). Test-signed binaries
  are never distributed as releases.
- **`release-signing`** — applied **only** to pushes of a `v*` release tag.
  A release tag must point at a commit merged through normal review onto
  `main`.
- Signing requests are submitted exclusively from CI using the
  `signpath/github-action-submit-signing-request` action; no human or
  maintainer laptop may submit requests directly. The API token is stored as a
  GitHub Actions secret.

## 6. Distribution & user-facing notes

- Signed installers are attached to the matching GitHub release
  (`v<version>`) together with the winget manifest (`dist/winget/nekofal.yaml`).
- While the project's download reputation builds, SmartScreen may still warn on
  fresh builds; the release body documents how to proceed and that
  `winget install Yakfal.Nekofal` is the alternative install path.

## 7. Revocation & compromise

- If the CI or the SignPath account is suspected of compromise, or if
  signature-validated malware is reported, maintainers must immediately:
  1. Suspend/revoke the signing policy in the SignPath portal,
  2. Yank the affected GitHub release(s),
  3. Communicate the incident to users in a release note / advisories,
  4. Request certificate revocation through SignPath Foundation.
- Releases suspected of being built from tampered source are re-built from a
  clean checkout and re-released under a new version number.

## 8. Policy changes

- Changes to this policy or to the signing workflow require a pull request
  reviewed and merged by a maintainer, mirroring the trust decision of the
  `release-signing` policy itself.