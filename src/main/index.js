const path = require('path');
const fs = require('fs');
const { app, screen, Tray, Menu, ipcMain, shell, globalShortcut } = require('electron');

// Install file logger + crash hooks before any other module runs so we capture
// early errors. app.getPath('logs') resolves after electron init — logger
// guards against that by deferring file creation until install() is called.
app.whenReady().then(() => {
  try { require('./logger').install(); } catch (e) { console.error('[Main] Logger install failed:', e.message); }
});

// Force GPU rendering — CS2 is CPU-bound so keep overlay on GPU
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-zero-copy');
// Force 1:1 pixel mapping so GetCursorPos matches CSS coordinates exactly
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');


// ─── UIAccess elevation check (dev mode only) ───────────────
// Skip entirely when running as a packaged app (app.isPackaged)
if (!app.isPackaged && !process.argv.includes('--elevated') && !process.argv.includes('--no-elevate')) {
  try {
    const { elevateWithUIAccess } = require('./elevate');
    const electronExe = process.execPath;
    const appPath = path.join(__dirname, '../..');
    const success = elevateWithUIAccess(electronExe, appPath + ' --elevated');
    if (success) {
      console.log('[Main] Elevated process launched, exiting original...');
      app.quit();
      process.exit(0);
    }
  } catch (err) {
    console.log('[Main] Elevation not available:', err.message);
  }
}

// ─── Load .env ───────────────────────────────────────────────
const envPath = path.join(__dirname, '../../.env');
try {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  console.warn('[env] No .env file found at', envPath);
}

// Defer native module loading to avoid interfering with Electron's module system
let installGSIConfig, createGSIServer;
let setApiKey, fetchAllPlayerStats, setFaceitKey, settings, applyZoom, mergeScrapedIntoPlayer;
let initSteam, cleanupSteam, getRecentPlayers, getFriendsInGame, isSteamInitialized;
let gsiServer = null;
let koffi, GetAsyncKeyState, SetWindowPos, SetWindowLongPtrW, GetWindowLongPtrW;
let SetForegroundWindow, FindWindowW, GetWindowThreadProcessId, AttachThreadInput, GetCurrentThreadId, AllowSetForegroundWindow, GetCursorPos;

function loadNativeModules() {
  // Load everything except steamworks.js — that must wait until CS2 is running
  ({ installGSIConfig, installConsoleLogging, installLaunchOptions } = require('./gsi-config'));
  // uninstallGSIConfig loaded lazily in handler to avoid circular boot
  ({ createGSIServer } = require('./gsi-server'));
  ({ setApiKey, fetchAllPlayerStats } = require('./steam-api'));
  const { setLeetifyKey } = require('./leetify-api');
  ({ setFaceitKey } = require('./faceit-api'));
  settings = require('./settings');
  ({ applyZoom } = require('./display-zoom'));
  ({ mergeScrapedIntoPlayer } = require('./player-merge'));
  ({ initSteam, cleanupSteam, getRecentPlayers, getFriendsInGame, isInitialized: isSteamInitialized } = require('./steam-lifecycle'));

  // Load API keys from settings first, then .env as fallback
  const savedSettings = settings.load();
  const ak = savedSettings?.apiKeys || {};
  if (ak.steam) process.env.STEAM_API_KEY = ak.steam;
  if (ak.faceit) process.env.FACEIT_API_KEY = ak.faceit;
  if (ak.leetify) process.env.LEETIFY_API_KEY = ak.leetify;
  if (ak.leetify2) process.env.LEETIFY_API_KEY_2 = ak.leetify2;

  if (process.env.STEAM_API_KEY) setApiKey(process.env.STEAM_API_KEY);
  if (process.env.FACEIT_API_KEY) setFaceitKey(process.env.FACEIT_API_KEY);
  if (process.env.LEETIFY_API_KEY) setLeetifyKey(process.env.LEETIFY_API_KEY);

  // Wire up service status tracking
  const serviceStatus = require('./service-status');
  const reportStatus = (service, state) => {
    const changed = serviceStatus.set(service, state);
    if (changed && win) {
      win.webContents.send('service-status', serviceStatus.get());
      console.log(`[Status] ${service} → ${state}`);
    }
  };
  try { require('./leetify-api').setStatusReporter(reportStatus); } catch {}
  try { require('./csstats-scraper').setStatusReporter(reportStatus); } catch {}

  koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  GetAsyncKeyState = user32.func('short GetAsyncKeyState(int)');
  SetWindowPos = user32.func('int SetWindowPos(intptr, intptr, int, int, int, int, uint32_t)');
  SetWindowLongPtrW = user32.func('intptr SetWindowLongPtrW(intptr, int, intptr)');
  GetWindowLongPtrW = user32.func('intptr GetWindowLongPtrW(intptr, int)');
  SetForegroundWindow = user32.func('int SetForegroundWindow(intptr)');
  FindWindowW = user32.func('intptr FindWindowW(str16, str16)');
  GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(intptr, void*)');
  AttachThreadInput = user32.func('int AttachThreadInput(uint32_t, uint32_t, int)');
  GetCurrentThreadId = koffi.load('kernel32.dll').func('uint32_t GetCurrentThreadId()');
  AllowSetForegroundWindow = user32.func('int AllowSetForegroundWindow(uint32_t)');
  // For hover detection without forward:true
  GetCursorPos = user32.func('int GetCursorPos(_Out_ uint8_t*)');
}

// Steam SDK lifecycle lives in steam-lifecycle.js — initSteam/cleanupSteam
// and the accessors are imported in loadNativeModules().

let win = null;
let tray = null;
let tabDown = false;
let overlayHwnd = null;
let gsiReceivedData = false;
let gsiHintInterval = null;
// scrapedIds tracks which players we already have fresh csstats for; scrapedData
// holds the merged-ready payload. Both mutated in place (keys deleted, not
// reassigned) so async closures holding a reference keep seeing the live view.
let scrapedIds = new Set();
let scrapedData = {};
let coplayCache = null;
let coplayCacheTime = 0;
let csstatsRetryInterval = null;
let lastKnownRoundPhase = null;
let csstatsInflight = false;

// Single source of truth for "forget everything we scraped". Used by the
// match-reset path (new map, round-1 start) AND the user-initiated reset
// buttons (Reload Queue, Clear Cache). Keeps the worker's cache in sync.
function clearScrapedState() {
  scrapedIds.clear();
  for (const k of Object.keys(scrapedData)) delete scrapedData[k];
  if (worker && worker.connected) {
    try { worker.send({ type: 'clear-cache' }); } catch {}
  }
}

function runCsstatsScrape(steamIds, roundPhase) {
  if (!steamIds || steamIds.length === 0) return;
  if (roundPhase) lastKnownRoundPhase = roundPhase;
  // User-controlled kill switch
  if (settings?.load()?.general?.disableCsstats) return;
  // In-flight guard: concurrent scrapes share one puppeteer browser and
  // fight for pages, which spikes CPU + bricks CS2 frames. Retry loop
  // fires every 8s, but scrapes can take 30s+ with retries — without
  // this, they stack up.
  if (csstatsInflight) return;
  const toScrape = steamIds.filter(id => !scrapedIds.has(id));
  if (toScrape.length === 0) return;
  // Round-phase gate: the puppeteer browser spikes CPU when it
  // launches 3 parallel tabs for the initial 10-player lobby scrape.
  // If that lands mid-fight the user sees a stutter. Defer the heavy
  // batch until we're in freezetime / round-over / warmup.
  //
  // Only applies to LARGE batches (≥5 players). A retry loop catching
  // 1-3 stragglers is cheap (no browser cold start, often cache-warm)
  // and shouldn't be gated — otherwise on maps with no round cycle
  // (surf, DM, community servers) phase stays 'live' forever and
  // stragglers never get scraped.
  const LIVE_BATCH_GATE = 5;
  if (lastKnownRoundPhase === 'live'
      && scrapedIds.size > 0
      && toScrape.length >= LIVE_BATCH_GATE) {
    return;
  }
  console.log(`[CSScrape] Scheduling ${toScrape.length} player(s)`);
  csstatsInflight = true;
  // Immediate kickoff — no artificial delay
  (async () => {
    try {
      const { scrapeAllPlayers } = require('./csstats-scraper');
      const cssData = await scrapeAllPlayers(toScrape);
      // Only mark IDs as scraped when they actually returned data. If a scrape
      // failed (rate-limit, page timeout, private profile), leave it out of
      // scrapedIds so the retry loop picks it up on the next pass.
      for (const [id, cs] of Object.entries(cssData)) {
        if (!cs) continue;
        scrapedIds.add(id);
        scrapedData[id] = {
          premier: cs.premier,
          peakPremier: cs.peakPremier,
          faceitNickname: cs.faceitNickname || null,
          faceitLevel: cs.faceitLevel || null,
          csrepTrust: cs.csrepTrust ?? null,
          csrepAnomalies: cs.csrepAnomalies ?? null,
          csrepSba: cs.csrepSba ?? null,
          csrepSbaDelta: cs.csrepSbaDelta ?? null,
          csrepMetrics: cs.csrepMetrics ?? null,
          csrepMetricDeltas: cs.csrepMetricDeltas ?? null,
          csrepMetricVerdicts: cs.csrepMetricVerdicts ?? null,
          csrepAccount: cs.csrepAccount ?? null,
          csstats: {
            kd: cs.kd, hltvRating: cs.hltvRating, winRate: cs.winRate,
            hsPercent: cs.hsPercent, adr: cs.adr, kills: cs.kills,
            deaths: cs.deaths, assists: cs.assists, matches: cs.matches,
            won: cs.won, lost: cs.lost, tied: cs.tied, rounds: cs.rounds,
            damage: cs.damage,
            clutch1v1: cs.clutch1v1, clutch1v1Wins: cs.clutch1v1Wins, clutch1v1Losses: cs.clutch1v1Losses,
            clutch1v2: cs.clutch1v2, clutch1v2Wins: cs.clutch1v2Wins, clutch1v2Losses: cs.clutch1v2Losses,
            clutch1v3: cs.clutch1v3, clutch1v3Wins: cs.clutch1v3Wins, clutch1v3Losses: cs.clutch1v3Losses,
            clutch1v4: cs.clutch1v4, clutch1v4Wins: cs.clutch1v4Wins, clutch1v4Losses: cs.clutch1v4Losses,
            clutch1v5: cs.clutch1v5, clutch1v5Wins: cs.clutch1v5Wins, clutch1v5Losses: cs.clutch1v5Losses,
            clutchOverall: cs.clutchOverall,
            entrySuccess: cs.entrySuccess, entrySuccessT: cs.entrySuccessT, entrySuccessCT: cs.entrySuccessCT,
            entryAttempts: cs.entryAttempts, entryAttemptsT: cs.entryAttemptsT, entryAttemptsCT: cs.entryAttemptsCT,
            entryPerRound: cs.entryPerRound, mapStats: cs.mapStats,
            recentKd: cs.recentKd, recentAdr: cs.recentAdr,
            recentHs: cs.recentHs, recentRating: cs.recentRating,
            recentMatches: cs.recentMatches,
            recentWinRate: cs.recentWinRate,
          },
        };
      }

      // Use csstats-derived nicknames to pull level + elo from FACEIT's public
      // nickname endpoint. Runs whether or not the primary FACEIT API key is
      // set — if the primary fetch failed (rate limit / down / no key), this
      // keyless fallback fills the gap.
      try {
        const { getFaceitPublicByNickname } = require('./faceit-api');
        const hasKey = !!(process.env.FACEIT_API_KEY);
        if (cachedPlayers) {
          const queue = [];
          for (const p of cachedPlayers) {
            const sd = scrapedData[p.steamId];
            const nick = sd?.faceitNickname;
            if (!nick) continue;
            // Skip only if we already have BOTH level AND elo
            if (p.faceit && p.faceit.level != null && p.faceit.elo != null) continue;
            queue.push({ p, nick });
          }
          if (queue.length) {
            console.log(`[FACEIT-public] Fetching elo/level for ${queue.length} nickname(s)`);
            await Promise.all(queue.map(async ({ p, nick }) => {
              try {
                const fc = await getFaceitPublicByNickname(nick);
                if (fc) {
                  p.faceit = { ...(p.faceit || {}), ...fc };
                  // Stash into scrapedData so the worker-result re-apply loop
                  // can restore it when cachedPlayers gets replaced.
                  if (scrapedData[p.steamId]) {
                    scrapedData[p.steamId].faceitPublic = fc;
                  }
                }
              } catch {}
            }));
          }
        }

        // Re-check service coverage — Phase 1 (steam-api) marks FACEIT as
        // "down" if nobody has a level yet, but without an API key the public
        // path only fills in after csstats completes. Recompute now that
        // nicknames + levels are merged.
        try {
          const serviceStatus = require('./service-status');
          const total = cachedPlayers.length;
          if (total > 0) {
            const countFaceit = cachedPlayers.filter(p => p.faceit && p.faceit.level != null).length;
            const countCsstats = cachedPlayers.filter(p => p.csstats && p.csstats.kd != null).length;
            const updates = [];
            updates.push(['faceit', countFaceit > 0 ? 'ok' : (hasKey ? 'down' : 'unknown')]);
            if (countCsstats > 0) updates.push(['csstats', 'ok']);
            let changed = false;
            for (const [svc, state] of updates) {
              if (serviceStatus.set(svc, state)) changed = true;
            }
            if (changed && win) win.webContents.send('service-status', serviceStatus.get());
          }
        } catch {}
      } catch (err) {
        console.log('[FACEIT-public] fetch error:', err.message);
      }
      const gotCount = Object.values(cssData).filter(Boolean).length;
      console.log(`[CSScrape] Merged ${gotCount}/${toScrape.length} into player data`);
      if (cachedPlayers) {
        for (const p of cachedPlayers) {
          mergeScrapedIntoPlayer(p, scrapedData[p.steamId]);
        }
        updateRenderer();
      }
    } catch (err) {
      console.log('[CSScrape] Batch error:', err.message);
    } finally {
      csstatsInflight = false;
    }
  })();
}

// ─── Overlay show/hide ──────────────────────────────────────
let settingsPinned = false;

// Three perf modes trade render quality + responsiveness for CPU. Values
// picked empirically — battery stays under ~2% CPU, high matches common
// 60Hz monitors, balanced is the sweet spot for 144Hz gaming without
// noticeably impacting CS2 fps.
const PERF_FPS = { battery: 15, balanced: 30, high: 60 };
const CURSOR_POLL_MS = { battery: 100, balanced: 50, high: 25 };

function getPerfMode() {
  try {
    const m = settings?.load()?.general?.perfMode;
    if (m === 'battery' || m === 'balanced' || m === 'high') return m;
  } catch {}
  return 'balanced';
}
function getPerfFps() { return PERF_FPS[getPerfMode()]; }
function getPerfCursorIntervalMs() { return CURSOR_POLL_MS[getPerfMode()]; }

// SetWindowPos flags for bringing the overlay to HWND_TOPMOST without
// resizing/moving/activating it. Named so we don't repeat the magic number.
const HWND_TOPMOST = -1;
const SWP_TOPMOST_NO_MOVE = 0x0013; // NOSIZE | NOMOVE | NOACTIVATE

// Overlay visibility is the conjunction of "TAB is held" OR "settings is
// pinned open". Used to gate expensive IPC to the renderer — when hidden,
// pushing live stats at 2Hz still forces React to re-render off-screen
// because we disabled backgroundThrottling for live-stats freshness.
// Result was micro-stutter in CS2. Skip the IPC when nobody is looking.
function isOverlayVisible() {
  return tabDown || settingsPinned;
}

function showOverlay() {
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.showInactive();
  // Settings panel owns input-mode while open — flipping to click-through
  // mid-interaction leaves mousedown/mouseup unbalanced and drag state stuck.
  //
  // NOTE: no `forward: true`. Hit-testing is driven by our own GetCursorPos
  // polling + cursor-pos IPC (see renderer onCursorPos handler), so we don't
  // need Electron to forward WM_MOUSEMOVE into the renderer. Forwarding was
  // causing intermittent cursor stalls in CS2 when the main process briefly
  // blocked on puppeteer / koffi calls — queued forwarded events back-pressured
  // Windows' input delivery while the overlay was topmost.
  if (!settingsPinned) {
    win.setIgnoreMouseEvents(true);
  }
  win.webContents.send('overlay-toggle', true);
  // Restore the user's configured frame rate now that we're visible again.
  try { win.webContents.setFrameRate(getPerfFps()); } catch {}
  // Push the freshest cached snapshot so the first frame shown isn't stale
  // from whenever the overlay was last open. We skipped live-stats IPC
  // while hidden, so the renderer may be minutes behind.
  if (lastLiveStats && Object.keys(lastLiveStats).length > 0) {
    try { win.webContents.send('live-stats-update', lastLiveStats); } catch {}
  }

  if (overlayHwnd && SetWindowPos) {
    SetWindowPos(overlayHwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_TOPMOST_NO_MOVE);
  }
}

function hideOverlay() {
  if (!win) return;
  // Don't hide if settings is open — we need the user to be able to interact
  if (settingsPinned) return;
  // Hide the window entirely — zero GPU/CPU cost when not showing
  win.hide();
  win.webContents.send('overlay-toggle', false);
  // Drop render rate to 1fps while hidden. Chrome normally throttles
  // background windows, but we've set backgroundThrottling:false so live
  // stats stay current. Manually slow the renderer instead — CS2 gets
  // the GPU budget back.
  try { win.webContents.setFrameRate(1); } catch {}
}

// ─── Create window ──────────────────────────────────────────
function createWindow() {
  const { createOverlayWindow } = require('./overlay-window');
  const result = createOverlayWindow({
    screen,
    settings,
    applyZoom,
    perfFps: getPerfFps,
    preloadPath: path.join(__dirname, '../../out/preload/preload.js'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFile: path.join(__dirname, '../../out/renderer/index.html'),
    dirname: __dirname,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath || '',
    win32: { SetWindowLongPtrW, GetWindowLongPtrW, SetWindowPos },
    onReady: (hwnd) => { overlayHwnd = hwnd; },
  });
  win = result.win;
  win.on('closed', () => { win = null; });
}

// ─── System tray ────────────────────────────────────────────
function createTray() {
  const { resolveIconPath, resolveTrayIcon } = require('./overlay-window');
  const iconPath = resolveIconPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath || '',
    dirname: __dirname,
  });
  tray = new Tray(resolveTrayIcon({ iconPath }));
  tray.setToolTip('CS2 Stats Overlay');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Settings',
      click: () => {
        if (win) win.webContents.send('show-settings');
      },
    },
    {
      label: 'Re-run Setup',
      click: () => {
        try {
          const s = settings.load();
          s.general = s.general || {};
          s.general.setupComplete = false;
          settings.save(s);
        } catch {}
        app.relaunch();
        app.exit(0);
      },
    },
    {
      label: 'Open User Data Folder',
      click: () => {
        try { shell.openPath(app.getPath('userData')); } catch {}
      },
    },
    {
      label: 'Open Logs',
      click: () => {
        try { shell.openPath(app.getPath('logs')); } catch {}
      },
    },
    { type: 'separator' },
    {
      label: 'GitHub',
      click: () => shell.openExternal('https://github.com/joshblaszczyk/cs2-stats-overlay'),
    },
    {
      label: 'Report Issue',
      click: () => shell.openExternal('https://github.com/joshblaszczyk/cs2-stats-overlay/issues/new'),
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        allowQuit = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// ─── IPC handlers (registered in app.whenReady) ─────────────

// ─── Worker process for API fetching ─────────────────────────
const { fork } = require('child_process');
let worker = null;
let lastSteamIds = [];
let lastMap = '';
let lastTeams = {};
let lastLiveStats = {};
let matchStartTime = null;
let cachedPlayers = null;
let lastFetchTime = 0;
// Incremented on every reset (map change, menu, manual) so in-flight fetch
// results from a prior match can be identified and discarded.
let matchEpoch = 0;

function startWorker() {
  worker = fork(path.join(__dirname, 'fetch-worker.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', USER_DATA_DIR: app.getPath('userData') },
  });

  worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      console.log('[Worker] Ready');
    } else if (msg.type === 'status') {
      // Forward worker service status to renderer
      try {
        const serviceStatus = require('./service-status');
        const changed = serviceStatus.set(msg.service, msg.state);
        if (changed && win) {
          win.webContents.send('service-status', serviceStatus.get());
          console.log(`[Status] ${msg.service} → ${msg.state}`);
        }
      } catch {}
    } else if (msg.type === 'result') {
      // Discard stale results from a previous match (fetch started before reset).
      if (msg.epoch != null && msg.epoch !== matchEpoch) {
        console.log(`[Worker] Discarding stale result epoch=${msg.epoch} current=${matchEpoch}`);
        return;
      }
      const players = msg.players;
      // Re-apply cached scrape results (csstats/csrep/faceit fallbacks) onto
      // the fresh worker output — worker only does steam+leetify+faceit-API.
      for (const p of players) mergeScrapedIntoPlayer(p, scrapedData[p.steamId]);
      cachedPlayers = players;
      if (win) {
        const tagged = players.map(p => ({
          ...p,
          liveStats: lastLiveStats[p.steamId] || null,
        }));
        win.webContents.send('players-update', { players: tagged, map: msg.map });
      }
      console.log(`[Worker] Got ${players.length} players for ${msg.map}`);

      // ── Per-endpoint coverage validation ──
      // If a public-facing endpoint returned zero data across the entire roster,
      // flip its service status to 'down' so the banner tells the user.
      // Steam summary is required to even know names — treat that as the floor.
      try {
        const serviceStatus = require('./service-status');
        const total = players.length;
        if (total > 0) {
          const countSteam = players.filter(p => p.name && p.name !== 'Unknown').length;
          const countFaceit = players.filter(p => p.faceit && p.faceit.level != null).length;
          const countLeetify = players.filter(p => p.leetify && (p.leetify.premier != null || p.leetify.aim != null || p.leetify.leetifyRating != null)).length;
          const countCsstats = players.filter(p => p.csstats && p.csstats.kd != null).length;

          const updates = [];
          if (countSteam === 0) updates.push(['steam', 'down']);
          else if (countSteam > 0) updates.push(['steam', 'ok']);
          // Only flag FACEIT "down" when a key IS configured. Without a key we
          // rely on csstats-scrape → public nickname endpoint, which populates
          // later; re-check runs after that finishes.
          if (countFaceit > 0) updates.push(['faceit', 'ok']);
          else if (process.env.FACEIT_API_KEY) updates.push(['faceit', 'down']);
          if (countLeetify === 0) updates.push(['leetify', 'down']);
          else if (countLeetify > 0) updates.push(['leetify', 'ok']);
          // Don't flip csstats to 'down' here — the scraper owns that state
          // (it has rate-limit + disabled + cooldown semantics the worker can't see).
          if (countCsstats > 0) updates.push(['csstats', 'ok']);

          let anyChanged = false;
          for (const [svc, state] of updates) {
            if (serviceStatus.set(svc, state)) anyChanged = true;
          }
          if (anyChanged && win) {
            win.webContents.send('service-status', serviceStatus.get());
          }
          console.log(`[Worker] Coverage: steam=${countSteam}/${total} faceit=${countFaceit}/${total} leetify=${countLeetify}/${total} csstats=${countCsstats}/${total}`);
        }
      } catch (e) {
        console.log('[Worker] Coverage check failed:', e.message);
      }
    } else if (msg.type === 'error') {
      console.error('[Worker] Error:', msg.message);
    }
  });

  worker.on('error', (err) => {
    console.error('[Worker] Error:', err.message);
  });

  worker.on('exit', (code) => {
    console.log('[Worker] Exited with code', code);
    // Restart worker if it crashes
    setTimeout(() => startWorker(), 1000);
  });
}

let lastFetchedPlayerCount = 0;

function invalidateCachedPlayers() {
  cachedPlayers = null;
  lastFetchTime = 0;
  lastFetchedPlayerCount = 0;
}

function updateRenderer() {
  if (!win || !cachedPlayers) return;
  const t = lastTeams || {};
  const tagged = cachedPlayers.map(p => ({ ...p, team: t[p.steamId] || null }));
  win.webContents.send('players-update', { players: tagged, map: lastMap });
}

function requestFetch(steamIds, map, teams) {
  const now = Date.now();
  const newPlayers = steamIds.length > lastFetchedPlayerCount;
  const stale = now - lastFetchTime >= 2000;
  if (!stale && !newPlayers) return;
  if (!worker || !worker.connected || !steamIds.length) return;
  lastFetchTime = now;
  lastFetchedPlayerCount = steamIds.length;
  console.log(`[Main] Requesting fetch for ${steamIds.length} players on ${map} (epoch ${matchEpoch})`);
  try { worker.send({ type: 'fetch', steamIds, map, teams, epoch: matchEpoch }); }
  catch (err) { console.error('[Main] Worker send failed:', err.message); }
}

// ─── GSI data pipeline ──────────────────────────────────────
function startGSI() {
  installGSIConfig();
  // Strips any legacy autoexec we planted in past installs. No bind needed —
  // TAB is polled via GetAsyncKeyState.
  installConsoleLogging();
  // Launch options used to add -condebug +exec autoexec; not needed anymore.
  // installLaunchOptions() intentionally not called.

  gsiServer = createGSIServer(async ({ steamIds, map, phase: mapPhase, roundPhase, teams, localPlayerTeam, liveStats }) => {
    gsiReceivedData = true;
    if (!isSteamInitialized()) initSteam();

    // Clear cache on map change
    if (map !== lastMap) {
      cachedPlayers = null;
      lastFetchTime = 0;
      matchStartTime = Date.now();
    }
    lastSteamIds = steamIds;
    lastMap = map;
    if (teams) lastTeams = teams;
    if (liveStats) lastLiveStats = liveStats;

    // Kick off csstats scrape for any new IDs. Also runs via a retry interval
    // in case this first call lands mid-round (see scheduleCsstatsRetry below).
    runCsstatsScrape(steamIds, roundPhase);

    requestFetch(steamIds, map, lastTeams);
  }, () => {
    // Merge friends-in-CS2 (filtered to same map via rich presence) with
    // coplay. Friends who are on a different map get excluded automatically.
    const now = Date.now();
    if (coplayCache && now - coplayCacheTime < 10000) return coplayCache;
    // Only include friends when we have an active map — otherwise there's
    // no data to validate against and every friend passes all checks.
    const friends = (lastMap && getFriendsInGame) ? getFriendsInGame(lastMap) : [];
    const coplay = getRecentPlayers ? getRecentPlayers(0) : [];
    const seen = new Set(friends.map(f => f.steamId));
    const merged = [...friends];
    for (const p of coplay) {
      if (!seen.has(p.steamId)) {
        seen.add(p.steamId);
        merged.push(p);
      }
    }
    coplayCache = merged;
    coplayCacheTime = now;
    return merged;
  },
  // Reset callback — clear everything when leaving match or changing map
  (reason, newMap) => {
    matchEpoch++;
    console.log(`[Main] Reset: ${reason}${newMap ? ' → ' + newMap : ''} (epoch ${matchEpoch})`);
    cachedPlayers = null;
    lastSteamIds = [];
    lastMap = newMap || '';
    lastTeams = {};
    lastLiveStats = {};
    lastFetchTime = 0;
    lastFetchedPlayerCount = 0;
    matchStartTime = null;
    coplayCache = null;
    coplayCacheTime = 0;
    clearScrapedState();
    lastKnownRoundPhase = null;
    // Clear the renderer
    if (win) {
      win.webContents.send('players-update', { players: [], map: newMap || '' });
    }
  },
  // Live stats callback — throttled to 2x/sec (was 8x/sec).
  // We ALWAYS keep the latest snapshot in `lastLiveStats` (so showOverlay
  // can push it on TAB press) but only IPC it to the renderer when the
  // overlay is actually visible. Before this gate, CS2 was microstuttering
  // because React kept reconciling 2×/sec in a hidden renderer with
  // backgroundThrottling:false.
  (() => {
    let lastSend = 0;
    return (liveStats) => {
      lastLiveStats = liveStats;
      // Keep round-phase in sync so the csstats retry loop knows when it's
      // safe to scrape (not mid-round). Without this, lastKnownRoundPhase
      // gets stuck on 'live' from the initial onPlayersReady call and the
      // retry loop never fires.
      if (liveStats._roundPhase) lastKnownRoundPhase = liveStats._roundPhase;
      const now = Date.now();
      if (now - lastSend < 500) return; // Max 2 updates/sec to renderer
      lastSend = now;
      if (win && isOverlayVisible()) {
        win.webContents.send('live-stats-update', liveStats);
      }
    };
  })());
}

// ─── Auto-disable fullscreen optimizations for CS2 ──────────
function disableFullscreenOptimizations() {
  const { execFileSync } = require('child_process');
  // Find CS2 exe path
  const cs2Paths = [
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
    'D:\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
    'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
  ];

  for (const cs2Path of cs2Paths) {
    if (!fs.existsSync(cs2Path)) continue;

    // Registry key that disables fullscreen optimizations
    const regPath = `HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers`;
    try {
      // Check if already set
      const result = execFileSync('reg', ['query', regPath, '/v', cs2Path], { encoding: 'utf8' });
      if (result.includes('DISABLEDXMAXIMIZEDWINDOWEDMODE')) {
        console.log('[FSO] Fullscreen optimizations already disabled for CS2');
        return;
      }
    } catch {
      // Key doesn't exist yet
    }

    try {
      execFileSync('reg', ['add', regPath, '/v', cs2Path, '/t', 'REG_SZ', '/d', '~ DISABLEDXMAXIMIZEDWINDOWEDMODE', '/f'], { encoding: 'utf8' });
      console.log('[FSO] Disabled fullscreen optimizations for CS2');
      console.log('[FSO] CS2 restart may be required for this to take effect');
    } catch (err) {
      console.log('[FSO] Could not set registry:', err.message);
    }
    return;
  }
  console.log('[FSO] CS2 exe not found, skipping');
}

// ─── Single instance lock ──────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.log('[Main] Another instance is already running — exiting');
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// ─── App lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
  disableFullscreenOptimizations();
  loadNativeModules();
  startWorker();

  // Puppeteer/Chrome is spawned lazily on the first real scrape. No pre-warm —
  // opening Chrome in the background while the user is in a menu was confusing.

  // All renderer-facing IPC handlers live in src/main/ipc/. Register them
  // in one place so index.js doesn't carry ~350 lines of handler soup.
  // The ctx object wraps our mutable state (win, worker, caches…) as
  // getters so handlers always see current values, not stale snapshots.
  require('./ipc/register').registerAll(ipcMain, {
    settings, applyZoom, screen, app,
    setApiKey, setFaceitKey,
    getPerfFps,
    getWin: () => win,
    getWorker: () => worker,
    getGsiServer: () => gsiServer,
    getLastSteamIds: () => lastSteamIds,
    getLastMap: () => lastMap,
    isTabDown: () => tabDown,
    isSettingsPinned: () => settingsPinned,
    setSettingsPinned: (v) => { settingsPinned = v; },
    clearScrapedState,
    invalidateCachedPlayers,
    bumpMatchEpoch: () => { matchEpoch++; },
  });
  createWindow();
  createTray();

  // Auto-update (packaged only). Fires status events to the renderer.
  try {
    const updater = require('./updater');
    updater.install(win);
  } catch (err) {
    console.log('[Main] Updater init failed:', err.message);
  }

  // Retry loop: every ~8s, if we have players and some haven't been scraped yet
  // and the round phase isn't 'live', kick off a scrape. Handles the case where
  // the GSI fetch callback fires once mid-round and we need to catch up later.
  csstatsRetryInterval = setInterval(() => {
    if (!lastSteamIds || lastSteamIds.length === 0) return;
    const pending = lastSteamIds.filter(id => !scrapedIds.has(id));
    if (pending.length === 0) return;
    console.log(`[CSScrape] Retry loop: ${pending.length} unscraped player(s)`);
    runCsstatsScrape(lastSteamIds, lastKnownRoundPhase);
  }, 8000);

  // TEST MODE preview — TEST_OVERLAY=1 in the env. Dummy roster + live
  // stats are in test-mode.js so they don't bloat the production hot path.
  if (process.env.TEST_OVERLAY) {
    const { runTestMode } = require('./test-mode');
    runTestMode({ win, overlayHwnd, SetWindowLongPtrW, GetWindowLongPtrW });
    return;
  }

  // In setup mode, skip all overlay wiring — relaunch handles the transition
  if (!settings.load()?.general?.setupComplete) {
    console.log('[Main] Setup mode — skipping overlay/GSI/CS2 detection');
    setInterval(() => {}, 60000);
    return;
  }

  startGSI();

  // Scoreboard position (loaded from settings)
  let sbPos = { x: 0, y: 0 };
  const savedSettings = settings.load();
  if (savedSettings?.general?.sbPosX != null) sbPos.x = savedSettings.general.sbPosX;
  if (savedSettings?.general?.sbPosY != null) sbPos.y = savedSettings.general.sbPosY;

  let cs2WasRunning = false;
  let shiftMode = false;

  // TAB polling + cursor hover detection (no Electron event forwarding)
  setInterval(() => {
    if (!GetAsyncKeyState || !win) return;
    // Always poll Tab state so the scoreboard releases correctly even if CS2
    // is backgrounded/alt-tabbed. We just don't show the overlay if no match data.
    if (!cs2WasRunning && !tabDown && !settingsPinned) return;
    const state = GetAsyncKeyState(0x09); // VK_TAB
    const pressed = (state & 0x8000) !== 0;
    if (pressed && !tabDown && cs2WasRunning) {
      tabDown = true;
      showOverlay();
      if (win) win.webContents.send('position-update', sbPos);
      if (cachedPlayers && win) {
        const t = lastTeams || {};
        const tagged = cachedPlayers.map(p => ({
          ...p,
          team: t[p.steamId] || null,
          liveStats: lastLiveStats[p.steamId] || null,
        }));
        win.webContents.send('players-update', { players: tagged, map: lastMap });
      }
    }
    // Send cursor position for hover detection
    if (!pressed && tabDown) {
      tabDown = false;
      hideOverlay();
    }
  }, 200);

  // Cursor polling when Tab is held OR settings is open.
  // Settings needs polling so the close button works in CS2 fullscreen, where
  // the window can't receive real mouse events. Interval reflects perf mode.
  let cursorPollTimer = null;
  let currentCursorInterval = 0;
  // Reuse one buffer across polls — allocating per-tick adds GC pressure to
  // the main loop, which is exactly the hot path we don't want to stall.
  const cursorBuf = Buffer.alloc(8);
  // Last sample sent to the renderer. Used to skip IPC when nothing changed —
  // sending identical cursor-pos 30-60×/s wakes the renderer for no reason
  // and adds main-thread churn that can back up mouse input forwarding.
  let lastCursorX = -1, lastCursorY = -1, lastCursorLmb = false;
  function pollCursor() {
    if (!win || !GetCursorPos) return;
    if (!tabDown && !settingsPinned) return;
    GetCursorPos(cursorBuf);
    const x = cursorBuf.readInt32LE(0);
    const y = cursorBuf.readInt32LE(4);
    const lmb = (GetAsyncKeyState(0x01) & 0x8000) !== 0;
    if (x === lastCursorX && y === lastCursorY && lmb === lastCursorLmb) return;
    lastCursorX = x; lastCursorY = y; lastCursorLmb = lmb;
    try {
      const b = win.getBounds();
      // Cursor coords come in physical pixels. getBoundingClientRect in the
      // renderer returns CSS pixels. With setZoomFactor, physical = CSS * zoom,
      // so divide to stay aligned with DOM hit testing.
      const zoom = win.webContents.getZoomFactor ? (win.webContents.getZoomFactor() || 1) : 1;
      win.webContents.send('cursor-pos', { x: (x - b.x) / zoom, y: (y - b.y) / zoom, lmb });
    } catch {
      win.webContents.send('cursor-pos', { x, y, lmb });
    }
  }
  function ensureCursorPollInterval() {
    const desired = getPerfCursorIntervalMs();
    if (desired === currentCursorInterval && cursorPollTimer) return;
    if (cursorPollTimer) clearInterval(cursorPollTimer);
    currentCursorInterval = desired;
    cursorPollTimer = setInterval(pollCursor, desired);
  }
  ensureCursorPollInterval();
  // Re-check every few seconds so mode changes take effect without restart
  setInterval(ensureCursorPollInterval, 3000);

  // CS2 process detection + overlay display-alignment helpers.
  const { loadUser32, findCS2, applyVirtualScreenBounds } = require('./cs2-window');
  loadUser32(koffi);

  // Debounce window-presence polls — CS2 briefly loses its window during
  // loading screens, alt-tabs, and fullscreen flips. A single miss used to
  // flip state and tear down the GSI server permanently. ~15s of continuous
  // absence (3 polls × 5s) before we commit to "closed".
  let missCount = 0;
  const MISS_THRESHOLD = 3;
  function checkCS2() {
    const hwnd = findCS2();
    const rawRunning = hwnd !== 0;
    if (rawRunning) missCount = 0;
    else missCount++;
    const isRunning = rawRunning || (cs2WasRunning && missCount < MISS_THRESHOLD);
    {
      if (isRunning && !cs2WasRunning) {
        cs2WasRunning = true;
        console.log('[Main] CS2 detected, overlay active');
        applyVirtualScreenBounds(screen, win);
        if (win) {
          win.show();
          win.webContents.send('reset');
        }
        // Re-init Steam if needed
        if (!isSteamInitialized()) initSteam();
        // Check if GSI is receiving data — poll every 30s until it does.
        // Single-shot would let a user-dismissed hint stay dismissed forever
        // even while the overlay is silently broken. Re-nag until CS2 is
        // actually restarted (or user closes CS2 and gives up).
        gsiReceivedData = false;
        if (gsiHintInterval) { clearInterval(gsiHintInterval); gsiHintInterval = null; }
        gsiHintInterval = setInterval(() => {
          if (!cs2WasRunning || gsiReceivedData) {
            clearInterval(gsiHintInterval); gsiHintInterval = null;
            return;
          }
          if (win) {
            win.webContents.send('show-setup-hint', 'Restart CS2 — Game State Integration config only loads at launch');
            console.log('[Main] No GSI data — showing setup hint');
          }
        }, 30000);
      } else if (isRunning && cs2WasRunning) {
        // Still running — re-align overlay if displays changed.
        applyVirtualScreenBounds(screen, win);
      } else if (!isRunning && cs2WasRunning) {
        cs2WasRunning = false;
        console.log('[Main] CS2 closed, hiding overlay (waiting for relaunch...)');
        // Force-unpin and hide — no point holding settings open if game is gone
        if (settingsPinned) {
          settingsPinned = false;
          if (win) win.webContents.send('force-close-settings');
        }
        if (win) win.hide();
        // Release ALL Steam resources so Steam can close freely
        cleanupSteam();
        // Drop dangling HTTP sockets from CS2 so CS2 can exit cleanly, but
        // KEEP the GSI server listening. Destroying + nulling it means no
        // port 3000 listener when CS2 relaunches — GSI data silently lost.
        if (gsiServer && gsiServer.destroyAll) {
          try { gsiServer.destroyAll(); } catch {}
        }
      } else if (!isRunning && !cs2WasRunning) {
        console.log('[Main] Waiting for CS2...');
      }
    }
  }
  // Check immediately, then every 5 seconds
  checkCS2();
  setInterval(checkCS2, 5000);

  // ── Dev perf HUD ──
  let perfHudVisible = false;
  let lastCpuUsage = process.cpuUsage();
  let lastPerfTs = Date.now();
  let lastGsiCount = 0;
  try { lastGsiCount = require('./gsi-server').getGsiMessageCount(); } catch {}
  setInterval(() => {
    const now = Date.now();
    const elapsedMs = now - lastPerfTs;
    const cpuDelta = process.cpuUsage(lastCpuUsage);
    lastCpuUsage = process.cpuUsage();
    lastPerfTs = now;
    const cpuPct = elapsedMs > 0
      ? ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000)) * 100
      : 0;
    const rssMB = process.memoryUsage().rss / (1024 * 1024);
    let curGsi = lastGsiCount;
    try { curGsi = require('./gsi-server').getGsiMessageCount(); } catch {}
    const gsiPerSec = elapsedMs > 0
      ? ((curGsi - lastGsiCount) / (elapsedMs / 1000))
      : 0;
    lastGsiCount = curGsi;
    if (win && !win.isDestroyed()) {
      win.webContents.send('perf-metrics', {
        rssMB: Math.round(rssMB * 10) / 10,
        cpuPct: Math.round(cpuPct * 10) / 10,
        gsiPerSec: Math.round(gsiPerSec * 10) / 10,
      });
    }
  }, 1000);

  try {
    globalShortcut.register('Control+Shift+P', () => {
      perfHudVisible = !perfHudVisible;
      if (win && !win.isDestroyed()) {
        win.webContents.send('perf-hud-toggle', perfHudVisible);
      }
    });
  } catch (err) {
    console.log('[PerfHUD] shortcut register failed:', err.message);
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit — stay in tray waiting for CS2
  // On Windows, Electron quits by default when all windows close.
  // We prevent that by simply not calling app.quit() here.
});

let allowQuit = false;
app.on('before-quit', (e) => {
  if (!allowQuit) {
    e.preventDefault();
    return;
  }
  console.log('[Main] Quitting — cleaning up everything...');
  cleanupSteam();
  try { const { shutdownScraper } = require('./csstats-scraper'); shutdownScraper(); } catch {}
  if (tray) { tray.destroy(); tray = null; }
  if (worker && worker.connected) { try { worker.kill(); } catch {} }
  if (gsiServer) {
    try {
      if (gsiServer.destroyAll) gsiServer.destroyAll();
      gsiServer.close();
    } catch {}
    gsiServer = null;
  }
  // Force exit after short delay to release all native handles
  setTimeout(() => {
    console.log('[Main] Force exit');
    process.exit(0);
  }, 500);
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
});
