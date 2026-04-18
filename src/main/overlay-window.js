// Overlay BrowserWindow factory. Extracted from index.js so the window's
// setup is in one readable place instead of being intermixed with IPC,
// polling, and scraper orchestration.
//
// Two modes, differentiated by settings.general.setupComplete:
//   Setup mode   — a regular centered 520×680 window for the first-run
//                  wizard. Normal backgrounds, movable, no transparency.
//   Overlay mode — borderless + transparent, covers the virtual screen, and
//                  uses WS_EX_LAYERED + WS_EX_TRANSPARENT + WS_EX_NOACTIVATE
//                  win32 flags so it floats above fullscreen games without
//                  stealing input or appearing in the taskbar.

const { BrowserWindow, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const SETUP_WINDOW_W = 520;
const SETUP_WINDOW_H = 680;

// WS_EX_* constants. Declared so magic-number soup in the win32 call below
// is at least self-documenting.
const GWL_EXSTYLE        = -20;
const WS_EX_TRANSPARENT  = 0x20;
const WS_EX_LAYERED      = 0x80000;
const WS_EX_NOACTIVATE   = 0x8000000;
const WS_EX_TOOLWINDOW   = 0x80;
const WS_EX_TOPMOST      = 0x8;
const HWND_TOPMOST       = -1;
const SWP_NOSIZE         = 0x0001;
const SWP_NOMOVE         = 0x0002;
const SWP_NOACTIVATE     = 0x0010;
const SWP_SHOWWINDOW     = 0x0040;
const SWP_INITIAL_FLAGS  = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_SHOWWINDOW;

// CSP allows inline styles (needed by React inline style props) and external
// https for images + APIs. Scripts restricted to same-origin to make XSS
// through injected markdown / profile-name fields impossible.
const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data:;";

// Find an icon file in any of the common locations (dev, asar-unpacked, or
// installed resources). Returns null if none exist.
function resolveIconPath({ appPath, resourcesPath, dirname }) {
  const candidates = [
    path.join(dirname, '../../build/icon.ico'),
    path.join(dirname, '../../build/icon.png'),
    path.join(resourcesPath || '', 'build/icon.ico'),
    path.join(resourcesPath || '', 'build/icon.png'),
    path.join(appPath, 'build/icon.ico'),
    path.join(appPath, 'build/icon.png'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

// Resolve a 16x16 nativeImage for the tray, falling back to a solid-fill
// placeholder if no icon file is reachable (the tray API rejects empty
// images on Windows).
function resolveTrayIcon({ iconPath }) {
  let icon;
  if (iconPath) {
    icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });
  }
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0xff), { width: 16, height: 16 });
  }
  return icon;
}

// Build BrowserWindow constructor options. The window fills the display
// under the cursor in overlay mode (so a multi-monitor setup still lands on
// the monitor the user invoked the app from) and centers a compact window
// in setup mode.
function buildWindowOptions({ screen, setupMode, iconPath, preloadPath }) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.bounds;
  const setupX = Math.round(x + (width - SETUP_WINDOW_W) / 2);
  const setupY = Math.round(y + (height - SETUP_WINDOW_H) / 2);

  return {
    x: setupMode ? setupX : x,
    y: setupMode ? setupY : y,
    width: setupMode ? SETUP_WINDOW_W : width,
    height: setupMode ? SETUP_WINDOW_H : height,
    transparent: !setupMode,
    backgroundColor: setupMode ? '#0a0c10' : '#00000000',
    frame: false,
    skipTaskbar: !setupMode,
    show: false,
    resizable: false,
    movable: setupMode,
    focusable: true,
    paintWhenInitiallyHidden: setupMode,
    icon: iconPath || undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      offscreen: false,
    },
  };
}

// Wire the clipboard shortcuts. Without an application menu Electron doesn't
// dispatch Ctrl+C/V/X/A/Z as accelerators, so we intercept at webContents
// level and call the corresponding editing command explicitly.
function wireClipboardShortcuts(win) {
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const k = (input.key || '').toLowerCase();
    const actions = { v: 'paste', c: 'copy', x: 'cut', a: 'selectAll', z: 'undo' };
    const action = actions[k];
    if (!action) return;
    win.webContents[action]();
    _e.preventDefault();
  });

  // Right-click menu on editable fields so users can paste via mouse too.
  win.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { type: 'separator' }, { role: 'selectAll' },
    ]).popup({ window: win });
  });
}

// Apply the win32 exstyle flags that make the overlay click-through and
// invisible to alt-tab/taskbar. Returns the HWND (as a regular Number) so
// the caller can keep it for later SetWindowPos calls. No-op if the win32
// shims aren't available (non-Windows dev, or koffi load failure).
function applyOverlayWin32Styles(win, { SetWindowLongPtrW, GetWindowLongPtrW, SetWindowPos }) {
  if (!SetWindowLongPtrW || !GetWindowLongPtrW) return null;
  const hwndBuf = win.getNativeWindowHandle();
  const hwnd = process.arch === 'x64'
    ? Number(hwndBuf.readBigUInt64LE(0))
    : hwndBuf.readUInt32LE(0);
  const exStyle = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE,
    exStyle | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE);
  SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_INITIAL_FLAGS);
  return hwnd;
}

// Create the overlay BrowserWindow and return { win, getOverlayHwnd }.
// setupMode is read from settings once at window-creation time — the window
// is destroyed + recreated on re-run-setup, which is how mode flips happen.
function createOverlayWindow({
  screen,
  settings,
  applyZoom,
  perfFps,
  preloadPath,
  rendererUrl,
  rendererFile,
  dirname,
  appPath,
  resourcesPath,
  win32,   // { SetWindowLongPtrW, GetWindowLongPtrW, SetWindowPos }
  onReady, // optional callback(hwnd) once win32 styles applied
}) {
  const initSettings = settings.load();
  const setupMode = !initSettings?.general?.setupComplete;
  const iconPath = resolveIconPath({ appPath, resourcesPath, dirname });

  const win = new BrowserWindow(buildWindowOptions({ screen, setupMode, iconPath, preloadPath }));

  // CSP header — must be attached before first navigation.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP_HEADER] },
    });
  });

  // External links open in the OS browser, never in an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Setup mode: normal window. Overlay mode: click-through + always-on-top,
  // and mouse forwarding only enabled when overlay is actually shown.
  if (setupMode) {
    win.setAlwaysOnTop(false);
    win.setIgnoreMouseEvents(false);
  } else {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
  }

  if (rendererUrl) win.loadURL(rendererUrl);
  else win.loadFile(rendererFile);

  let overlayHwnd = null;
  win.once('ready-to-show', () => {
    win.webContents.setFrameRate(perfFps());

    try {
      const zoom = applyZoom(screen, win, {
        fontScale: initSettings?.general?.fontScale,
        setupMode,
        emitEvent: false, // initial load — no persisted positions to rescale
      });
      console.log(`[Main] UI zoom ${zoom.toFixed(3)}`);
    } catch (e) {
      console.log('[Main] setZoomFactor failed:', e.message);
    }

    wireClipboardShortcuts(win);

    if (!setupMode) {
      overlayHwnd = applyOverlayWin32Styles(win, win32);
      if (overlayHwnd) console.log('[Window] Overlay win32 styles applied, hwnd:', overlayHwnd);
    } else {
      // Setup window still needs an HWND for potential later use, but no flags.
      if (win32.GetWindowLongPtrW) {
        const hwndBuf = win.getNativeWindowHandle();
        overlayHwnd = process.arch === 'x64'
          ? Number(hwndBuf.readBigUInt64LE(0))
          : hwndBuf.readUInt32LE(0);
        console.log('[Window] Setup mode — no overlay win32 flags, hwnd:', overlayHwnd);
      }
    }

    // Restore saved opacity in overlay mode only — setup wants full opacity.
    const s = settings.load();
    if (s?.general?.opacity != null && !setupMode) {
      win.setOpacity(s.general.opacity / 100);
    }

    if (setupMode) {
      win.show();
      win.focus();
    }
    // Overlay mode stays hidden until CS2 is detected.

    if (onReady) onReady(overlayHwnd, { setupMode });
  });

  return { win, getOverlayHwnd: () => overlayHwnd, setupMode };
}

module.exports = { createOverlayWindow, resolveIconPath, resolveTrayIcon };
