// Computes and applies UI zoom so the overlay renders 1:1-ish on any monitor
// the virtual-screen window might span. Extracted from index.js where this
// same logic appeared in three places (initial ready-to-show, save-settings,
// and preview-font-scale). All three now call applyZoom().
//
// Zoom model:
//   baseZoom  = smallestMonitorHeight / 1440   (clamped 0.6 … 1.0)
//   fontMult  = user fontScale% / 100          (clamped 0.7 … 1.5)
//   zoom      = baseZoom × fontMult            (except in setupMode = 1.0)
// 1440 is the reference height the UI was designed at; scaling down below
// that keeps row heights readable on 1080p while caping at 1.0 avoids
// blowing the UI up past its design scale on 4K.

const MIN_PANEL_CSS_H = 360;

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function smallestDisplayHeight(screen) {
  const disps = screen.getAllDisplays();
  return Math.min(
    ...disps.map(d => d?.workAreaSize?.height || d?.bounds?.height || 1080)
  );
}

function computeZoom({ minPhysicalH, fontScalePct, setupMode }) {
  const baseZoom = clamp(minPhysicalH / 1440, 0.6, 1.0);
  const fs = Number(fontScalePct);
  const fontMult = Number.isFinite(fs) ? clamp(fs / 100, 0.7, 1.5) : 1;
  return setupMode ? 1.0 : baseZoom * fontMult;
}

// Apply zoom to the window and push CSS variables so the renderer can size
// its settings panel to fit the physically-smallest monitor. Also emits
// zoom-changed so the renderer can rescale persisted CSS-px positions.
//
//   screen         — electron.screen module
//   win            — BrowserWindow
//   opts.fontScale — percent from settings.general.fontScale
//   opts.setupMode — force zoom to 1.0 so setup text stays legible
//   opts.emitEvent — send 'zoom-changed' IPC (default: true)
// Returns the applied zoom factor.
function applyZoom(screen, win, { fontScale, setupMode = false, emitEvent = true } = {}) {
  if (!win) return 1.0;
  const minPhysicalH = smallestDisplayHeight(screen);
  const zoom = computeZoom({ minPhysicalH, fontScalePct: fontScale, setupMode });
  win.webContents.setZoomFactor(zoom);

  // 60px reserved for padding + drag margin. Panel won't exceed the smallest
  // connected monitor's usable height.
  const maxPanelCssH = Math.max(MIN_PANEL_CSS_H, Math.floor((minPhysicalH - 60) / zoom));
  const minDisplayCssH = Math.floor(minPhysicalH / zoom);
  const cssScript =
    `document.documentElement.style.setProperty('--settings-max-h', '${maxPanelCssH}px');` +
    `document.documentElement.style.setProperty('--min-display-h', '${minDisplayCssH}px');`;

  // Apply now in case renderer is already loaded, AND on did-finish-load in
  // case it isn't. Both are idempotent so running both is harmless.
  const run = () => { win.webContents.executeJavaScript(cssScript).catch(() => {}); };
  run();
  win.webContents.once('did-finish-load', run);

  if (emitEvent) win.webContents.send('zoom-changed', zoom);
  return zoom;
}

module.exports = { applyZoom, smallestDisplayHeight, computeZoom };
