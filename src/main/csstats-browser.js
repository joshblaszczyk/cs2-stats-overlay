// Puppeteer-real-browser lifecycle for the csstats scraper.
//
// We use puppeteer-real-browser instead of vanilla puppeteer because
// csstats.gg is behind Cloudflare Turnstile, which detects headless
// Chromium by default. puppeteer-real-browser launches a real Chrome
// profile and solves the challenge automatically — at the cost of needing
// a visible (or offscreen) window that can't be truly headless.
//
// The browser handle is module-private so every caller shares one
// instance. ensureBrowser() is the only way to get it; it auto-relaunches
// if a previous Chrome crashed or the user killed the window.

const path = require('path');
const fs = require('fs');
const { connect } = require('puppeteer-real-browser');

// Position the hidden browser far off-screen so it doesn't flash onto the
// desktop when Chrome boots. A real negative coordinate — some Chrome
// builds clamp 0,0 back onto the primary display.
const OFFSCREEN_WINDOW_ARGS = [
  '--window-size=1280,900',
  '--window-position=-2400,-2400',
  '--no-focus-on-navigate',
];

// Throttling flag. Background timer throttling would stall navigation when
// Chrome loses focus (i.e., always, since we keep it hidden).
const BASE_ARGS = ['--disable-background-timer-throttling'];

let browser = null;
let currentPage = null;

function getUserDataDir() {
  // In the forked scrape-worker process ELECTRON_RUN_AS_NODE is set, so
  // require('electron') doesn't return the Electron app API. Main passes
  // userData through USER_DATA_DIR so the worker writes to the same
  // browser-data dir as before the split (keeps cf_clearance cookies etc).
  if (process.env.USER_DATA_DIR) {
    return path.join(process.env.USER_DATA_DIR, 'browser-data');
  }
  try {
    const { app } = require('electron');
    if (app && app.getPath) {
      return path.join(app.getPath('userData'), 'browser-data');
    }
  } catch {}
  return path.join(__dirname, '../../.browser-data');
}

const USER_DATA_DIR = getUserDataDir();

// Compute a centered window geometry that fits inside the primary display
// with a comfortable margin. Used for the visible login flow so the Steam
// sign-in page lands somewhere sane regardless of monitor size.
function computeVisibleGeometry(screen) {
  const display = screen.getPrimaryDisplay();
  const sw = display.workAreaSize.width;
  const sh = display.workAreaSize.height;
  const width  = Math.min(1100, sw - 80);
  const height = Math.min(780,  sh - 80);
  const left = Math.max(0, Math.round((sw - width) / 2));
  const top  = Math.max(0, Math.round((sh - height) / 2));
  return { left, top, width, height };
}

// Force the Chrome window onto screen via DevTools Protocol. Needed because
// some environments (multi-monitor, changing DPI) can spawn the login
// window in a spot that's off the visible desktop.
async function forceWindowOnScreen(page) {
  try {
    const { screen } = require('electron');
    const { left, top, width, height } = computeVisibleGeometry(screen);
    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left, top, width, height, windowState: 'normal' },
    });
    try { await cdp.detach(); } catch {}
  } catch (e) {
    console.log('[CSScrape] forceWindowOnScreen failed:', e.message);
  }
}

// Build the Chrome --window-* args. Offscreen for normal scraping, centered
// for the one-time login flow.
function buildChromeArgs(visibleForLogin) {
  if (!visibleForLogin) {
    return [...BASE_ARGS, ...OFFSCREEN_WINDOW_ARGS];
  }
  try {
    const { screen } = require('electron');
    const { left, top, width, height } = computeVisibleGeometry(screen);
    return [
      ...BASE_ARGS,
      `--window-size=${width},${height}`,
      `--window-position=${left},${top}`,
    ];
  } catch {
    return [...BASE_ARGS, '--window-size=1100,780', '--window-position=100,80'];
  }
}

// Launch (or reuse) the shared browser. visibleForLogin forces a centered
// window; any existing browser is not re-launched, so callers should
// close the login-time browser before re-calling with visibleForLogin=false.
async function ensureBrowser(visibleForLogin = false) {
  if (browser && browser.connected) return browser;

  try {
    if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  } catch (e) {
    console.log('[CSScrape] Failed to create user data dir:', e.message);
  }

  const resp = await connect({
    // Must be visible to pass Cloudflare — headless true is detected.
    headless: false,
    turnstile: true,
    customConfig: { userDataDir: USER_DATA_DIR },
    connectOption: { defaultViewport: null },
    args: buildChromeArgs(visibleForLogin),
  });

  browser = resp.browser;
  currentPage = resp.page;
  try {
    browser.on('disconnected', () => {
      browser = null;
      currentPage = null;
    });
  } catch {}
  return browser;
}

// Pop the initial page returned by connect() so the first scrape can reuse
// it instead of opening an extra tab. Null after it's been taken.
function takeInitialPage() {
  const p = currentPage;
  currentPage = null;
  return p;
}

async function shutdownBrowser() {
  if (!browser) return;
  try { await browser.close(); } catch {}
  browser = null;
  currentPage = null;
}

function isConnected() {
  return !!(browser && browser.connected);
}

module.exports = {
  USER_DATA_DIR,
  ensureBrowser,
  shutdownBrowser,
  forceWindowOnScreen,
  takeInitialPage,
  isConnected,
};
