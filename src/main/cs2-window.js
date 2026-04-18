// Win32 window helpers used by the CS2 detection loop + overlay positioning.
// Extracted from index.js so the module boundary is clearer:
//   findCS2()                 — poll whether CS2 has a window right now
//   computeVirtualScreen()    — union rect of all connected displays
//   applyVirtualScreenBounds  — resize the overlay window to that rect
//
// All functions degrade gracefully if koffi failed to load user32.dll:
// findCS2() returns 0 (treated as "not running" by the caller) and
// applyVirtualScreenBounds() is a no-op.

// Cache the koffi function handles — loading user32 on every poll would be
// wasteful. Loaded lazily so the require() in index.js doesn't fail early
// on non-Windows platforms during development.
let _findWindowA = null;
let _getWindowRect = null;
let _koffiTried = false;

function loadUser32(koffi) {
  if (_koffiTried) return;
  _koffiTried = true;
  if (!koffi) return;
  try {
    const user32 = koffi.load('user32.dll');
    _findWindowA = user32.func('intptr FindWindowA(const char*, const char*)');
    // GetWindowRect(HWND, _Out_ RECT*) — RECT is 4 int32 = 16 bytes.
    _getWindowRect = user32.func('bool GetWindowRect(intptr, _Out_ uint8_t[16])');
  } catch {
    // user32 unavailable — stays null, callers return inert values.
  }
}

// Returns HWND (intptr) of the CS2 window, or 0 if not running/found.
// CS2's window class is SDL_app with exact title "Counter-Strike 2".
function findCS2() {
  if (!_findWindowA) return 0;
  try { return _findWindowA('SDL_app', 'Counter-Strike 2') || 0; }
  catch { return 0; }
}

// Read CS2's window rect. Not currently consumed by index.js — kept for the
// eventual "move overlay to CS2's monitor only" mode. Returns null if koffi
// didn't load or the call failed.
function getCS2Bounds(hwnd) {
  if (!_getWindowRect || !hwnd) return null;
  try {
    const rect = Buffer.alloc(16);
    if (_getWindowRect(hwnd, rect)) {
      const left = rect.readInt32LE(0);
      const top = rect.readInt32LE(4);
      const right = rect.readInt32LE(8);
      const bottom = rect.readInt32LE(12);
      if (right > left && bottom > top) {
        return { x: left, y: top, width: right - left, height: bottom - top };
      }
    }
  } catch (e) {
    console.log('[cs2-window] getCS2Bounds failed:', e.message);
  }
  return null;
}

// Union rectangle of every connected display. The overlay covers this so the
// scoreboard can be dragged between monitors; click-through keeps the rest
// of the desktop fully usable.
function computeVirtualScreen(screen) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Size `win` to cover every display. Idempotent — skips the setBounds call
// when the window is already aligned, so calling this every CS2-detect poll
// is cheap. Returns true if it moved the window.
function applyVirtualScreenBounds(screen, win) {
  if (!win) return false;
  const v = computeVirtualScreen(screen);
  if (!v) return false;
  const cur = win.getBounds();
  if (cur.x === v.x && cur.y === v.y && cur.width === v.width && cur.height === v.height) {
    return false;
  }
  win.setBounds(v);
  console.log(`[cs2-window] Overlay spans virtual screen: ${v.width}x${v.height} @ ${v.x},${v.y}`);
  return true;
}

module.exports = { loadUser32, findCS2, getCS2Bounds, computeVirtualScreen, applyVirtualScreenBounds };
