const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Forward uncaught renderer errors + rejections to main's file logger.
try {
  const send = (level, args) => {
    try { ipcRenderer.send('log-renderer', { level, args }); } catch {}
  };
  window.addEventListener('error', (e) => {
    send('ERROR', [`window.onerror: ${e.message}`, e.error?.stack || '']);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = r instanceof Error ? `${r.message}\n${r.stack}` : String(r);
    send('ERROR', [`unhandledrejection: ${msg}`]);
  });
} catch {}

contextBridge.exposeInMainWorld('cs2stats', {
  onPlayersUpdate: (callback) =>
    ipcRenderer.on('players-update', (_e, data) => callback(data)),
  onLiveStatsUpdate: (callback) =>
    ipcRenderer.on('live-stats-update', (_e, liveStats) => callback(liveStats)),
  onOverlayToggle: (callback) =>
    ipcRenderer.on('overlay-toggle', (_e, visible) => callback(visible)),
  onPositionUpdate: (callback) =>
    ipcRenderer.on('position-update', (_e, pos) => callback(pos)),
  setClickThrough: (enabled) => ipcRenderer.send('set-click-through', enabled),
  savePosition: (pos) => ipcRenderer.send('save-position', pos),
  onShowSettings: (callback) =>
    ipcRenderer.on('show-settings', () => callback()),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  onSetupHint: (callback) =>
    ipcRenderer.on('show-setup-hint', (_e, msg) => callback(msg)),
  onCursorPos: (callback) =>
    ipcRenderer.on('cursor-pos', (_e, pos) => callback(pos)),
  onServiceStatus: (callback) =>
    ipcRenderer.on('service-status', (_e, status) => callback(status)),
  getServiceStatus: () => ipcRenderer.invoke('get-service-status'),
  saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),
  validateApiKeys: (keys) => ipcRenderer.invoke('validate-api-keys', keys),
  loginCsstats: () => ipcRenderer.invoke('login-csstats'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  exportBugReport: () => ipcRenderer.invoke('export-bug-report'),
  completeSetup: () => ipcRenderer.invoke('setup-complete'),
  quitApp: () => ipcRenderer.send('quit-app'),
  onPerfMetrics: (cb) => ipcRenderer.on('perf-metrics', (_e, m) => cb(m)),
  onPerfHudToggle: (cb) => ipcRenderer.on('perf-hud-toggle', (_e, v) => cb(v)),
  // Settings panel actions
  getKeyStatus: () => ipcRenderer.invoke('get-key-status'),
  clearApiKey: (which) => ipcRenderer.invoke('clear-api-key', which),
  clearCsstatsSession: () => ipcRenderer.invoke('clear-csstats-session'),
  clearPlayerCache: () => ipcRenderer.invoke('clear-player-cache'),
  resetQueue: () => ipcRenderer.invoke('reset-queue'),
  getCsstatsStatus: () => ipcRenderer.invoke('get-csstats-status'),
  resetSbPosition: () => ipcRenderer.invoke('reset-sb-position'),
  resetAllSettings: () => ipcRenderer.invoke('reset-all-settings'),
  openUserDataFolder: () => ipcRenderer.invoke('open-user-data-folder'),
  openLogsFolder: () => ipcRenderer.invoke('open-logs-folder'),
  reRunSetup: () => ipcRenderer.invoke('re-run-setup'),
  uninstall: () => ipcRenderer.invoke('uninstall'),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  dbgLog: (msg) => ipcRenderer.send('dbg-log', msg),
  logRenderer: (entry) => ipcRenderer.send('log-renderer', entry),
  // Auto-update
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  getUpdateStatus: () => ipcRenderer.invoke('update-status'),
  checkForUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.send('update-install'),
  setSettingsPin: (pinned) => ipcRenderer.send('settings-pin', pinned),
  previewOpacity: (val) => ipcRenderer.send('preview-opacity', val),
  previewFontScale: (val) => ipcRenderer.send('preview-font-scale', val),
  onZoomChanged: (cb) => ipcRenderer.on('zoom-changed', (_e, zoom) => cb(zoom)),
  getZoomFactor: () => { try { return webFrame.getZoomFactor(); } catch { return 1; } },
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onForceCloseSettings: (cb) => ipcRenderer.on('force-close-settings', () => cb()),
});
