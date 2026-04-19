# CS2 Stats Overlay

[![Latest release](https://img.shields.io/github/v/release/joshblaszczyk/cs2-stats-overlay?display_name=tag&sort=semver)](https://github.com/joshblaszczyk/cs2-stats-overlay/releases)
[![Downloads](https://img.shields.io/github/downloads/joshblaszczyk/cs2-stats-overlay/total)](https://github.com/joshblaszczyk/cs2-stats-overlay/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078d6)](#install)
[![License](https://img.shields.io/github/license/joshblaszczyk/cs2-stats-overlay)](LICENSE)
[![FACEIT-safe](https://img.shields.io/badge/FACEIT--AC-compatible-brightgreen)](#safety-read-this-first)

**A free, open-source in-game overlay that aggregates Leetify, csstats.gg, csrep.gg, FACEIT, and Steam stats for every player in your CS2 match — all behind a single `Tab` press. FACEIT Anti-Cheat compatible. No memory reading. No telemetry.**

Hold `Tab` in-game. See everyone's rank, recent form, K/D, HLTV rating, Leetify aim/positioning/utility, csrep trust score, map win-rate, and legitimacy flags — at a glance, before the round starts.

---

## Contents

- [Why this exists](#why-this-exists)
- [Features](#features)
- [Safety](#safety-read-this-first)
- [Privacy](#privacy--no-server-no-telemetry-no-tracking)
- [Install](#install)
- [Build from source](#build-from-source)
- [How it works](#how-it-works-high-level)
- [Known limitations](#known-limitations)
- [License](#license)
- [Credits](#credits)

## Why this exists

Existing CS2 stats tools are web-only. Leetify, csstats.gg, and Faceit Finder each require you to alt-tab, paste a Steam ID, wait for a page to load, and juggle three tabs — during the 30-second freezetime at the start of a match. This overlay does it automatically, for all 10 players, in-game, while you're already holding `Tab`.

## Features

- **Every major stats source in one view.** Leetify (aim / positioning / utility / reaction time / preaim), csstats.gg (HLTV rating, recent 30-match form, clutch / entry, per-map win rate), csrep.gg (trust score + 12 Stats-Based-Analysis metrics with per-metric deltas and verdicts), FACEIT (level, Elo, recent matches), Steam (hours, account age, bans, VAC history).
- **Smurf / cheater hints.** Combines low-hour accounts, high aim ratings, low preaim, fast reaction time, csrep anomaly flags, and suspicious per-metric deltas into a legitimacy score per player. Not a cheat detector — a "probably smurf" hint.
- **Works in every game mode.** Premier, Competitive, Wingman, FACEIT, Retakes, Deathmatch. Player detection uses GSI + the Steam coplay API to resolve all 10 players even in modes where GSI only exposes the local player.
- **Live match state.** Current round, score, your live ADR / K/D, team buy advice.
- **Hover detail panel.** Deep-dive stats for any player — draggable anywhere on screen.
- **Auto-scaling.** Works at 1080p, 1440p, 4K, 4:3 stretched, borderless and fullscreen.
- **Silent auto-update.** Checks on launch, downloads in the background, and re-launches itself when a new version is available — no installer wizard.

## Safety (read this first)

**This app is FACEIT Anti-Cheat compatible because it does nothing that looks like cheating.** Specifically:

- No memory reading. The app never attaches to the CS2 process or reads its RAM.
- No DLL injection. Nothing loads into CS2's address space.
- No game process hooking. No API hooks, no IAT patching, no inline hooks.
- No screen capture during matches. No OCR. No pixel scraping from the game view.
- **GSI (Game State Integration)** — Valve's sanctioned stats API. A local HTTP server receives JSON from CS2. FACEIT themselves use GSI; it's explicitly allowed.
- **Passive `console.log` reading** — CS2 writes its console history to a text file. The app tails that file in read-only mode.
- **Post-match demo parsing** — only after `round.phase === 'gameover'`. Never while the demo file is being written.

The entire source is here on GitHub. Read it yourself. If you find a code path that violates the above, open an issue — see [SECURITY.md](SECURITY.md) for responsible disclosure.

## Privacy — no server, no telemetry, no tracking

**There is no developer-controlled backend for this app.** At all. The entire tool runs locally on your machine.

- No usage analytics. The app does not count users, sessions, or feature usage.
- No crash reporter. Electron's crash reporting is disabled — error dumps never leave your machine.
- No proxy server. Every API request goes directly from your PC to the provider — there is no middleman service that can log your activity.
- No shared keys baked into the binary. You bring your own API keys. That's a feature: it means the author literally cannot see who uses the app.
- Keys encrypted at rest with Electron `safeStorage` (Windows DPAPI) — tied to your Windows user account, unreadable by other users on the same PC or by anyone who copies the file to another machine.

The only outbound traffic the app makes is to hosts you explicitly configured, plus GitHub for auto-updates:

| Host | Purpose |
| --- | --- |
| `api.steampowered.com` | Steam Web API — your own key |
| `open.faceit.com` | FACEIT API — your own key |
| `api-public.cs-prod.leetify.com` / `api.leetify.com` | Leetify API — your own key |
| `csstats.gg` | Scraped after one-time Steam login during setup |
| `csrep.gg` | Scraped (public data, no login) |
| `steamcommunity.com` | Only during the optional Steam Guard login for Game Coordinator rank data |
| `api.github.com` / `github.com` | Auto-update check + download |
| `127.0.0.1:3000` | The local GSI server — **bound to localhost only**, not reachable from the LAN |

If any future contributor adds a URL outside this list, it's a visible change in the diff — flag it in a PR review.

### What data the app collects (locally)

- Steam IDs of the 9 other players in your match (from GSI + Steam coplay)
- Player stats from public APIs (Leetify, csstats.gg, csrep.gg, FACEIT, Steam Web API) — held in memory for the current match, wiped on map change
- Your current match state (round number, score, your own K/D / ADR) from GSI
- Your own API keys, encrypted in `%APPDATA%\cs2-stats-overlay\settings.json`

None of this leaves your machine.

## Install

**Windows 10 / 11 only.** The app uses Win32 APIs for transparent click-through overlays and won't run on macOS or Linux.

1. Download the latest installer from [Releases](https://github.com/joshblaszczyk/cs2-stats-overlay/releases).
2. Run `CS2-Stats-Overlay-Setup-<version>.exe`. Windows will show the publisher as **Joshua Blaszczyk** — the installer is code-signed via [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/). On first run SmartScreen may still show a "publisher reputation building" warning while the cert earns reputation — click **More info** → **Run anyway**.
3. Follow the in-app setup. You'll need to enter API keys (one-time) and sign into csstats.gg once.
4. Launch CS2 with `-console` in your launch options. The app writes a GSI config file to CS2's cfg folder automatically.
5. Hold `Tab` in-game. The overlay appears.

### API keys (all free)

| Source | Where to get it | Required? |
| --- | --- | --- |
| Steam Web API | [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) | Required |
| FACEIT Open Data | [developers.faceit.com](https://developers.faceit.com) | Required |
| Leetify Developer | [leetify.com/app/developer](https://leetify.com/app/developer) | Recommended |
| csstats.gg login | One-time Steam OpenID login in an embedded browser | Required |

All keys are stored encrypted at rest using Electron's `safeStorage` (Windows DPAPI).

## Build from source

```bash
git clone https://github.com/joshblaszczyk/cs2-stats-overlay.git
cd cs2-stats-overlay
npm install
cp .env.example .env          # optional, for dev with env-var API keys
npm run build                 # builds renderer + main into ./out
npm run dist                  # builds the NSIS installer to ./release
```

Requirements: Node.js 20+, Windows (native module rebuild on macOS / Linux is unsupported).

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details, coding conventions, and PR guidelines.

## How it works (high level)

```text
CS2 ──(GSI HTTP POST)──┐
                       │
 console.log (tail) ───┼──→ Main process ──→ Worker (API fetching) ──→ Renderer (React overlay)
                       │         │
 Steam Coplay SDK ─────┘         └──→ Puppeteer (csstats.gg + csrep.gg scrape, Cloudflare-gated)
```

- **Main process** (`src/main/`) — Electron main, GSI server, Win32 overlay, IPC.
- **Worker process** (`src/main/fetch-worker.js`) — off-main-thread API fetching, so network latency never stutters the renderer.
- **Renderer** (`src/renderer/`) — React, sandboxed, CSP-locked, zero `dangerouslySetInnerHTML`.

## Known limitations

- **Windows only.** No macOS or Linux support.
- **Leetify public API is frequently down.** The app falls back to `api.leetify.com/api/mini-profiles/` which returns fewer fields (no preaim, no per-map breakdown) but keeps core ratings available.
- **SmartScreen "publisher reputation" warnings** on first run. The installer is signed via Azure Trusted Signing so the cert chain shows the publisher correctly, but Microsoft's reputation system takes time to trust new certs — warnings fade as downloads accumulate.
- **csstats.gg requires a one-time manual Steam login** during setup because of Cloudflare Turnstile.
- **FACEIT rate limits** at ~500 req/min. The app batches and throttles, but if you're rapidly queueing into new matches, some players may show no FACEIT data for a few seconds.

## License

[MIT](LICENSE). Do whatever you want with the code.

## Disclaimer

This is a community project, not affiliated with Valve, FACEIT, Leetify, csstats.gg, or csrep.gg. Counter-Strike 2 is a trademark of Valve. All third-party stats data is owned by its respective provider.

This app does not modify CS2 in any way. Using third-party overlays is at your own risk; while the architecture is designed for anti-cheat compatibility, no developer can guarantee Valve's or FACEIT's future decisions.

## Credits

- [Leetify](https://leetify.com) — the deepest CS2 analytics service
- [csstats.gg](https://csstats.gg) — community stats tracker
- [csrep.gg](https://csrep.gg) — community reputation / anti-cheat analytics
- [FACEIT](https://faceit.com) — matchmaking + stats API
- [Valve](https://store.steampowered.com) — for shipping GSI
