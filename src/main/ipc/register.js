// Central registration for all renderer-facing IPC handlers.
//
// index.js builds a `ctx` object describing its mutable state (the live
// BrowserWindow, worker subprocess, cache tables, perf-mode getters,
// etc.) as getters/setters, then calls registerAll(ipcMain, ctx). Each
// sub-module only uses the slice of ctx it actually needs — the object
// is passed by reference so getters always see the current value, not
// a stale snapshot from the boot sequence.

const { registerSettingsHandlers }    = require('./settings-handlers');
const { registerWindowHandlers }      = require('./window-handlers');
const { registerDiagnosticsHandlers } = require('./diagnostics-handlers');
const { registerLifecycleHandlers }   = require('./lifecycle-handlers');

function registerAll(ipcMain, ctx) {
  registerSettingsHandlers(ipcMain, ctx);
  registerWindowHandlers(ipcMain, ctx);
  registerDiagnosticsHandlers(ipcMain, ctx);
  registerLifecycleHandlers(ipcMain, ctx);
}

module.exports = { registerAll };
