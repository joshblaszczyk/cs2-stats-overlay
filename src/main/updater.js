// Auto-update via electron-updater. Polls GitHub Releases (configured in
// package.json build.publish) on startup and every hour thereafter. Pushes
// progress/status events to the renderer via 'update-status' IPC.
//
// States emitted:
//   { phase: 'checking' }
//   { phase: 'available', version }
//   { phase: 'not-available' }
//   { phase: 'downloading', percent, bytesPerSecond }
//   { phase: 'downloaded', version }
//   { phase: 'error', message }

const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

let mainWin = null;
let lastPhase = null;

function send(status) {
  lastPhase = status;
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('update-status', status);
    }
  } catch {}
}

function install(win) {
  mainWin = win;

  // Dev builds don't carry a valid version header — don't spam GitHub.
  if (!app.isPackaged) {
    console.log('[Updater] Skipped (dev build)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => console.log('[Updater]', m),
    warn: (m) => console.warn('[Updater]', m),
    error: (m) => console.error('[Updater]', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => send({ phase: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ phase: 'available', version: info?.version }));
  autoUpdater.on('update-not-available', () => send({ phase: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send({
    phase: 'downloading',
    percent: Math.round(p.percent || 0),
    bytesPerSecond: p.bytesPerSecond || 0,
  }));
  autoUpdater.on('update-downloaded', (info) => {
    send({ phase: 'downloaded', version: info?.version });
    // All user state lives on disk (settings.json, csstats-cache.json,
    // etc.) so there's no in-memory cost to quitting immediately.
    // The 1.5s delay gives the renderer a moment to paint "Restarting…"
    // before the process dies, and absorbs any last IPC chatter.
    //
    // isSilent=true:        pass /S to the NSIS installer so the
    //                       assisted-install dialog does NOT pop up
    //                       during an auto-update. (It still pops up
    //                       for first-time installs because the user
    //                       downloads and runs the installer directly
    //                       in that flow; oneClick:false only governs
    //                       that case.)
    // isForceRunAfter=true: relaunch the app after install completes.
    setTimeout(() => {
      console.log('[Updater] Auto-restarting to apply update (silent)');
      try { autoUpdater.quitAndInstall(true, true); }
      catch (err) { console.log('[Updater] quitAndInstall failed:', err.message); }
    }, 1500);
  });
  autoUpdater.on('error', (err) => send({ phase: 'error', message: err?.message || String(err) }));

  // First check after a short delay so startup is not blocked.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.log('[Updater] Check failed:', e.message));
  }, 8000);

  // Re-check hourly.
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 60 * 60 * 1000);
}

function quitAndInstall() {
  try {
    autoUpdater.quitAndInstall(true, true); // silent install, relaunch after
  } catch (err) {
    console.log('[Updater] quitAndInstall failed:', err.message);
  }
}

function checkNow() {
  if (!app.isPackaged) {
    send({ phase: 'not-available' });
    return;
  }
  return autoUpdater.checkForUpdates().catch((e) => {
    send({ phase: 'error', message: e.message });
  });
}

function getLastPhase() { return lastPhase; }

module.exports = { install, quitAndInstall, checkNow, getLastPhase };
