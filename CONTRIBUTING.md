# Contributing

Thanks for considering a contribution. This doc covers local setup, project layout, and the ground rules for PRs.

## Prereqs

- **Windows 10/11** — the app uses Win32 APIs via `koffi` and native modules that only build for Windows.
- **Node.js 20+**
- **Python 3** (only for icon build scripts; not required for running the app)
- A Steam account + a CS2 installation for testing

## Local setup

```bash
git clone https://github.com/joshblaszczyk/cs2-stats-overlay.git
cd cs2-stats-overlay
npm install
cp .env.example .env    # fill in your own dev API keys
npm run build           # builds renderer + main into ./out
npm run dev             # runs electron against the built bundle
```

For a packaged installer:

```bash
npm run dist   # outputs ./release/CS2 Stats Overlay Setup.exe
```

## Project layout

```text
src/
├── main/                       Electron main process
│   ├── index.js                Entry, window management, IPC, CS2 detection
│   ├── gsi-server.js           Local HTTP server for Valve's Game State Integration
│   ├── gsi-config.js           Writes the CS2 GSI config file + holds the auth token
│   ├── console-parser.js       Tails CS2's console.log for player detection fallback
│   ├── demo-parser.js          Post-match .dem parsing (via demoparser2)
│   ├── coplay.js               Steam Coplay SDK via koffi FFI (recently-played-with list)
│   ├── gc-client.js            Steam Game Coordinator client (for live rank data)
│   ├── steam-api.js            Steam Web API client (player summaries, bans, playtime)
│   ├── faceit-api.js           FACEIT Open Data API client
│   ├── leetify-api.js          Leetify v3 API + mini-profile fallback
│   ├── csstats-scraper.js      Puppeteer-based csstats.gg scraper (Cloudflare gated)
│   ├── fetch-worker.js         Forked child process — all API fetching lives here
│   ├── player-cache.js         LRU cache for per-player lookups
│   ├── settings.js             Encrypted settings load/save via safeStorage
│   ├── service-status.js       Health tracking for each data source
│   └── preload.js              contextBridge — renderer ↔ main IPC surface
└── renderer/src/               React frontend
    ├── App.jsx                 Root, state orchestration, IPC subscriptions
    ├── Setup.jsx               First-run setup wizard
    ├── Scoreboard.jsx          The main overlay scoreboard
    ├── DetailPanel.jsx         Per-player deep-dive panel (on hover)
    ├── Settings.jsx            In-app settings UI
    ├── PerfHud.jsx             Dev-only performance HUD (Ctrl+Shift+P)
    └── styles.css              All CSS lives here
```

## How the pieces talk

```text
CS2 ─(HTTP POST)─→ gsi-server.js ──┐
                                    │
  console.log ──→ console-parser ──┼─→ index.js ──(worker.send)──→ fetch-worker.js
                                    │                                   │
  Steam SDK ───→ coplay.js ────────┘                                   │
                                                                        │
                        ┌───────────────────────────────────────────────┘
                        │
                        ▼
               steam-api / faceit-api / leetify-api / csstats-scraper
                        │
                        ▼
                 worker → main (IPC)
                        │
                        ▼
                main → renderer (win.webContents.send)
```

- **Main process owns everything with a Win32 handle**: the BrowserWindow, the tray, the GSI HTTP server, CS2 process detection.
- **Worker process owns all network I/O**: so a slow API call never blocks the main event loop or stutters CS2.
- **Renderer is sandboxed**: `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, strict CSP, no `dangerouslySetInnerHTML`. It only knows what `preload.js` exposes via `contextBridge`.

## Security ground rules

If you're touching main process or preload, read [SECURITY.md](SECURITY.md) first if it exists, or the security section below.

- **Never** expose raw `ipcRenderer` or `require` to the renderer. Only add methods to `contextBridge.exposeInMainWorld` — one per use case.
- **Validate every IPC input** at the handler. Allowlist keys, coerce types, cap lengths. See `save-api-keys` / `save-settings` / `save-position` handlers for the pattern.
- **Never log secrets**. No `console.log(password)`, no `console.log(apiKey)`. The refresh token file is encrypted via safeStorage — keep it that way.
- **Don't disable CSP** in `onHeadersReceived`. If you need to load external content, use an `<img>` / `<iframe>` and widen the policy for that specific directive only.
- **Don't remove `sandbox: true`** from the BrowserWindow config. If you need Node in the renderer, you're doing it wrong — add a preload method instead.
- **Rate limit all outbound API calls** per the existing patterns (see `leetify-api.js` for the sequential queue + backoff model).
- **FACEIT anti-cheat compatibility is a hard requirement**. Don't add code that reads CS2 process memory, injects DLLs, hooks APIs, or captures screen pixels while a match is live. If you're unsure, ask in an issue before submitting a PR.

## Coding conventions

- **Formatting**: match existing style. 2-space indent, single quotes, no semicolons in new JS files — wait no, **do use semicolons**, the existing codebase uses them.
- **No unnecessary comments.** Explain *why*, not *what*. If a function name + types make the behavior obvious, no comment.
- **No backward-compat shims for unreleased features.** Rename, delete, or change freely until v1.0.
- **Small PRs.** One feature or fix per PR. Huge refactors get rejected without review unless pre-agreed in an issue.
- **Test what you wrote.** There's no formal test suite yet (this is a solo project) but you should at minimum: launch the packaged app, run through setup, start CS2, verify the overlay shows, verify your change works, verify existing features still work.

## What I'll accept

- Bug fixes
- New data sources (more APIs)
- Performance improvements (with before/after measurements)
- UI polish (with screenshots in the PR)
- FACEIT-safety audits
- Documentation improvements
- Build / CI improvements

## What I won't accept

- Anything that reads CS2 memory
- Anything that injects into CS2
- Anything that auto-plays the game (recoil control, trigger bot, ESP rendering inside CS2)
- Paid features / monetization hooks
- Telemetry or analytics
- Obfuscated / minified code in the source tree

## Questions?

Open a [discussion](https://github.com/joshblaszczyk/cs2-stats-overlay/discussions) or an [issue](https://github.com/joshblaszczyk/cs2-stats-overlay/issues). I'll respond, eventually.
