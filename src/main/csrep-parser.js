// csrep.gg page scraping. Extracted from csstats-scraper.js where the same
// ~90 lines of parsing appeared in both scrapePlayer (full scrape) and
// topUpEntry (add csrep to a cached entry).
//
// Two exports:
//   scrapeCsrepPage(page, steamId64) — navigate + wait + evaluate + return
//   parseDomInBrowser                 — the function passed to page.evaluate.
//
// parseDomInBrowser MUST be self-contained: page.evaluate serialises it via
// Function.prototype.toString and executes it inside the browser context, so
// it cannot reference any variable outside its own body.

function parseDomInBrowser() {
  const text = document.body.innerText || '';

  // Finds a "NN%" near a label within a character window. Used for trust,
  // anomalies, and SBA — these render as pill badges whose exact DOM shape
  // we don't want to depend on.
  const pctNear = (label, window = 180) => {
    const i = text.indexOf(label);
    if (i < 0) return null;
    const slice = text.slice(Math.max(0, i - window), i + window);
    const m = slice.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  };

  // Trust rating is primarily inside an SVG ring as "{N}%Trust Rating".
  // Fallback to pctNear for layout changes where the SVG text shifts.
  let trust = null;
  for (const t of document.querySelectorAll('svg text')) {
    const m = (t.textContent || '').match(/(\d{1,3})\s*%\s*Trust\s*Rating/i);
    if (m) { trust = parseInt(m[1]); break; }
  }
  if (trust == null) trust = pctNear('Trust Rating');

  const lines = text.split('\n').map(s => s.trim());
  const parseNum = (s) => {
    if (!s) return null;
    const m = String(s).match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const parsePct = (s) => {
    if (!s) return null;
    const m = String(s).match(/(-?\d+(?:\.\d+)?)\s*%/);
    return m ? parseFloat(m[1]) : null;
  };

  // Each metric card renders as "{value}{unit}" then "{label}" on the next
  // line. Walk for a known label, take its previous line as the raw value.
  const findBefore = (label) => {
    for (let i = 1; i < lines.length; i++) if (lines[i] === label) return lines[i - 1];
    return null;
  };
  const metrics = {
    ttdMs:         parseNum(findBefore('Time to Damage')),
    reactionMs:    parseNum(findBefore('Reaction Time')),
    crosshairDeg:  parseNum(findBefore('Crosshair Placement')),
    preaimDeg:     parseNum(findBefore('Preaim')),
    kd:            parseNum(findBefore('K/D Ratio')),
    adr:           parseNum(findBefore('ADR')),
    aimAcc:        parsePct(findBefore('Aim Accuracy')),
    headAcc:       parsePct(findBefore('Head Accuracy')),
    wallbang:      parsePct(findBefore('Wallbang Kill %')),
    smoke:         parsePct(findBefore('Smoke Kill %')),
    hltvRating:    parseNum(findBefore('HLTV Rating 2.0')),
    kast:          parsePct(findBefore('KAST')),
  };

  // Account Reputation block — csrep's DOM order doesn't match reading order.
  // Verified via a live probe, lines look like:
  //   +2.8%          ← delta for ACCOUNT AGE
  //   ACCOUNT AGE    ← label (first)
  //   +2.4%          ← delta for CS2 HOURS (appears here, not after its label)
  //   9y 0m          ← value for ACCOUNT AGE (2 lines after its label)
  //   CS2 HOURS      ← label
  //   +0.0%          ← delta for INVENTORY VALUE
  //   0h             ← value for CS2 HOURS
  //   …
  // Rule: value_i = lines[pos_i + 2]. Delta for the first label is at pos-1;
  // for every later label it's at pos-2. An earlier parser used lines[pos-1]
  // as value, which pulled deltas into value slots (user-visible bug:
  // age showed "+2.8%" where "9y 0m" belonged).
  const ACCT_LABELS = [
    ['age',          'ACCOUNT AGE'],
    ['hours',        'CS2 HOURS'],
    ['inventory',    'INVENTORY VALUE'],
    ['level',        'STEAM LEVEL'],
    ['collectibles', 'COLLECTIBLES'],
  ];
  const account = {};
  const positions = ACCT_LABELS.map(([, lbl]) => lines.indexOf(lbl));
  for (let i = 0; i < ACCT_LABELS.length; i++) {
    const [key] = ACCT_LABELS[i];
    const pos = positions[i];
    if (pos < 0) { account[key] = { value: null, delta: null }; continue; }
    const value = lines[pos + 2] ?? null;
    // Guard: on private profiles some value slots collapse and pos+2 lands
    // on another known label — reject to avoid showing "CS2 HOURS" as an age.
    const valueClean = (value && ACCT_LABELS.some(([, l]) => l === value)) ? null : value;
    const deltaLine = (i === 0) ? lines[pos - 1] : lines[pos - 2];
    account[key] = { value: valueClean, delta: parsePct(deltaLine) };
  }

  return {
    trust,
    anomalies: pctNear('Anomalies Detected'),
    sba: pctNear('Stats Based Analysis'),
    metrics,
    account,
  };
}

// Navigate the provided page to csrep.gg for the given SteamID, wait for the
// SPA to hydrate through Cloudflare's challenge, then extract fields.
// Returns an object with nulls on navigation/render failure so callers can
// degrade gracefully.
//
// csrep.gg sits behind an aggressive Cloudflare managed-challenge that
// stalls the request on a "Just a moment..." interstitial for several
// seconds. puppeteer-real-browser's turnstile:true solves it but the
// solve can take 10-20s under load. Our wait here must tolerate that,
// otherwise we end up parsing the challenge page and returning all nulls
// for every player (user-visible as "cswatch not detecting anyone").
async function scrapeCsrepPage(page, steamId64) {
  await page.goto(`https://csrep.gg/player/${steamId64}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Two-phase wait:
  //   1. Cloudflare challenge clears ("Just a moment..." title/text gone)
  //   2. csrep SPA hydrates (Trust Rating / Player Reputation rendered)
  // Generous single timeout covering both — if either stalls, we still
  // fall through to evaluate and log a diagnostic.
  const ready = await page.waitForFunction(() => {
    const title = document.title || '';
    const txt = document.body?.innerText || '';
    // Still on CF challenge
    if (/Just a moment/i.test(title) || /Enable JavaScript and cookies/i.test(txt)) return false;
    // Real page hydrated
    return /Trust Rating/i.test(txt) || /Player Reputation/i.test(txt);
  }, { timeout: 25000 }).then(() => true).catch(() => false);

  if (!ready) {
    // Diagnostic: log what we ended up with so we can tell if the problem
    // is a stuck challenge, a DOM change, or a 404 profile.
    try {
      const diag = await page.evaluate(() => ({
        title: document.title,
        snippet: (document.body?.innerText || '').slice(0, 200).replace(/\s+/g, ' '),
      }));
      console.log(`[CSRep] wait timeout for ${steamId64} — title="${diag.title}" snippet="${diag.snippet}"`);
    } catch {}
  }

  return page.evaluate(parseDomInBrowser);
}

module.exports = { scrapeCsrepPage, parseDomInBrowser };
