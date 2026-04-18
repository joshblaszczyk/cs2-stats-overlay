// User-initiated uninstall: confirmation dialog, tear down all footprints
// the app left on the system (GSI config, auto-launch Run key, user-data
// directory), then quit.
//
// The .exe itself is removed by the NSIS installer's separate Uninstall.exe
// — this flow runs from inside the live overlay before that happens, so
// that the app can clean up its own state while it's still running.

const { app, dialog } = require('electron');
const fs = require('fs');

const QUIT_DELAY_MS = 200; // give the IPC response time to flush first

function confirm(win) {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Cancel', 'Uninstall'],
    defaultId: 0,
    cancelId: 0,
    title: 'Uninstall CS2 Stats Overlay',
    message: 'This will remove the GSI config, autoexec bind, CS2 launch options, auto-launch entry, and delete app data. The app will then quit.',
  });
  return choice === 1;
}

// Best-effort recursive delete — the user-data dir may have files locked by
// Chromium (DIPS, Network cookies) but we don't want to fail the whole flow
// just because rm -rf couldn't fully succeed.
function deleteUserData() {
  const userData = app.getPath('userData');
  try {
    fs.rmSync(userData, { recursive: true, force: true });
  } catch (e) {
    console.log('[Uninstall] rm failed:', userData, e.message);
  }
}

// Run the full uninstall. Resolves with { ok, gsi?, cancelled? } so the
// caller can surface failures. On success the process exits via app.exit
// after a short delay.
async function runUninstall(win) {
  try {
    if (!confirm(win)) return { ok: false, cancelled: true };

    const { uninstallGSIConfig } = require('./gsi-config');
    const gsiResult = uninstallGSIConfig();

    try { app.setLoginItemSettings({ openAtLogin: false }); } catch {}

    setTimeout(() => {
      deleteUserData();
      app.exit(0);
    }, QUIT_DELAY_MS);

    return { ok: true, gsi: gsiResult };
  } catch (err) {
    console.log('[Uninstall] failed:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { runUninstall };
