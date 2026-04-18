// One-time Steam login flow for csstats.gg.
//
// csstats.gg only shows full lifetime stats (K/D, HLTV rating, clutches,
// entries) to logged-in viewers. Without a session cookie the scraper
// still gets ranks + map wins but everything under "HLTV RATING" is
// gated. This flow pops a visible Chrome window, lets the user click
// "Sign in with Steam", then validates the resulting session by scraping
// a known test profile and checking that the gated fields show up.
//
// The caller gets back { success, verified, reason? }:
//   verified: true  — cookies work, scrape will return full stats.
//   verified: false — cookies missing/wrong; explain with `reason`.

const {
  ensureBrowser, shutdownBrowser, forceWindowOnScreen, USER_DATA_DIR,
} = require('./csstats-browser');

// Timeouts tuned for a human in the middle of a login flow: up to 5 min
// to actually click through Steam, 3 s dwell after load so the server
// cookie roundtrip finishes, 30 s page-load cap.
const LOGIN_WAIT_MS = 300000;
const LOGIN_POLL_MS = 2000;
const PAGE_LOAD_TIMEOUT_MS = 30000;
const POST_NAV_SETTLE_MS = 1000;
const VALIDATE_DWELL_MS = 3000;

// A known Steam profile with public csstats. Chosen because it's a long-
// standing community account unlikely to be renamed/privated.
const VALIDATION_PROFILE = 'https://csstats.gg/player/76561198034202275';

async function loginToCsstats(onPhase) {
  const emit = (phase, extra) => { try { onPhase && onPhase(phase, extra); } catch {} };
  console.log('[CSScrape] Opening browser for Steam login at:', USER_DATA_DIR);

  // Nuke any existing background-scraper browser — it's offscreen and can't
  // be used for interactive login.
  await shutdownBrowser();

  try {
    const b = await ensureBrowser(true);
    const page = (await b.pages())[0] || await b.newPage();
    await forceWindowOnScreen(page);
    await page.goto('https://csstats.gg', { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT_MS });
    await forceWindowOnScreen(page);
    emit('browser-open');
    console.log('[CSScrape] Please log in via Steam in the browser window.');

    // Race two signals:
    //   1. Login detected  — the page text contains a logged-in marker.
    //   2. Browser closed  — user bailed out.
    let browserClosed = false;
    const disconnectPromise = new Promise(resolve => {
      b.on('disconnected', () => { browserClosed = true; resolve('disconnected'); });
    });
    const loginPromise = page.waitForFunction(() => {
      const t = document.body.innerText;
      return t.includes('Sign out') || t.includes('Logout') || t.includes('My Profile');
    }, { timeout: LOGIN_WAIT_MS, polling: LOGIN_POLL_MS })
      .then(() => 'login')
      .catch(() => 'timeout');

    const result = await Promise.race([loginPromise, disconnectPromise]);
    console.log('[CSScrape] Login loop ended:', result);

    if (!browserClosed) { await shutdownBrowser(); }
    else { await shutdownBrowser(); } // ensures module state is cleared

    // Validate by scraping a known public profile and checking that
    // logged-in-only fields are present.
    emit('validating');
    console.log('[CSScrape] Validating login by fetching test stats...');
    await new Promise(r => setTimeout(r, POST_NAV_SETTLE_MS));

    try {
      const b2 = await ensureBrowser(false);
      const testPage = await b2.newPage();
      try {
        await testPage.goto(VALIDATION_PROFILE, { waitUntil: 'networkidle2', timeout: PAGE_LOAD_TIMEOUT_MS });
        await new Promise(r => setTimeout(r, VALIDATE_DWELL_MS));
        const verified = await testPage.evaluate(() => {
          const txt = document.body.innerText;
          // K/D near HLTV RATING only renders when the server thinks we're
          // logged in. The "Please login" banner is the negative signal.
          return txt.includes('K/D') && txt.includes('HLTV RATING') && !txt.includes('Please login');
        });
        await shutdownBrowser();
        if (verified) {
          console.log('[CSScrape] Validation passed — logged in successfully');
          return { success: true, verified: true };
        }
        console.log('[CSScrape] Validation failed — not logged in');
        return { success: false, verified: false, reason: 'Not signed in' };
      } finally {
        try { await testPage.close(); } catch {}
      }
    } catch (err) {
      console.log('[CSScrape] Validation error:', err.message);
      await shutdownBrowser();
      return { success: false, verified: false, reason: err.message };
    }
  } catch (err) {
    console.log('[CSScrape] Login error:', err.message);
    await shutdownBrowser();
    return { success: false, verified: false, reason: err.message };
  }
}

module.exports = { loginToCsstats };
