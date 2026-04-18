// IPC: overlay window behavior — opacity, font scale, position, pinning,
// click-through. Each handler is a thin translation from renderer intent
// to a BrowserWindow API call, with clamping/validation on the boundary.

// Scoreboard position — clamped to a wide range so users can park the
// window offscreen temporarily but not lose it to infinity.
const POSITION_CLAMP = 5000;

// Opacity clamp mirrors save-settings; 10 is the lowest-still-visible.
function clampOpacity(n) {
  return Math.max(10, Math.min(100, n));
}

function registerWindowHandlers(ipcMain, ctx) {
  const { settings, applyZoom, screen } = ctx;

  ipcMain.on('preview-opacity', (_e, val) => {
    const win = ctx.getWin();
    if (!win) return;
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    win.setOpacity(clampOpacity(n) / 100);
  });

  ipcMain.on('preview-font-scale', (_e, val) => {
    const win = ctx.getWin();
    if (!win) return;
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    try { applyZoom(screen, win, { fontScale: n }); } catch {}
  });

  ipcMain.on('save-position', (_e, pos) => {
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const clampedX = Math.max(-POSITION_CLAMP, Math.min(POSITION_CLAMP, x));
    const clampedY = Math.max(-POSITION_CLAMP, Math.min(POSITION_CLAMP, y));
    const s = settings.load();
    s.general = s.general || {};
    s.general.sbPosX = clampedX;
    s.general.sbPosY = clampedY;
    settings.save(s);
  });

  ipcMain.handle('reset-sb-position', () => {
    const s = settings.load();
    s.general = s.general || {};
    delete s.general.sbPosX;
    delete s.general.sbPosY;
    settings.save(s);
    const win = ctx.getWin();
    if (win) win.webContents.send('position-update', { x: 0, y: 0 });
    console.log('[Settings] Scoreboard position reset');
    return true;
  });

  ipcMain.on('set-click-through', (_e, enabled) => {
    const win = ctx.getWin();
    if (!win) return;
    if (enabled) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  // Settings pin toggle — while pinned the overlay is fully interactive and
  // visible regardless of CS2 focus. Needed because the settings UI has
  // form inputs, dropdowns, etc. that can't live with click-through.
  ipcMain.on('settings-pin', (_e, pinned) => {
    ctx.setSettingsPinned(!!pinned);
    const win = ctx.getWin();
    if (!win) return;

    // In setup mode the overlay machinery is dormant — ignore pin events
    // so the setup wizard window doesn't get forced click-through mid-run.
    if (!settings.load()?.general?.setupComplete) return;

    if (pinned) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.showInactive();
      win.setIgnoreMouseEvents(false);
      win.focus();
      console.log('[Main] Settings pinned — overlay interactive');
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      // If TAB isn't held, the user's done — hide overlay.
      if (!ctx.isTabDown()) {
        win.hide();
        win.webContents.send('overlay-toggle', false);
      }
      console.log('[Main] Settings unpinned');
    }
  });
}

module.exports = { registerWindowHandlers };
