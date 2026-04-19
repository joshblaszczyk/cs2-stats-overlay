// IPC: read-only inspection + external links + auto-updater + logs.
// Handlers here don't mutate app state — they surface existing state to
// the renderer or punt the user out to the OS (folders, browser).

const { shell, clipboard } = require('electron');

// Build marker — bump on every release so we can visually confirm an
// auto-update actually replaced the installed binary. Shown in Settings
// → About next to the version string. The convention: `<version>-<tag>`
// where `<tag>` is a short human label describing this build (not just
// the version, so a user with stale cache or confused install can tell
// at a glance which build they're looking at).
const BUILD_TAG = 'v0.1.9-silent-update';

function registerDiagnosticsHandlers(ipcMain, ctx) {
  const { app } = ctx;

  ipcMain.handle('get-app-info', () => ({
    version: app.getVersion(),
    buildTag: BUILD_TAG,
    electronVersion: process.versions.electron,
    userDataPath: app.getPath('userData'),
    logsPath: app.getPath('logs'),
    platform: process.platform,
  }));

  ipcMain.handle('get-service-status', () => {
    try { return require('../service-status').get(); }
    catch { return {}; }
  });

  // Probe: actually try to scrape the local player to distinguish "csstats
  // is fine" from "silent failure". If the module already knows it's in
  // cooldown, trust that state and skip the probe.
  ipcMain.handle('get-csstats-status', async () => {
    try {
      const scraper = require('../csstats-scraper');
      const base = scraper.getCsstatsStatus ? scraper.getCsstatsStatus() : {};
      if (base.rateLimited) return { ...base, probed: false };

      const lastSteamIds = ctx.getLastSteamIds();
      const probeId = lastSteamIds?.[0];
      if (!probeId) {
        return { ...base, probed: false, unknown: true, message: 'No local player yet' };
      }

      let data = null;
      try {
        const b = await scraper.ensureBrowser();
        const page = await b.newPage();
        try {
          data = await scraper.scrapePlayer(probeId, page);
        } finally {
          try { await page.close(); } catch {}
        }
        console.log('[CSProbe] steamId=%s keys=%j data=%j', probeId,
          data ? Object.keys(data) : null,
          data ? JSON.stringify(data).slice(0, 600) : null);
      } catch (err) {
        // RateLimitedError bubble from ensureBrowser / newPage.
        const isRL = err && (err.name === 'RateLimitedError' || /rate.?limit|1015|cloudflare/i.test(err.message || ''));
        return {
          ...scraper.getCsstatsStatus(),
          probed: true,
          rateLimited: isRL || base.rateLimited,
          error: err.message,
        };
      }

      // Probe passes if ANY meaningful field came back — a fully private
      // profile would still be "csstats is fine, this player is private".
      const ok = data && (data.kd != null || data.premier != null || data.faceitLevel != null);
      const after = scraper.getCsstatsStatus ? scraper.getCsstatsStatus() : base;
      return { ...after, probed: true, rateLimited: after.rateLimited || !ok, probeOk: ok, probeId };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('export-bug-report', async () => {
    try {
      const { exportBugReport } = require('../sanitize');
      const result = await exportBugReport();
      // Open the folder so the user can attach it to their bug report.
      try { shell.openPath(result.reportDir); } catch {}
      return { ok: true, ...result };
    } catch (err) {
      console.error('[BugReport] Export failed:', err.message);
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle('read-clipboard', () => {
    try { return clipboard.readText() || ''; }
    catch { return ''; }
  });

  ipcMain.handle('open-user-data-folder', () => {
    try { shell.openPath(app.getPath('userData')); return true; }
    catch { return false; }
  });

  ipcMain.handle('open-logs-folder', () => {
    try { shell.openPath(app.getPath('logs')); return true; }
    catch { return false; }
  });

  // Renderer debug breadcrumbs. Both go through logger so the file log
  // stays complete — useful for bug reports.
  ipcMain.on('dbg-log', (_e, msg) => { console.log(`[RenderDbg] ${msg}`); });
  ipcMain.on('log-renderer', (_e, entry) => {
    try { require('../logger').logFromRenderer(entry); } catch {}
  });

  // Link safety: only whitelist http(s) URLs so a malicious message can't
  // shell.openExternal a `file://` or `javascript:` payload.
  ipcMain.on('open-external', (_e, url) => {
    try {
      if (typeof url !== 'string') return;
      if (!url.startsWith('https://') && !url.startsWith('http://')) return;
      shell.openExternal(url);
    } catch {}
  });

  // ── Auto-updater bridge ────────────────────────────────────
  ipcMain.handle('update-check', async () => {
    try { const { checkNow } = require('../updater'); await checkNow(); return true; }
    catch (err) { return { error: err.message }; }
  });
  ipcMain.handle('update-status', () => {
    try { return require('../updater').getLastPhase() || null; }
    catch { return null; }
  });
  ipcMain.on('update-install', () => {
    try { require('../updater').quitAndInstall(); } catch {}
  });
}

module.exports = { registerDiagnosticsHandlers };
