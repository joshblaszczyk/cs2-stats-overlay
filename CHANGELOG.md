# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## [0.1.14] — 2026-04-19

### Fixed

- CI release build failed on v0.1.13 because electron-builder 26.8.1 rejects `win.publisherName` at the root — moved into `win.signtoolOptions.publisherName`. First actual installer carrying the new publisher name.

### Changed

- Documentation polish pass — README, CONTRIBUTING, LICENSE, new CHANGELOG + SECURITY + PR template.

## [0.1.13] — 2026-04-19

### Changed

- Installer publisher name displayed as **Joshua Blaszczyk** (instead of the Steam handle) — affects SmartScreen, Windows Firewall, and Add/Remove Programs. **Note:** the v0.1.13 CI release failed at build time; v0.1.14 is the first version that actually shipped this change.

## [0.1.12] — 2026-04-18

### Added

- Per-metric deltas and severity verdicts (`Highly Suspicious`, `Very Suspicious`, `Suspicious`, `Normal`, `Legit`, `Clean`, `Insufficient Data`) for every csrep.gg Stats-Based-Analysis metric.
- Signed delta display in the Detail Panel, colour-coded by verdict severity.

## [0.1.11] — 2026-04-18

### Added

- Full 12-metric csrep SBA block in the Detail Panel (Trust, SBA, K/D, ADR, HLTV, KAST, Aim, Head, Reaction, TTD, Preaim, Crosshair, Wallbang, Smoke).

## [0.1.10] — 2026-04-18

### Fixed

- Small retry batches were being gated out during the `live` round phase, causing stragglers never to be re-fetched. Threshold lifted for retry batches.

## [0.1.9] — 2026-04-18

### Changed

- Auto-update now installs silently (`quitAndInstall(true, true)`) — no NSIS wizard pops up after download.

## [0.1.8] — 2026-04-18

### Added

- Download progress percentage shown on the "Check for update" button.
- App auto-restarts ~1.5s after the update is downloaded.

## [0.1.7] — 2026-04-18

### Fixed

- Updater filename mismatch between on-disk artifact, `latest.yml`, and GitHub release. Explicit `artifactName` template pinned to `CS2-Stats-Overlay-Setup-${version}.${ext}`.

## [0.1.6] — 2026-04-17

### Added

- Idle browser shutdown (30s) to free RAM between matches.
- csrep.gg as a fallback data source when csstats.gg returns nothing.
- Short TTL (20 min) for empty lookup results so new / private profiles re-check sooner.

## [0.1.5] — 2026-04-17

### Fixed

- csstats.gg was sometimes parsed before the page had hydrated — caused `null` lifetime stats for friends.
- Infinite retry loop on legitimately empty profiles.
- Background micro-stutter during matches (renderer frame rate throttled while overlay is hidden).
- Settings panel closes when you click outside of it.

## [0.1.4] — 2026-04-16

### Fixed

- Unresponsive "Check for updates" button in Settings — added 20s watchdog timeout.
- csrep.gg reader was stuck on the Cloudflare challenge intermittently — pre-warm + better readiness signal (`Stats Based Analysis` instead of `Player Reputation`).

## [0.1.2 – 0.1.3] — 2026-04-15

### Changed

- First publishable CI releases (`draft: false`) so the electron-updater can actually see them.
- Repo renamed to `cs2-stats-overlay`; all hard-coded URLs updated.

## [0.1.1] — 2026-04-14

### Added

- Baseline release. CI signing with Azure Trusted Signing, NSIS installer, GitHub Releases upload, auto-update via `electron-updater`.

[0.1.14]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.14
[0.1.13]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.13
[0.1.12]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.12
[0.1.11]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.11
[0.1.10]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.10
[0.1.9]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.9
[0.1.8]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.8
[0.1.7]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.7
[0.1.6]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.6
[0.1.5]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.5
[0.1.1]: https://github.com/joshblaszczyk/cs2-stats-overlay/releases/tag/v0.1.1
