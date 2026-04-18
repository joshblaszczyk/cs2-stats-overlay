# CS2 Stats Overlay

**Free in-game overlay showing Leetify, csstats.gg, FACEIT, and Steam stats for every player in your CS2 match. FACEIT-safe, open source, no memory reading.**

![screenshot placeholder](docs/screenshot.png)

Hold `Tab` in-game. See everyone's rank, recent form, K/D, HLTV rating, Leetify aim/positioning/utility, map win-rate, and legitimacy flags — at a glance, before the round starts.

---

## Why this exists

Existing stats tools are web-only. Leetify, csstats.gg, and Faceit Finder all require you to alt-tab, paste a Steam ID, wait for a page to load, and mentally juggle three tabs — during the 30-second freezetime at the start of a match. This overlay does it automatically, for all 10 players, in-game, while you're already holding Tab.

## Features

- **Aggregates every major stats source in one view**: Leetify (aim/positioning/utility/reaction time/preaim), csstats.gg (HLTV rating, recent 30-match form, clutch/entry, per-map win rate), FACEIT (level, Elo, recent matches), Steam (hours, account age, bans, VAC history).
- **Smurf / cheater detection**: combines low-hour accounts, high aim ratings, low preaim, fast reaction time, and suspicious stats into a legitimacy score per player. No false promises — this isn't a cheat detector, it's a "probably smurf" hint.
- **Works in every game mode**: Premier, Competitive, Wingman, Faceit, Retakes, DM. Player detection uses GSI + the Steam coplay API to resolve all 10 players even in modes where GSI only exposes the local player.
- **Live match state**: current round, score, your live ADR/K/D, team buy advice.
- **Hover detail panel**: deep-dive stats for any player — drag it wherever you want on screen.
- **Auto-scaling**: works at 1080p, 1440p, 4K, 4:3 stretched, borderless and fullscreen modes.

## Safety (read this first)

**This app is FACEIT Anti-Cheat compatible because it does nothing that looks like cheating.** Specifically:

- ❌ **No memory reading.** The app never attaches to the CS2 process or reads its RAM.
- ❌ **No DLL injection.** Nothing loads into CS2's address space.
- ❌ **No game process hooking.** No API hooks, no IAT patching, no inline hooks.
- ❌ **No screen capture during matches.** No OCR. No pixel scraping from the game view.
- ✅ **GSI (Game State Integration)** — Valve's sanctioned stats API. A local HTTP server receives JSON from CS2. FACEIT themselves use GSI; it's explicitly allowed.
- ✅ **Passive `console.log` reading** — CS2 writes its console history to a text file. The app tails that file in read-only mode.
- ✅ **Post-match demo parsing** — after `round.phase === 'gameover'`, the app can parse the match's `.dem` file. Only after the match ends, never while the file is being written.

The entire source is here on GitHub. Read it yourself. If you find a code path that violates the above, open an issue.

### Privacy — no server, no telemetry, no tracking

**There is no developer-controlled backend for this app.** At all. The entire tool runs locally on your machine. Specifically:

- ❌ **No usage analytics.** The app does not count users, sessions, or feature usage.
- ❌ **No crash reporter.** Electron's crash reporting is disabled — error dumps never leave your machine.
- ❌ **No auto-update ping.** The app does not phone home to check for updates.
- ❌ **No proxy server.** Every API request goes directly from your PC to the provider (Steam, FACEIT, Leetify, csstats.gg) — there is no middleman service that can log your activity.
- ❌ **No shared keys baked into the binary.** You bring your own API keys. That's a feature: it means the author literally cannot see who uses the app.
- ✅ **Keys encrypted at rest** with Electron `safeStorage` (Windows DPAPI) — tied to your Windows user account, unreadable by other users on the same PC or by anyone who copies the file to another machine.
- ✅ **All source on GitHub.** Grep the code yourself — there is no domain in the codebase that belongs to the author.

The only outbound traffic the app makes is to hosts you explicitly configured:

| Host | Purpose |
| --- | --- |
| `api.steampowered.com` | Steam Web API — your own key |
| `open.faceit.com` | FACEIT API — your own key |
| `api-public.cs-prod.leetify.com` / `api.leetify.com` | Leetify API — your own key |
| `csstats.gg` | Scraped after one-time Steam login during setup |
| `steamcommunity.com` | Only during the optional Steam Guard login for Game Coordinator rank data |
| `127.0.0.1:3000` | The local GSI server — **bound to localhost only**, not reachable from the LAN |

If any future contributor adds a URL outside this list, it's a visible change in the diff — flag it in a PR review.

### What data the app does collect (locally)

- Steam IDs of the 9 other players in your match (from GSI + Steam coplay)
- Player stats from public APIs (Leetify, csstats.gg, FACEIT, Steam Web API) — held in memory for the current match, wiped on map change
- Your current match state (round number, score, your own K/D/ADR) from GSI
- Your own API keys, encrypted in `%APPDATA%\cs2-stats-overlay\settings.json`

None of this leaves your machine.

## Install

**Windows only.** The app uses Win32 APIs for transparent click-through overlays and won't run on macOS or Linux.

1. Download the latest installer from [Releases](https://github.com/joshblaszczyk/CS2-overlay-/releases).
2. Run the `.exe`. Windows will show the publisher name as **Joshua Blaszczyk** (the installer is code-signed via Azure Artifact Signing). On first run SmartScreen may still show a "publisher reputation building" warning while the cert earns reputation — click "More info" → "Run anyway".
3. Follow the in-app setup. You'll need to enter API keys (one-time) and sign into csstats.gg once.
4. Launch CS2 with `-console` in your launch options. The app writes a GSI config file to CS2's cfg folder automatically.
5. Hold `Tab` in-game. The overlay appears.

### Setup requires these API keys (free)

- **Steam Web API key** — [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey) (needs any Steam account + a domain string — `localhost` works)
- **FACEIT API key** — [developers.faceit.com](https://developers.faceit.com) (free developer account)
- **Leetify API key** (optional, recommended) — [leetify.com/app/developer](https://leetify.com/app/developer)
- **csstats.gg sign-in** — one-time Steam OpenID login in an embedded browser

All keys are stored encrypted at rest using Electron's `safeStorage` (Windows DPAPI). They never leave your machine.

## Build from source

```bash
git clone https://github.com/joshblaszczyk/CS2-overlay-.git
cd cs2-stats-overlay
npm install
cp .env.example .env  # optional, for dev with env-var API keys
npm run build
npm run dist          # builds the NSIS installer to ./release
```

Requires Node.js 20+ and Windows (native module rebuild on macOS/Linux is unsupported).

## How it works (high level)

```text
CS2 ──(GSI HTTP POST)──┐
                        │
 console.log (tail) ────┼──→ Main process ─→ Worker (API fetching) ─→ Renderer (React overlay)
                        │         │
 Steam Coplay SDK ──────┘         └─→ Puppeteer (csstats.gg scrape, Cloudflare-gated)
```

- **Main process** (`src/main/`): Electron main, GSI server, Win32 overlay, IPC.
- **Worker process** (`src/main/fetch-worker.js`): off-main-thread API fetching, so network latency never stutters the renderer.
- **Renderer** (`src/renderer/`): React, sandboxed, CSP-locked, zero `dangerouslySetInnerHTML`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for architecture details.

## Known limitations

- **Windows only.** No macOS or Linux support.
- **Leetify public API is frequently down.** The app falls back to `api.leetify.com/api/mini-profiles/` which returns fewer fields (no preaim, no per-map breakdown) but keeps core ratings available.
- **SmartScreen "publisher reputation" warnings** on first run. The installer is signed via Azure Artifact Signing so your cert chain shows the publisher correctly, but Microsoft's reputation system takes time to trust new certs — warnings fade as downloads accumulate.
- **csstats.gg requires a manual Steam login** during setup because of Cloudflare Turnstile. One-time cost.
- **FACEIT rate limits** at ~500 req/min. The app batches and throttles, but if you're rapidly queueing into new matches, some players may show no FACEIT data for a few seconds.

## License

[MIT](LICENSE). Do whatever you want with the code. If you ship a fork, don't blame me for bans (you won't get one — see Safety section — but still).

## Disclaimer

This is a community project, not affiliated with Valve, FACEIT, Leetify, or csstats.gg. Counter-Strike 2 is a trademark of Valve. All third-party stats data is owned by its respective provider.

This app does not modify CS2 in any way. Using third-party overlays is at your own risk; while the architecture is designed for anti-cheat compatibility, no developer can guarantee Valve or FACEIT's future decisions.

## Credits

- [Leetify](https://leetify.com) — the deepest CS2 analytics service
- [csstats.gg](https://csstats.gg) — community stats tracker
- [FACEIT](https://faceit.com) — matchmaking + stats API
- [Valve](https://store.steampowered.com) — for shipping GSI
