// IPC: app-lifecycle actions — state resets, setup re-entry, uninstall,
// quit. Each of these changes or tears down significant runtime state,
// which is why they live together.

const path = require('path');
const fs = require('fs');

function registerLifecycleHandlers(ipcMain, ctx) {
  const { settings, app } = ctx;

  // Manual "forget everything" — wipes the scraped-cache in memory and
  // asks gsi-server to reset its per-match state. Falls back to clearing
  // just the main-side state if gsiServer isn't up yet.
  ipcMain.handle('reset-queue', () => {
    try {
      console.log('[Main] Manual queue reset requested');
      ctx.clearScrapedState();
      const gsiServer = ctx.getGsiServer();
      if (gsiServer && gsiServer.resetState) {
        gsiServer.resetState('manual');
      } else {
        ctx.bumpMatchEpoch();
        ctx.invalidateCachedPlayers();
        const win = ctx.getWin();
        if (win) {
          win.webContents.send('players-update', {
            players: [], map: ctx.getLastMap() || '',
          });
        }
      }
      return true;
    } catch (err) {
      console.log('[Main] reset-queue failed:', err.message);
      return false;
    }
  });

  ipcMain.handle('clear-player-cache', () => {
    try {
      const cachePath = path.join(app.getPath('userData'), 'player-cache.json');
      if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
      ctx.clearScrapedState();
      console.log('[Settings] Player cache cleared');
      return true;
    } catch (err) {
      console.log('[Settings] clear-player-cache failed:', err.message);
      return false;
    }
  });

  // Hard reset: delete settings.json then restart. Ensures a genuinely
  // fresh boot — in-memory state, registered Run key, etc. get re-derived
  // from scratch through the setup wizard on next launch.
  ipcMain.handle('reset-all-settings', () => {
    try {
      const p = path.join(app.getPath('userData'), 'settings.json');
      if (fs.existsSync(p)) fs.unlinkSync(p);
      console.log('[Settings] All settings reset — relaunching');
      app.relaunch();
      app.exit(0);
      return true;
    } catch (err) {
      console.log('[Settings] reset-all-settings failed:', err.message);
      return false;
    }
  });

  ipcMain.handle('re-run-setup', () => {
    const s = settings.load();
    s.general = s.general || {};
    s.general.setupComplete = false;
    settings.save(s);
    console.log('[Settings] Re-run setup — relaunching');
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle('setup-complete', () => {
    const s = settings.load();
    s.general = s.general || {};
    s.general.setupComplete = true;
    settings.save(s);
    console.log('[Main] Setup complete — relaunching into overlay mode');
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('uninstall', async () => {
    const { runUninstall } = require('../uninstall-flow');
    return runUninstall(ctx.getWin());
  });

  // Renderer-triggered quit. We destroy the window synchronously so that
  // the "before-quit" handler's cleanup runs with no renderer attached,
  // then force-exit to release native handles (Steam SDK, koffi, tray).
  ipcMain.on('quit-app', () => {
    const win = ctx.getWin();
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    app.exit(0);
  });
}

module.exports = { registerLifecycleHandlers };
