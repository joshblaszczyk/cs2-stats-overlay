// IPC: settings + API keys + csstats login.
//
// All handlers in here operate on persisted user configuration. They run
// on the main process and are reached by the renderer via preload.js.
// Keeping them in one file makes the full set of writable settings
// surfaces easy to audit (search for `ipcMain.handle`).

const path = require('path');
const fs = require('fs');

// Top-level settings keys the renderer is allowed to write. Anything else
// sent to save-settings is silently dropped so a compromised renderer
// can't, e.g., overwrite apiKeys by posting a whole settings object.
const WRITABLE_SETTINGS_KEYS = ['tabView', 'hoverDetail', 'general'];

// Prototype-pollution sinks that must never reach settings.save().
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

// Cap an input string to a reasonable length + trim whitespace.
function cleanKey(v) { return String(v || '').trim().slice(0, 200); }

// Opacity guard — the UI slider runs 10..100, but don't trust the input.
// Landing on anything < 10 would make the overlay effectively invisible.
function clampOpacity(v, fallback = 88) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(10, Math.min(100, Math.round(n))) : fallback;
}

// Render a key as "••••last4" for display. Short or missing keys collapse
// to a fixed placeholder so the renderer never sees their length.
function maskKey(k) {
  if (!k || typeof k !== 'string') return null;
  if (k.length <= 8) return '••••';
  return '••••' + k.slice(-4);
}

function registerSettingsHandlers(ipcMain, ctx) {
  const { settings, applyZoom, screen, app, setApiKey, setFaceitKey } = ctx;

  ipcMain.handle('get-settings', () => settings.load());

  ipcMain.handle('save-settings', (_e, data) => {
    const current = settings.load();
    if (data && typeof data === 'object') {
      for (const k of Object.keys(data)) {
        if (FORBIDDEN_KEYS.includes(k)) continue;
        if (!WRITABLE_SETTINGS_KEYS.includes(k)) continue;
        current[k] = data[k];
      }
    }
    if (current?.general?.opacity != null) {
      current.general.opacity = clampOpacity(current.general.opacity);
    }
    settings.save(current);

    const win = ctx.getWin();
    if (win && current?.general?.opacity != null) {
      win.setOpacity(current.general.opacity / 100);
    }
    if (win) {
      // Apply perf-mode changes live so the user sees them without reboot.
      try { win.webContents.setFrameRate(ctx.getPerfFps()); } catch {}
    }
    // fontScale change triggers a zoom recalc that also emits zoom-changed
    // so the renderer can rescale any pinned positions.
    try { applyZoom(screen, win, { fontScale: current?.general?.fontScale }); } catch {}
    return true;
  });

  ipcMain.handle('save-api-keys', (_e, keys) => {
    const clean = {
      steam:    cleanKey(keys?.steam),
      faceit:   cleanKey(keys?.faceit),
      leetify:  cleanKey(keys?.leetify),
      leetify2: cleanKey(keys?.leetify2),
    };
    const s = settings.load();
    s.apiKeys = { ...s.apiKeys, ...clean };
    settings.save(s);

    // Mirror into process.env so anything reading env (main + future
    // code) picks the new keys up immediately.
    if (clean.steam)    process.env.STEAM_API_KEY    = clean.steam;
    if (clean.faceit)   process.env.FACEIT_API_KEY   = clean.faceit;
    if (clean.leetify)  process.env.LEETIFY_API_KEY  = clean.leetify;
    if (clean.leetify2) process.env.LEETIFY_API_KEY_2 = clean.leetify2;

    // Propagate to live module state. process.env mutation doesn't reach
    // the worker subprocess — send an IPC message instead.
    try { if (clean.steam  && setApiKey)    setApiKey(clean.steam); } catch {}
    try { if (clean.faceit && setFaceitKey) setFaceitKey(clean.faceit); } catch {}
    try {
      const worker = ctx.getWorker();
      if (worker && worker.connected) {
        if (clean.steam) worker.send({ type: 'set-api-key', key: clean.steam });
        worker.send({ type: 'clear-cache' });
      }
    } catch {}

    // Invalidate cached roster so the next match re-fetches with new keys.
    ctx.invalidateCachedPlayers();
    console.log('[Setup] API keys saved + propagated to worker');
    return true;
  });

  ipcMain.handle('validate-api-keys', async (_e, keys) => {
    const { validateApiKeys } = require('../api-validators');
    return validateApiKeys(keys);
  });

  ipcMain.handle('login-csstats', async () => {
    try {
      const { loginToCsstats } = require('../scrape-client');
      return await loginToCsstats();
    } catch (err) {
      console.log('[Setup] csstats login error:', err.message);
      return { success: false, verified: false, reason: err.message };
    }
  });

  ipcMain.handle('get-key-status', () => {
    const s = settings.load();
    const ak = s?.apiKeys || {};
    // csstats "connection" is inferred from the presence of a cookies DB
    // in the scraper's user data dir — if the file exists, a prior login
    // flow completed successfully.
    const csstatsCookies = path.join(
      app.getPath('userData'), 'browser-data', 'Default', 'Network', 'Cookies'
    );
    return {
      steam:    { set: !!ak.steam,    masked: maskKey(ak.steam) },
      faceit:   { set: !!ak.faceit,   masked: maskKey(ak.faceit) },
      leetify:  { set: !!ak.leetify,  masked: maskKey(ak.leetify) },
      leetify2: { set: !!ak.leetify2, masked: maskKey(ak.leetify2) },
      csstats:  { connected: fs.existsSync(csstatsCookies) },
    };
  });

  ipcMain.handle('clear-api-key', (_e, which) => {
    const ALLOWED = ['steam', 'faceit', 'leetify', 'leetify2'];
    if (!ALLOWED.includes(which)) return false;
    const s = settings.load();
    s.apiKeys = { ...s.apiKeys, [which]: '' };
    settings.save(s);
    // Also wipe from process env so any in-flight fetches stop using it.
    const envMap = {
      steam:    'STEAM_API_KEY',
      faceit:   'FACEIT_API_KEY',
      leetify:  'LEETIFY_API_KEY',
      leetify2: 'LEETIFY_API_KEY_2',
    };
    delete process.env[envMap[which]];
    console.log(`[Settings] Cleared API key: ${which}`);
    return true;
  });

  ipcMain.handle('clear-csstats-session', async () => {
    try {
      const { shutdownScraper } = require('../scrape-client');
      if (shutdownScraper) await shutdownScraper();
      const bdir = path.join(app.getPath('userData'), 'browser-data');
      if (fs.existsSync(bdir)) fs.rmSync(bdir, { recursive: true, force: true });
      console.log('[Settings] csstats browser session cleared');
      return true;
    } catch (err) {
      console.log('[Settings] clear-csstats-session failed:', err.message);
      return false;
    }
  });

  ipcMain.handle('get-auto-launch', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('set-auto-launch', (_e, enabled) => {
    // In dev, the Run key would register bare electron.exe (no app path) —
    // enabling would make Windows boot into Electron's default welcome
    // screen on every login. Silently refuse instead.
    if (!app.isPackaged && enabled) return false;
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
}

module.exports = { registerSettingsHandlers };
