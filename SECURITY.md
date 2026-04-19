# Security Policy

## Scope

This document covers security for the **CS2 Stats Overlay** Electron application.

The application is built around two hard constraints:

1. **FACEIT Anti-Cheat compatibility.** The app must never read CS2 process memory, inject into CS2, hook APIs, or capture screen pixels while a match is live.
2. **Zero trust in the renderer.** The renderer is sandboxed, context-isolated, CSP-locked, and has no Node.js access. It only sees what `src/main/preload.js` explicitly exposes via `contextBridge`.

Any vulnerability that weakens either guarantee is in scope.

## Supported versions

Only the **latest release** is supported. Auto-update is enabled by default and silent; users are expected to be on the newest version within a day of release.

| Version | Supported |
| --- | --- |
| Latest `0.x.y` | Yes |
| Anything older | No — please update first |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately via one of:

- **GitHub Security Advisories** (preferred) — [Report a vulnerability](https://github.com/joshblaszczyk/cs2-stats-overlay/security/advisories/new).
- **Email** — `joshuablaszczyk@gmail.com` with the subject prefix `[cs2-stats-overlay security]`.

Please include:

1. A clear description of the issue and the affected component (main, renderer, preload, worker, scraper, updater, GSI server).
2. Reproduction steps or a proof-of-concept, if possible.
3. The version you reproduced on (visible in **Settings → About** as `<version>-<build-tag>`).
4. Your assessment of the impact — credential disclosure, code execution, FACEIT-AC violation, etc.

### What to expect

- Acknowledgement within **72 hours**.
- An initial triage and severity assessment within **7 days**.
- A patched release within **30 days** for high-severity issues. Lower-severity issues are bundled into the next regular release.
- Credit in the release notes if you'd like it — let me know your preferred name / handle.

## Out of scope

- Vulnerabilities in third-party services the app talks to (Steam Web API, FACEIT, Leetify, csstats.gg, csrep.gg, GitHub). Report those to the upstream provider.
- Issues that require local admin on the user's machine or physical access — if someone else already owns your Windows account, the app's `safeStorage` guarantees don't help and neither can we.
- The SmartScreen "publisher reputation building" warning. That's a Microsoft reputation system, not a bug.
- Denial-of-service against the local GSI HTTP server from **localhost** (it's bound to 127.0.0.1 by design).

## Hardening checklist (for contributors)

If you're sending a PR that touches any of these, double-check:

- `src/main/preload.js` — every new IPC surface should be a named method with a validated input. Never expose `ipcRenderer`, `require`, or the raw `contextBridge` to the renderer.
- `src/main/ipc/**` — every handler should allowlist keys, coerce types, and cap lengths. See `save-api-keys` and `save-settings` for the pattern.
- `src/main/gsi-server.js` — must stay bound to `127.0.0.1`. Never bind to `0.0.0.0`.
- `src/main/index.js` BrowserWindow config — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`. Don't weaken these for convenience.
- CSP in `src/renderer/index.html` — don't add `unsafe-inline` or `unsafe-eval`.
- `shell.openExternal` call sites — only ever with `https://` or `http://` URLs, never with user-controlled `file://`, `javascript:`, or other schemes.
- Logging — never log API keys, Steam refresh tokens, or session cookies. The bug-report export (`src/main/sanitize.js`) redacts these; keep the allowlist tight.

## FACEIT AC compatibility

The following categories of change are **not acceptable** and will be rejected on sight:

- Any code that opens a handle to the CS2 process (`OpenProcess`, `ReadProcessMemory`, etc.).
- Any DLL injection, IAT hooks, inline hooks, or `SetWindowsHookEx` targeting CS2.
- Any automation of CS2 input (recoil control, trigger bot, aim-assist).
- Any in-game rendering into CS2 (ESP, wallhacks).
- Any screen capture / OCR during a live match.

If you're unsure whether an idea is acceptable, open an issue first.
